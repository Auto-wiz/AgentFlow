import {
  createDb,
  agencies,
  appointments,
  contacts,
  ghlOAuthInstallations,
  invoices,
  locations,
  messages,
  threads,
  webhookEvents
} from "@agentflow/db";
import type {
  ContactOnDemandDetails,
  MessageChannel,
  MessageDirection,
  NormalizedGhlAppointmentWebhookEvent,
  NormalizedGhlInstallWebhookEvent,
  NormalizedGhlInvoiceWebhookEvent,
  NormalizedGhlMessageWebhookEvent,
  NormalizedGhlWebhookEvent
} from "@agentflow/shared";
import { and, desc, eq, or } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = {
  DATABASE_URL: string;
  GHL_WEBHOOK_SECRET?: string;
  GHL_API_TOKEN?: string;
  GHL_API_BASE_URL?: string;
  GHL_CLIENT_ID?: string;
  GHL_CLIENT_SECRET?: string;
  GHL_APP_ID?: string;
  GHL_INSTALL_URL?: string;
  GHL_OAUTH_REDIRECT_URI?: string;
  GHL_OAUTH_USER_TYPE?: string;
  FRONTEND_BASE_URL?: string;
  MESSAGE_QUEUE: Queue<NormalizedGhlWebhookEvent>;
};

type HonoBindings = {
  Bindings: Env;
};

type GhlOAuthTokenResponse = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string | null;
  refreshTokenId: string | null;
  userType: "Company" | "Location";
  companyId: string;
  locationId: string | null;
  userId: string | null;
  raw: unknown;
};

const app = new Hono<HonoBindings>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"]
  })
);

app.get("/health", (c) => c.json({ ok: true }));

app.get("/webhooks/gohighlevel", (c) =>
  c.json({
    provider: "gohighlevel",
    defaultWebhookUrl: `${new URL(c.req.url).origin}/webhooks/gohighlevel`,
    method: "POST",
    events: [
      "INSTALL",
      "InboundMessage",
      "OutboundMessage",
      "AppointmentCreate",
      "AppointmentUpdate",
      "AppointmentDelete",
      "InvoiceCreate",
      "InvoiceUpdate",
      "InvoiceSent",
      "InvoicePaid",
      "InvoicePartiallyPaid",
      "InvoiceVoid",
      "InvoiceDelete"
    ],
    callsExcluded: true
  })
);

app.get("/oauth/gohighlevel/start", (c) => {
  if (!c.env.GHL_INSTALL_URL) {
    return c.json({ error: "GHL_INSTALL_URL is not configured" }, 500);
  }

  const state = crypto.randomUUID();
  const installUrl = new URL(c.env.GHL_INSTALL_URL);
  const versionId =
    getNonEmptyQueryParam(installUrl, "versionId") ?? getNonEmptyQueryParam(installUrl, "version_id");

  const clientId =
    getNonEmptyQueryParam(installUrl, "client_id") ??
    getNonEmptyQueryParam(installUrl, "appId") ??
    c.env.GHL_CLIENT_ID?.trim() ??
    null;
  const appId =
    getNonEmptyQueryParam(installUrl, "appId") ?? c.env.GHL_APP_ID?.trim() ?? versionId ?? clientId;
  if (!appId) {
    return c.json(
      { error: "Missing GoHighLevel app identifier", hint: "Set appId/version_id in GHL_INSTALL_URL" },
      500
    );
  }

  // Keep install URLs valid even if dashboard vars omit one of these keys.
  if (clientId) {
    installUrl.searchParams.set("client_id", clientId);
  }
  installUrl.searchParams.set("appId", appId);
  installUrl.searchParams.set("response_type", "code");

  if (versionId) {
    installUrl.searchParams.set("versionId", versionId);
    installUrl.searchParams.set("version_id", versionId);
  }

  if (!getNonEmptyQueryParam(installUrl, "user_type") && c.env.GHL_OAUTH_USER_TYPE?.trim()) {
    installUrl.searchParams.set("user_type", c.env.GHL_OAUTH_USER_TYPE.trim());
  }

  installUrl.searchParams.set("state", state);

  if (c.env.GHL_OAUTH_REDIRECT_URI) {
    installUrl.searchParams.set("redirect_uri", c.env.GHL_OAUTH_REDIRECT_URI);
  }

  setCookie(c, {
    name: "ghl_oauth_state",
    value: state,
    maxAge: 600
  });
  return c.redirect(installUrl.toString());
});

app.get("/oauth/gohighlevel/callback", async (c) => {
  const code = c.req.query("code");
  const error = c.req.query("error");
  const state = c.req.query("state");
  const storedState = getCookie(c.req.raw.headers, "ghl_oauth_state");

  if (error) {
    return redirectToFrontend(c, `/settings/integrations?ghl=error&reason=${encodeURIComponent(error)}`);
  }

  if (!code) {
    return c.json({ error: "Missing OAuth code" }, 400);
  }

  if (state && storedState && state !== storedState) {
    return c.json({ error: "Invalid OAuth state" }, 400);
  }

  const missing = ["GHL_CLIENT_ID", "GHL_CLIENT_SECRET", "GHL_OAUTH_REDIRECT_URI"].filter(
    (key) => !c.env[key as keyof Env]
  );
  if (missing.length > 0) {
    return c.json({ error: "Missing OAuth configuration", missing }, 500);
  }

  const tokenResponse = await exchangeGhlOAuthCode(c.env, code);
  const db = createDb(c.env.DATABASE_URL);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + tokenResponse.expiresIn * 1000);

  await db
    .insert(ghlOAuthInstallations)
    .values({
      companyId: tokenResponse.companyId,
      locationId: tokenResponse.locationId ?? "",
      userId: tokenResponse.userId ?? null,
      userType: tokenResponse.userType,
      accessToken: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      tokenType: tokenResponse.tokenType,
      scope: tokenResponse.scope ?? null,
      refreshTokenId: tokenResponse.refreshTokenId ?? null,
      expiresAt,
      raw: tokenResponse.raw,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        ghlOAuthInstallations.companyId,
        ghlOAuthInstallations.locationId,
        ghlOAuthInstallations.userType
      ],
      set: {
        userId: tokenResponse.userId ?? null,
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        tokenType: tokenResponse.tokenType,
        scope: tokenResponse.scope ?? null,
        refreshTokenId: tokenResponse.refreshTokenId ?? null,
        expiresAt,
        raw: tokenResponse.raw,
        updatedAt: now
      }
    });

  return redirectToFrontend(c, "/settings/integrations?ghl=connected");
});

app.post("/webhooks/gohighlevel", async (c) => {
  const rawBody = await c.req.text();
  const verified = await verifyWebhookSignature(
    rawBody,
    c.req.raw.headers,
    c.env.GHL_WEBHOOK_SECRET
  );

  if (!verified) {
    return c.json({ accepted: true, verified: false, ignored: true }, 202);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return c.json({ accepted: true, ignored: true, reason: "invalid_json" }, 202);
  }

  const normalized = await normalizeGhlWebhook(payload, c.req.raw.headers, rawBody);
  if (!normalized) {
    return c.json({ accepted: true, ignored: true, reason: "unsupported_event" }, 202);
  }

  try {
    const db = createDb(c.env.DATABASE_URL);
    const inserted = await db
      .insert(webhookEvents)
      .values({
        idempotencyKey: normalized.idempotencyKey,
        eventType: normalized.eventType,
        payload: normalized
      })
      .onConflictDoNothing({
        target: webhookEvents.idempotencyKey
      })
      .returning({ id: webhookEvents.id });

    if (inserted.length === 0) {
      return c.json({ accepted: true, duplicate: true }, 200);
    }

    await c.env.MESSAGE_QUEUE.send(normalized);
    return c.json({ accepted: true, queued: true }, 202);
  } catch (error) {
    console.error("Failed to persist GoHighLevel webhook", error);
    return c.json({ accepted: true, queued: false }, 202);
  }
});

app.get("/threads", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const pendingReply = c.req.query("pendingReply");
  const locationId = c.req.query("locationId");
  const filters = [];

  if (pendingReply === "true") {
    filters.push(eq(threads.pendingReply, true));
  }

  if (locationId) {
    filters.push(or(eq(threads.locationId, locationId), eq(locations.ghlLocationId, locationId)));
  }

  let query = db
    .select({
      threadId: threads.id,
      locationId: threads.locationId,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name,
      contactId: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      pendingReply: threads.pendingReply,
      unreadCount: threads.unreadCount,
      lastMessageAt: threads.lastMessageAt
    })
    .from(threads)
    .innerJoin(locations, eq(threads.locationId, locations.id))
    .innerJoin(contacts, eq(threads.contactId, contacts.id))
    .$dynamic();

  if (filters.length > 0) {
    query = query.where(and(...filters));
  }

  const rows = await query.orderBy(desc(threads.lastMessageAt)).limit(100);
  return c.json({
    threads: rows.map((row) => ({
      id: row.threadId,
      locationId: row.locationId,
      ghlLocationId: row.ghlLocationId,
      locationName: row.locationName,
      contactId: row.contactId,
      contactName: formatContactName(row.firstName, row.lastName, row.email, row.phone),
      contactEmail: row.email,
      contactPhone: row.phone,
      pendingReply: row.pendingReply,
      unreadCount: row.unreadCount,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null
    }))
  });
});

app.get("/threads/:id/messages", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const threadId = c.req.param("id");
  const [threadRow] = await db
    .select({
      threadId: threads.id,
      locationId: threads.locationId,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name,
      contactId: contacts.id,
      ghlContactId: contacts.ghlContactId,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      pendingReply: threads.pendingReply,
      unreadCount: threads.unreadCount,
      lastMessageAt: threads.lastMessageAt
    })
    .from(threads)
    .innerJoin(locations, eq(threads.locationId, locations.id))
    .innerJoin(contacts, eq(threads.contactId, contacts.id))
    .where(eq(threads.id, threadId))
    .limit(1);

  if (!threadRow) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const messageRows = await db
    .select({
      id: messages.id,
      ghlMessageId: messages.ghlMessageId,
      channel: messages.channel,
      direction: messages.direction,
      subject: messages.subject,
      body: messages.body,
      from: messages.from,
      to: messages.to,
      sentAt: messages.sentAt
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.sentAt);

  const contactDetails = await fetchContactDetailsOnDemand(c.env, threadRow.ghlContactId);

  return c.json({
    thread: {
      id: threadRow.threadId,
      locationId: threadRow.locationId,
      ghlLocationId: threadRow.ghlLocationId,
      locationName: threadRow.locationName,
      contactId: threadRow.contactId,
      contactName: formatContactName(
        threadRow.firstName,
        threadRow.lastName,
        threadRow.email,
        threadRow.phone
      ),
      contactEmail: threadRow.email,
      contactPhone: threadRow.phone,
      pendingReply: threadRow.pendingReply,
      unreadCount: threadRow.unreadCount,
      lastMessageAt: threadRow.lastMessageAt?.toISOString() ?? null
    },
    messages: messageRows.map((message) => ({
      id: message.id,
      ghlMessageId: message.ghlMessageId,
      channel: message.channel,
      direction: message.direction,
      subject: message.subject,
      body: message.body,
      from: message.from,
      to: message.to,
      sentAt: message.sentAt.toISOString()
    })),
    contactDetails
  });
});

app.post("/threads/:id/read", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const threadId = c.req.param("id");
  const updated = await db
    .update(threads)
    .set({ pendingReply: false, unreadCount: 0, updatedAt: new Date() })
    .where(eq(threads.id, threadId))
    .returning({ id: threads.id });

  if (updated.length === 0) {
    return c.json({ error: "Thread not found" }, 404);
  }

  return c.json({ ok: true });
});

async function exchangeGhlOAuthCode(
  env: Env,
  code: string
): Promise<GhlOAuthTokenResponse> {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: env.GHL_CLIENT_ID,
      client_secret: env.GHL_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      user_type: env.GHL_OAUTH_USER_TYPE ?? "Company",
      redirect_uri: env.GHL_OAUTH_REDIRECT_URI
    })
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = asRecord(raw);
    throw new Error(
      `GoHighLevel token exchange failed: ${stringValue(error.message ?? response.status)}`
    );
  }

  const token = asRecord(raw);
  const userType = stringValue(token.userType);
  const companyId = stringValue(token.companyId);

  if (
    !stringValue(token.access_token) ||
    !stringValue(token.refresh_token) ||
    !companyId ||
    (userType !== "Company" && userType !== "Location")
  ) {
    throw new Error("GoHighLevel token response is missing required fields");
  }

  return {
    accessToken: stringValue(token.access_token),
    refreshToken: stringValue(token.refresh_token),
    tokenType: stringValue(token.token_type) || "Bearer",
    expiresIn: Number(token.expires_in ?? 86400),
    scope: stringOrNull(token.scope),
    refreshTokenId: stringOrNull(token.refreshTokenId),
    userType,
    companyId,
    locationId: stringOrNull(token.locationId),
    userId: stringOrNull(token.userId),
    raw
  };
}

function redirectToFrontend(c: Context<HonoBindings>, path: string) {
  const baseUrl = c.env.FRONTEND_BASE_URL ?? new URL(c.req.url).origin;
  return c.redirect(new URL(path, baseUrl).toString());
}

function setCookie(
  c: Context<HonoBindings>,
  cookie: { name: string; value: string; maxAge: number }
) {
  c.header(
    "Set-Cookie",
    `${cookie.name}=${cookie.value}; Max-Age=${cookie.maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`
  );
}

function getCookie(headers: Headers, name: string): string | null {
  const cookieHeader = headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const [cookieName, ...cookieValue] = cookie.trim().split("=");
    if (cookieName === name) {
      return cookieValue.join("=");
    }
  }
  return null;
}

function getNonEmptyQueryParam(url: URL, name: string): string | null {
  const value = url.searchParams.get(name);
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function processWebhookEvent(env: Env, event: NormalizedGhlWebhookEvent) {
  if (event.kind === "message") {
    await processMessageWebhookEvent(env, event);
    return;
  }

  if (event.kind === "appointment") {
    await processAppointmentWebhookEvent(env, event);
    return;
  }

  if (event.kind === "invoice") {
    await processInvoiceWebhookEvent(env, event);
    return;
  }

  await processInstallWebhookEvent(env, event);
}

async function processMessageWebhookEvent(env: Env, event: NormalizedGhlMessageWebhookEvent) {
  const db = createDb(env.DATABASE_URL);
  const now = new Date();
  const sentAt = new Date(event.message.sentAt);

  const [agency] = await db
    .insert(agencies)
    .values({
      ghlAgencyId: event.agency.ghlAgencyId,
      name: event.agency.name ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: agencies.ghlAgencyId,
      set: {
        name: event.agency.name ?? null,
        updatedAt: now
      }
    })
    .returning({ id: agencies.id });

  if (!agency) {
    throw new Error("Failed to upsert agency");
  }

  const [location] = await db
    .insert(locations)
    .values({
      agencyId: agency.id,
      ghlLocationId: event.location.ghlLocationId,
      name: event.location.name ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: locations.ghlLocationId,
      set: {
        agencyId: agency.id,
        name: event.location.name ?? null,
        updatedAt: now
      }
    })
    .returning({ id: locations.id });

  if (!location) {
    throw new Error("Failed to upsert location");
  }

  const [contact] = await db
    .insert(contacts)
    .values({
      locationId: location.id,
      ghlContactId: event.contact.ghlContactId,
      firstName: event.contact.firstName ?? null,
      lastName: event.contact.lastName ?? null,
      email: event.contact.email ?? null,
      phone: event.contact.phone ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [contacts.locationId, contacts.ghlContactId],
      set: {
        firstName: event.contact.firstName ?? null,
        lastName: event.contact.lastName ?? null,
        email: event.contact.email ?? null,
        phone: event.contact.phone ?? null,
        updatedAt: now
      }
    })
    .returning({ id: contacts.id });

  if (!contact) {
    throw new Error("Failed to upsert contact");
  }

  const [thread] = await db
    .insert(threads)
    .values({
      locationId: location.id,
      contactId: contact.id,
      pendingReply: event.message.direction === "inbound",
      unreadCount: event.message.direction === "inbound" ? 1 : 0,
      lastMessageAt: sentAt,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [threads.locationId, threads.contactId],
      set: {
        pendingReply: event.message.direction === "inbound",
        unreadCount: event.message.direction === "inbound" ? 1 : 0,
        lastMessageAt: sentAt,
        updatedAt: now
      }
    })
    .returning({ id: threads.id });

  if (!thread) {
    throw new Error("Failed to upsert thread");
  }

  const insertedMessages = await db
    .insert(messages)
    .values({
      threadId: thread.id,
      locationId: location.id,
      contactId: contact.id,
      ghlMessageId: event.message.ghlMessageId,
      channel: event.message.channel,
      direction: event.message.direction,
      subject: event.message.subject ?? null,
      body: event.message.body ?? null,
      from: event.message.from ?? null,
      to: event.message.to ?? null,
      sentAt,
      raw: event.raw
    })
    .onConflictDoNothing({
      target: [messages.threadId, messages.ghlMessageId]
    })
    .returning({ id: messages.id });

  if (insertedMessages.length === 0) {
    return;
  }

  await db
    .update(webhookEvents)
    .set({ status: "processed", processedAt: now, error: null })
    .where(eq(webhookEvents.idempotencyKey, event.idempotencyKey));
}

async function processAppointmentWebhookEvent(
  env: Env,
  event: NormalizedGhlAppointmentWebhookEvent
) {
  const db = createDb(env.DATABASE_URL);
  const now = new Date();

  const [agency] = await db
    .insert(agencies)
    .values({
      ghlAgencyId: event.agency.ghlAgencyId,
      name: event.agency.name ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: agencies.ghlAgencyId,
      set: {
        name: event.agency.name ?? null,
        updatedAt: now
      }
    })
    .returning({ id: agencies.id });

  if (!agency) {
    throw new Error("Failed to upsert agency");
  }

  const [location] = await db
    .insert(locations)
    .values({
      agencyId: agency.id,
      ghlLocationId: event.location.ghlLocationId,
      name: event.location.name ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: locations.ghlLocationId,
      set: {
        agencyId: agency.id,
        name: event.location.name ?? null,
        updatedAt: now
      }
    })
    .returning({ id: locations.id });

  if (!location) {
    throw new Error("Failed to upsert location");
  }

  let contactId: string | null = null;
  if (event.contact.ghlContactId) {
    const [contact] = await db
      .insert(contacts)
      .values({
        locationId: location.id,
        ghlContactId: event.contact.ghlContactId,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [contacts.locationId, contacts.ghlContactId],
        set: { updatedAt: now }
      })
      .returning({ id: contacts.id });
    contactId = contact?.id ?? null;
  }

  await db
    .insert(appointments)
    .values({
      locationId: location.id,
      contactId,
      ghlAppointmentId: event.appointment.ghlAppointmentId,
      calendarId: event.appointment.calendarId,
      groupId: event.appointment.groupId,
      title: event.appointment.title,
      address: event.appointment.address,
      status: event.appointment.status,
      assignedUserId: event.appointment.assignedUserId,
      users: event.appointment.users,
      notes: event.appointment.notes,
      source: event.appointment.source,
      startTime: parseNullableDate(event.appointment.startTime),
      endTime: parseNullableDate(event.appointment.endTime),
      dateAdded: parseNullableDate(event.appointment.dateAdded),
      dateUpdated: parseNullableDate(event.appointment.dateUpdated),
      raw: event.raw,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [appointments.locationId, appointments.ghlAppointmentId],
      set: {
        contactId,
        calendarId: event.appointment.calendarId,
        groupId: event.appointment.groupId,
        title: event.appointment.title,
        address: event.appointment.address,
        status: event.appointment.status,
        assignedUserId: event.appointment.assignedUserId,
        users: event.appointment.users,
        notes: event.appointment.notes,
        source: event.appointment.source,
        startTime: parseNullableDate(event.appointment.startTime),
        endTime: parseNullableDate(event.appointment.endTime),
        dateAdded: parseNullableDate(event.appointment.dateAdded),
        dateUpdated: parseNullableDate(event.appointment.dateUpdated),
        raw: event.raw,
        updatedAt: now
      }
    });

  await db
    .update(webhookEvents)
    .set({ status: "processed", processedAt: now, error: null })
    .where(eq(webhookEvents.idempotencyKey, event.idempotencyKey));
}

async function processInstallWebhookEvent(env: Env, event: NormalizedGhlInstallWebhookEvent) {
  const db = createDb(env.DATABASE_URL);
  const now = new Date();

  const [agency] = await db
    .insert(agencies)
    .values({
      ghlAgencyId: event.agency.ghlAgencyId,
      name: event.agency.name ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: agencies.ghlAgencyId,
      set: {
        name: event.agency.name ?? null,
        updatedAt: now
      }
    })
    .returning({ id: agencies.id });

  if (agency && event.location.ghlLocationId) {
    await db
      .insert(locations)
      .values({
        agencyId: agency.id,
        ghlLocationId: event.location.ghlLocationId,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: locations.ghlLocationId,
        set: {
          agencyId: agency.id,
          updatedAt: now
        }
      });
  }

  await db
    .update(webhookEvents)
    .set({ status: "processed", processedAt: now, error: null })
    .where(eq(webhookEvents.idempotencyKey, event.idempotencyKey));
}

async function processInvoiceWebhookEvent(env: Env, event: NormalizedGhlInvoiceWebhookEvent) {
  const db = createDb(env.DATABASE_URL);
  const now = new Date();

  const [agency] = await db
    .insert(agencies)
    .values({
      ghlAgencyId: event.agency.ghlAgencyId,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: agencies.ghlAgencyId,
      set: { updatedAt: now }
    })
    .returning({ id: agencies.id });

  if (!agency) {
    throw new Error("Failed to upsert agency");
  }

  const [location] = await db
    .insert(locations)
    .values({
      agencyId: agency.id,
      ghlLocationId: event.location.ghlLocationId,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: locations.ghlLocationId,
      set: {
        agencyId: agency.id,
        updatedAt: now
      }
    })
    .returning({ id: locations.id });

  if (!location) {
    throw new Error("Failed to upsert location");
  }

  let contactId: string | null = null;
  if (event.contact.ghlContactId) {
    const nameParts = splitContactName(event.contact.name);
    const [contact] = await db
      .insert(contacts)
      .values({
        locationId: location.id,
        ghlContactId: event.contact.ghlContactId,
        firstName: nameParts.firstName,
        lastName: nameParts.lastName,
        email: event.contact.email,
        phone: event.contact.phone,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [contacts.locationId, contacts.ghlContactId],
        set: {
          firstName: nameParts.firstName,
          lastName: nameParts.lastName,
          email: event.contact.email,
          phone: event.contact.phone,
          updatedAt: now
        }
      })
      .returning({ id: contacts.id });
    contactId = contact?.id ?? null;
  }

  await db
    .insert(invoices)
    .values({
      locationId: location.id,
      contactId,
      ghlInvoiceId: event.invoice.ghlInvoiceId,
      status: event.invoice.status,
      liveMode: event.invoice.liveMode,
      amountPaid: normalizeMoneyAmount(event.invoice.amountPaid),
      amountDue: normalizeMoneyAmount(event.invoice.amountDue),
      total: normalizeMoneyAmount(event.invoice.total),
      currency: event.invoice.currency,
      altId: event.invoice.altId,
      altType: event.invoice.altType,
      name: event.invoice.name,
      title: event.invoice.title,
      invoiceNumber: event.invoice.invoiceNumber,
      issueDate: parseNullableDate(event.invoice.issueDate),
      dueDate: parseNullableDate(event.invoice.dueDate),
      ghlCreatedAt: parseNullableDate(event.invoice.createdAt),
      ghlUpdatedAt: parseNullableDate(event.invoice.updatedAt),
      lastEventType: event.eventType,
      isDeleted: event.invoice.eventAction === "delete",
      raw: event.raw,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [invoices.locationId, invoices.ghlInvoiceId],
      set: {
        contactId,
        status: event.invoice.status,
        liveMode: event.invoice.liveMode,
        amountPaid: normalizeMoneyAmount(event.invoice.amountPaid),
        amountDue: normalizeMoneyAmount(event.invoice.amountDue),
        total: normalizeMoneyAmount(event.invoice.total),
        currency: event.invoice.currency,
        altId: event.invoice.altId,
        altType: event.invoice.altType,
        name: event.invoice.name,
        title: event.invoice.title,
        invoiceNumber: event.invoice.invoiceNumber,
        issueDate: parseNullableDate(event.invoice.issueDate),
        dueDate: parseNullableDate(event.invoice.dueDate),
        ghlCreatedAt: parseNullableDate(event.invoice.createdAt),
        ghlUpdatedAt: parseNullableDate(event.invoice.updatedAt),
        lastEventType: event.eventType,
        isDeleted: event.invoice.eventAction === "delete",
        raw: event.raw,
        updatedAt: now
      }
    });

  await db
    .update(webhookEvents)
    .set({ status: "processed", processedAt: now, error: null })
    .where(eq(webhookEvents.idempotencyKey, event.idempotencyKey));
}

async function fetchContactDetailsOnDemand(
  env: Env,
  ghlContactId: string
): Promise<ContactOnDemandDetails | null> {
  if (!env.GHL_API_TOKEN) {
    return null;
  }

  try {
    const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
    const response = await fetch(`${baseUrl}/contacts/${encodeURIComponent(ghlContactId)}`, {
      headers: {
        Authorization: `Bearer ${env.GHL_API_TOKEN}`,
        Accept: "application/json",
        Version: "2021-07-28"
      }
    });

    if (!response.ok) {
      return null;
    }

    const data = asRecord(await response.json());
    const contact = asRecord(data.contact ?? data);
    return {
      tags: toStringArray(contact.tags),
      customFields: toCustomFields(contact.customFields ?? contact.customField)
    };
  } catch (error) {
    console.warn("Failed to fetch GoHighLevel contact details", error);
    return null;
  }
}

async function normalizeGhlWebhook(
  payload: unknown,
  headers: Headers,
  rawBody: string
): Promise<NormalizedGhlWebhookEvent | null> {
  const root = asRecord(payload);
  const eventType = stringValue(root.type ?? root.event ?? root.eventType ?? "message.received");
  const eventLower = eventType.toLowerCase();

  if (eventLower.includes("call")) {
    return null;
  }

  if (eventLower === "install") {
    return normalizeInstallWebhook(root, headers, rawBody, eventType);
  }

  if (eventLower.includes("appointment")) {
    return normalizeAppointmentWebhook(root, headers, rawBody, eventType);
  }

  if (eventLower.includes("invoice")) {
    return normalizeInvoiceWebhook(root, headers, rawBody, eventType);
  }

  return normalizeMessageWebhook(root, headers, rawBody, eventType);
}

async function normalizeMessageWebhook(
  root: Record<string, any>,
  headers: Headers,
  rawBody: string,
  eventType: string
): Promise<NormalizedGhlMessageWebhookEvent | null> {
  const message = asRecord(root.message ?? root.messageData ?? root);
  const channel = normalizeChannel(
    root.channel ?? root.messageType ?? message.channel ?? message.type ?? eventType
  );
  const direction = normalizeDirection(root.direction ?? message.direction ?? message.type);

  if (!channel || !direction) {
    return null;
  }

  const ghlLocationId = stringValue(root.locationId ?? root.location?.id ?? message.locationId);
  const ghlContactId = stringValue(root.contactId ?? root.contact?.id ?? message.contactId);
  const explicitMessageId = stringValue(
    root.messageId ?? root.conversationMessageId ?? message.id ?? message.messageId
  );

  if (!ghlLocationId || !ghlContactId) {
    return null;
  }

  const ghlMessageId = explicitMessageId || (await sha256Hex(rawBody));
  const idempotencyHeader = getWebhookIdempotencyHeader(headers);
  const idempotencyKey =
    idempotencyHeader ??
    `${ghlLocationId}:${ghlContactId}:${ghlMessageId}:${channel}:${direction}`;

  return {
    kind: "message",
    idempotencyKey,
    eventType,
    location: {
      ghlLocationId,
      name: stringOrNull(root.location?.name ?? root.locationName)
    },
    agency: {
      ghlAgencyId: stringValue(root.agencyId ?? root.companyId ?? root.agency?.id) || "default",
      name: stringOrNull(root.agency?.name ?? root.companyName)
    },
    contact: {
      ghlContactId,
      firstName: stringOrNull(root.contact?.firstName ?? root.firstName),
      lastName: stringOrNull(root.contact?.lastName ?? root.lastName),
      email: stringOrNull(root.contact?.email ?? root.email),
      phone: stringOrNull(root.contact?.phone ?? root.phone)
    },
    message: {
      ghlMessageId,
      channel,
      direction,
      subject: stringOrNull(root.subject ?? message.subject),
      body: stringOrNull(root.body ?? message.body ?? message.content ?? message.html),
      from: stringOrNull(root.from ?? message.from),
      to: stringOrNull(root.to ?? message.to),
      sentAt: normalizeDate(root.dateAdded ?? root.createdAt ?? message.dateAdded ?? message.createdAt)
    },
    raw: root
  };
}

async function normalizeAppointmentWebhook(
  root: Record<string, any>,
  headers: Headers,
  rawBody: string,
  eventType: string
): Promise<NormalizedGhlAppointmentWebhookEvent | null> {
  const appointment = asRecord(root.appointment ?? root);
  const ghlLocationId = stringValue(root.locationId ?? appointment.locationId);
  const ghlAppointmentId = stringValue(appointment.id ?? appointment.appointmentId);

  if (!ghlLocationId || !ghlAppointmentId) {
    return null;
  }

  const idempotencyHeader = getWebhookIdempotencyHeader(headers);
  const webhookId = stringOrNull(root.webhookId);
  const idempotencyKey =
    idempotencyHeader ??
    webhookId ??
    `${eventType}:${ghlLocationId}:${ghlAppointmentId}:${stringValue(appointment.dateUpdated ?? appointment.dateAdded)}`;

  return {
    kind: "appointment",
    idempotencyKey,
    eventType,
    location: {
      ghlLocationId,
      name: stringOrNull(root.location?.name ?? root.locationName)
    },
    agency: {
      ghlAgencyId: stringValue(root.companyId ?? root.agencyId ?? root.agency?.id) || "default",
      name: stringOrNull(root.companyName ?? root.agency?.name)
    },
    contact: {
      ghlContactId: stringOrNull(appointment.contactId ?? root.contactId)
    },
    appointment: {
      ghlAppointmentId,
      calendarId: stringOrNull(appointment.calendarId),
      groupId: stringOrNull(appointment.groupId),
      title: stringOrNull(appointment.title),
      address: stringOrNull(appointment.address),
      status: stringOrNull(appointment.appointmentStatus ?? appointment.status),
      assignedUserId: stringOrNull(appointment.assignedUserId),
      users: toStringArray(appointment.users),
      notes: stringOrNull(appointment.notes),
      source: stringOrNull(appointment.source),
      startTime: stringOrNull(appointment.startTime),
      endTime: stringOrNull(appointment.endTime),
      dateAdded: stringOrNull(appointment.dateAdded),
      dateUpdated: stringOrNull(appointment.dateUpdated)
    },
    raw: root
  };
}

async function normalizeInstallWebhook(
  root: Record<string, any>,
  headers: Headers,
  rawBody: string,
  eventType: string
): Promise<NormalizedGhlInstallWebhookEvent | null> {
  const ghlAgencyId = stringValue(root.companyId ?? root.agencyId);

  if (!ghlAgencyId) {
    return null;
  }

  const webhookId = stringOrNull(root.webhookId);
  const idempotencyHeader = getWebhookIdempotencyHeader(headers);
  const idempotencyKey =
    idempotencyHeader ??
    webhookId ??
    `${eventType}:${ghlAgencyId}:${stringValue(root.locationId)}:${stringValue(root.timestamp) || (await sha256Hex(rawBody))}`;

  return {
    kind: "install",
    idempotencyKey,
    eventType,
    appId: stringOrNull(root.appId),
    versionId: stringOrNull(root.versionId),
    installType: stringOrNull(root.installType),
    location: {
      ghlLocationId: stringOrNull(root.locationId)
    },
    agency: {
      ghlAgencyId,
      name: stringOrNull(root.companyName)
    },
    userId: stringOrNull(root.userId),
    isWhitelabelCompany:
      typeof root.isWhitelabelCompany === "boolean" ? root.isWhitelabelCompany : null,
    timestamp: stringOrNull(root.timestamp),
    raw: root
  };
}

async function normalizeInvoiceWebhook(
  root: Record<string, any>,
  headers: Headers,
  rawBody: string,
  eventType: string
): Promise<NormalizedGhlInvoiceWebhookEvent | null> {
  const contactDetails = asRecord(root.contactDetails);
  const ghlLocationId = stringValue(root.locationId ?? root.altId);
  const ghlInvoiceId = stringValue(root._id ?? root.id ?? root.invoiceId);

  if (!ghlLocationId || !ghlInvoiceId) {
    return null;
  }

  const idempotencyHeader = getWebhookIdempotencyHeader(headers);
  const idempotencyKey =
    idempotencyHeader ??
    `${eventType}:${ghlLocationId}:${ghlInvoiceId}:${stringValue(root.updatedAt ?? root.createdAt) || (await sha256Hex(rawBody))}`;

  return {
    kind: "invoice",
    idempotencyKey,
    eventType,
    location: {
      ghlLocationId
    },
    agency: {
      ghlAgencyId: stringValue(root.companyId ?? root.agencyId) || "default"
    },
    contact: {
      ghlContactId: stringOrNull(contactDetails.id ?? root.contactId),
      name: stringOrNull(contactDetails.name),
      email: stringOrNull(contactDetails.email),
      phone: stringOrNull(contactDetails.phoneNo ?? contactDetails.phone),
      companyName: stringOrNull(contactDetails.companyName)
    },
    invoice: {
      ghlInvoiceId,
      status: stringOrNull(root.status),
      liveMode: typeof root.liveMode === "boolean" ? root.liveMode : null,
      amountPaid: numberOrNull(root.amountPaid),
      amountDue: numberOrNull(root.amountDue),
      total: numberOrNull(root.total),
      currency: stringOrNull(root.currency),
      altId: stringOrNull(root.altId),
      altType: stringOrNull(root.altType),
      name: stringOrNull(root.name),
      title: stringOrNull(root.title),
      invoiceNumber: stringOrNull(root.invoiceNumber),
      issueDate: stringOrNull(root.issueDate),
      dueDate: stringOrNull(root.dueDate),
      createdAt: stringOrNull(root.createdAt),
      updatedAt: stringOrNull(root.updatedAt),
      eventAction: normalizeInvoiceEventAction(eventType)
    },
    raw: root
  };
}

async function verifyWebhookSignature(
  rawBody: string,
  headers: Headers,
  secret?: string
): Promise<boolean> {
  if (!secret) {
    return true;
  }

  const provided = headers.get("x-ghl-signature") ?? headers.get("x-gohighlevel-signature");
  if (!provided) {
    return false;
  }

  const expected = await hmacSha256(rawBody, secret);
  return signaturesMatch(provided, expected);
}

async function hmacSha256(body: string, secret: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  return new Uint8Array(signature);
}

function signaturesMatch(provided: string, expected: Uint8Array): boolean {
  const normalized = provided.trim().replace(/^sha256=/i, "");
  const providedBytes = fromHex(normalized) ?? fromBase64(normalized);

  if (!providedBytes || providedBytes.length !== expected.length) {
    return false;
  }

  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected[index]! ^ providedBytes[index]!;
  }
  return diff === 0;
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[\da-f]+$/i.test(value) || value.length % 2 !== 0) {
    return null;
  }

  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeChannel(value: unknown): MessageChannel | null {
  const normalized = stringValue(value).toLowerCase();
  if (normalized.includes("email")) {
    return "email";
  }
  if (normalized.includes("sms") || normalized.includes("text")) {
    return "sms";
  }
  return null;
}

function normalizeDirection(value: unknown): MessageDirection | null {
  const normalized = stringValue(value).toLowerCase();
  if (normalized.includes("inbound") || normalized.includes("incoming")) {
    return "inbound";
  }
  if (normalized.includes("outbound") || normalized.includes("outgoing")) {
    return "outbound";
  }
  return null;
}

function normalizeDate(value: unknown): string {
  const date = value ? new Date(stringValue(value)) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toISOString();
  }
  return date.toISOString();
}

function parseNullableDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeMoneyAmount(value: number | null): number | null {
  return value == null ? null : Math.round(value);
}

function normalizeInvoiceEventAction(eventType: string) {
  const normalized = eventType.toLowerCase();
  if (normalized.includes("paid") && normalized.includes("partial")) {
    return "partially_paid";
  }
  if (normalized.includes("paid")) {
    return "paid";
  }
  if (normalized.includes("sent")) {
    return "sent";
  }
  if (normalized.includes("void")) {
    return "void";
  }
  if (normalized.includes("delete")) {
    return "delete";
  }
  if (normalized.includes("update")) {
    return "update";
  }
  return "create";
}

function splitContactName(name: string | null) {
  if (!name) {
    return { firstName: null, lastName: null };
  }

  const [firstName, ...rest] = name.trim().split(/\s+/);
  return {
    firstName: firstName || null,
    lastName: rest.length > 0 ? rest.join(" ") : null
  };
}

function getWebhookIdempotencyHeader(headers: Headers): string | null {
  return (
    headers.get("x-ghl-idempotency-key") ??
    headers.get("x-gohighlevel-webhook-id") ??
    headers.get("x-webhook-id") ??
    headers.get("x-event-id")
  );
}

function formatContactName(
  firstName?: string | null,
  lastName?: string | null,
  email?: string | null,
  phone?: string | null
) {
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  return fullName || email || phone || "Unknown contact";
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? (value as Record<string, any>) : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function stringOrNull(value: unknown): string | null {
  const result = stringValue(value).trim();
  return result ? result : null;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}

function toCustomFields(value: unknown): ContactOnDemandDetails["customFields"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((field) => {
    const record = asRecord(field);
    return {
      id: stringOrNull(record.id ?? record.customFieldId) ?? undefined,
      name: stringOrNull(record.name ?? record.fieldName) ?? undefined,
      value: record.value
    };
  });
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<NormalizedGhlWebhookEvent>, env: Env) {
    for (const message of batch.messages) {
      try {
        await processWebhookEvent(env, message.body);
        message.ack();
      } catch (error) {
        const db = createDb(env.DATABASE_URL);
        await db
          .update(webhookEvents)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            processedAt: new Date()
          })
          .where(eq(webhookEvents.idempotencyKey, message.body.idempotencyKey));
        message.retry();
      }
    }
  }
};

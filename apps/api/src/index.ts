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
  userSubaccountVisibilities,
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
import { and, desc, eq, notInArray, or, sql } from "drizzle-orm";
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
    allowHeaders: ["Content-Type", "Authorization", "x-ghl-access-token", "x-viewer-key"]
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

  try {
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
  } catch (error) {
    console.error("Failed to complete GoHighLevel OAuth callback", error);
    const reason = error instanceof Error ? error.message : "oauth_callback_failed";
    return redirectToFrontend(c, `/settings/integrations?ghl=error&reason=${encodeURIComponent(reason)}`);
  }
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
  const viewerKey = getViewerKey(c);
  const hiddenLocationIds = await getHiddenLocationIdsForViewer(db, viewerKey);
  const filters = [];

  if (pendingReply === "true") {
    filters.push(eq(threads.pendingReply, true));
  }

  if (locationId) {
    const locationFilters = [eq(locations.ghlLocationId, locationId)];
    if (isUuid(locationId)) {
      locationFilters.push(eq(threads.locationId, locationId));
    }
    filters.push(or(...locationFilters));
  }

  if (hiddenLocationIds.length > 0) {
    filters.push(notInArray(threads.locationId, hiddenLocationIds));
  }

  let query = db
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
    .$dynamic();

  if (filters.length > 0) {
    query = query.where(and(...filters));
  }

  const rows = await query.orderBy(desc(threads.lastMessageAt)).limit(100);
  const locationNameMap = await hydrateMissingLocationNames(
    c.env,
    db,
    rows.map((row) => ({
      locationId: row.locationId,
      ghlLocationId: row.ghlLocationId,
      locationName: row.locationName
    }))
  );
  return c.json({
    threads: rows.map((row) => ({
      id: row.threadId,
      locationId: row.locationId,
      ghlLocationId: row.ghlLocationId,
      locationName: locationNameMap.get(row.locationId) ?? row.locationName,
      contactId: row.contactId,
      contactName: formatContactName(
        row.firstName,
        row.lastName,
        row.email,
        row.phone
      ),
      contactEmail: row.email,
      contactPhone: row.phone,
      pendingReply: row.pendingReply,
      unreadCount: row.unreadCount,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null
    }))
  });
});

app.get("/appointments", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const locationId = c.req.query("locationId");
  const viewerKey = getViewerKey(c);
  const hiddenLocationIds = await getHiddenLocationIdsForViewer(db, viewerKey);
  const filters = [];

  let query = db
    .select({
      appointmentId: appointments.id,
      ghlAppointmentId: appointments.ghlAppointmentId,
      locationId: appointments.locationId,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name,
      contactId: contacts.id,
      ghlContactId: contacts.ghlContactId,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      title: appointments.title,
      status: appointments.status,
      startTime: appointments.startTime,
      endTime: appointments.endTime,
      updatedAt: appointments.updatedAt
    })
    .from(appointments)
    .innerJoin(locations, eq(appointments.locationId, locations.id))
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .$dynamic();

  if (locationId) {
    const locationFilters = [eq(locations.ghlLocationId, locationId)];
    if (isUuid(locationId)) {
      locationFilters.push(eq(appointments.locationId, locationId));
    }
    filters.push(or(...locationFilters));
  }

  if (hiddenLocationIds.length > 0) {
    filters.push(notInArray(appointments.locationId, hiddenLocationIds));
  }

  if (filters.length > 0) {
    query = query.where(and(...filters));
  }

  const rows = await query.orderBy(desc(appointments.startTime), desc(appointments.updatedAt)).limit(200);
  const locationNameMap = await hydrateMissingLocationNames(
    c.env,
    db,
    rows.map((row) => ({
      locationId: row.locationId,
      ghlLocationId: row.ghlLocationId,
      locationName: row.locationName
    }))
  );
  return c.json({
    appointments: rows.map((row) => ({
      id: row.appointmentId,
      ghlAppointmentId: row.ghlAppointmentId,
      locationId: row.locationId,
      ghlLocationId: row.ghlLocationId,
      locationName: locationNameMap.get(row.locationId) ?? row.locationName,
      contactId: row.contactId ?? null,
      contactName: formatContactName(row.firstName, row.lastName, row.email, row.phone),
      contactEmail: row.email,
      contactPhone: row.phone,
      title: row.title,
      status: row.status,
      startTime: row.startTime?.toISOString() ?? null,
      endTime: row.endTime?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString()
    }))
  });
});

app.get("/locations", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);

  const rows = await db
    .select({
      id: locations.id,
      ghlLocationId: locations.ghlLocationId,
      name: locations.name,
      agencyId: locations.agencyId,
      agencyName: agencies.name,
      updatedAt: locations.updatedAt
    })
    .from(locations)
    .leftJoin(agencies, eq(locations.agencyId, agencies.id))
    .orderBy(desc(locations.updatedAt))
    .limit(limit);

  return c.json({
    locations: rows.map((row) => ({
      id: row.id,
      ghlLocationId: row.ghlLocationId,
      name: row.name,
      agencyId: row.agencyId,
      agencyName: row.agencyName,
      updatedAt: row.updatedAt.toISOString()
    }))
  });
});

app.get("/subaccounts/overview", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const viewerKey = getViewerKey(c);
  const surface = c.req.query("surface") ?? "all";

  const [locationRows, conversationRows, pendingRows, appointmentRows, visibilityRows] = await Promise.all([
    db
      .select({
        locationId: locations.id,
        ghlLocationId: locations.ghlLocationId,
        locationName: locations.name,
        agencyId: locations.agencyId,
        agencyName: agencies.name
      })
      .from(locations)
      .leftJoin(agencies, eq(locations.agencyId, agencies.id))
      .orderBy(locations.ghlLocationId),
    db
      .select({
        locationId: threads.locationId,
        count: sql<number>`count(*)::int`
      })
      .from(threads)
      .groupBy(threads.locationId),
    db
      .select({
        locationId: threads.locationId,
        count: sql<number>`count(*)::int`
      })
      .from(threads)
      .where(eq(threads.pendingReply, true))
      .groupBy(threads.locationId),
    db
      .select({
        locationId: appointments.locationId,
        count: sql<number>`count(*)::int`
      })
      .from(appointments)
      .groupBy(appointments.locationId),
    db
      .select({
        locationId: userSubaccountVisibilities.locationId,
        isVisible: userSubaccountVisibilities.isVisible
      })
      .from(userSubaccountVisibilities)
      .where(eq(userSubaccountVisibilities.userKey, viewerKey))
  ]);

  const conversationsByLocation = new Map(
    conversationRows.map((row) => [row.locationId, Number(row.count)])
  );
  const pendingByLocation = new Map(pendingRows.map((row) => [row.locationId, Number(row.count)]));
  const appointmentsByLocation = new Map(
    appointmentRows.map((row) => [row.locationId, Number(row.count)])
  );
  const visibilityByLocation = new Map(visibilityRows.map((row) => [row.locationId, row.isVisible]));

  const subaccounts = locationRows
    .map((row) => ({
      locationId: row.locationId,
      ghlLocationId: row.ghlLocationId,
      locationName: row.locationName,
      agencyId: row.agencyId,
      agencyName: row.agencyName,
      conversationCount: conversationsByLocation.get(row.locationId) ?? 0,
      pendingCount: pendingByLocation.get(row.locationId) ?? 0,
      appointmentCount: appointmentsByLocation.get(row.locationId) ?? 0,
      visible: visibilityByLocation.get(row.locationId) ?? true
    }))
    .filter((row) => {
      if (surface === "threads") {
        return row.visible && row.conversationCount > 0;
      }
      if (surface === "appointments") {
        return row.visible && row.appointmentCount > 0;
      }
      return true;
    });

  return c.json({
    viewerKey,
    subaccounts
  });
});

app.post("/subaccounts/visibility", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const viewerKey = getViewerKey(c);
  const body = asRecord(await c.req.json().catch(() => ({})));
  const locationId = stringValue(body.locationId).trim();
  const visible =
    typeof body.visible === "boolean"
      ? body.visible
      : stringValue(body.visible).toLowerCase() !== "false";

  if (!isUuid(locationId)) {
    return c.json({ error: "Invalid locationId" }, 400);
  }

  const now = new Date();
  await db
    .insert(userSubaccountVisibilities)
    .values({
      userKey: viewerKey,
      locationId,
      isVisible: visible,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [userSubaccountVisibilities.userKey, userSubaccountVisibilities.locationId],
      set: {
        isVisible: visible,
        updatedAt: now
      }
    });

  return c.json({
    ok: true,
    viewerKey,
    locationId,
    visible
  });
});

app.get("/debug/location/:ghlLocationId", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const ghlLocationId = c.req.param("ghlLocationId");
  const manualAccessToken = c.req.header("x-ghl-access-token") ?? c.req.query("accessToken");

  let accessToken = manualAccessToken?.trim() || null;
  if (!accessToken) {
    accessToken = c.env.GHL_API_TOKEN?.trim() || null;
  }

  if (!accessToken) {
    const [installation] = await db
      .select({
        accessToken: ghlOAuthInstallations.accessToken
      })
      .from(ghlOAuthInstallations)
      .where(eq(ghlOAuthInstallations.locationId, ghlLocationId))
      .orderBy(desc(ghlOAuthInstallations.updatedAt))
      .limit(1);
    accessToken = installation?.accessToken ?? null;
  }

  if (!accessToken) {
    const companyInstallation = await getCompanyOAuthInstallationForLocation(db, ghlLocationId);
    accessToken = companyInstallation?.accessToken ?? null;
  }

  const result = await fetchRawLocationResponse(c.env, ghlLocationId, accessToken);
  const status = result.status > 0 ? result.status : 502;
  const contentType = result.responseHeaders["content-type"] ?? "application/json; charset=utf-8";
  const body =
    result.responseRawBody ??
    JSON.stringify({ error: "location_lookup_failed", message: String(result.response ?? "unknown_error") });

  return new Response(body, {
    status,
    headers: {
      "Content-Type": contentType
    }
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
      tags: contacts.tags,
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

  const locationNameMap = await hydrateMissingLocationNames(c.env, db, [
    {
      locationId: threadRow.locationId,
      ghlLocationId: threadRow.ghlLocationId,
      locationName: threadRow.locationName
    }
  ]);
  const resolvedLocationName = locationNameMap.get(threadRow.locationId) ?? threadRow.locationName;
  const contactFieldMap = await hydrateMissingContactFields(c.env, db, [
    {
      contactId: threadRow.contactId,
      ghlContactId: threadRow.ghlContactId,
      ghlLocationId: threadRow.ghlLocationId,
      firstName: threadRow.firstName,
      lastName: threadRow.lastName,
      email: threadRow.email,
      phone: threadRow.phone
    }
  ]);
  const resolvedContact = contactFieldMap.get(threadRow.contactId);

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

  const contactDetails =
    (await fetchContactDetailsOnDemand(c.env, db, threadRow.ghlLocationId, threadRow.ghlContactId)) ??
    toStoredContactDetails({
      tags: threadRow.tags,
      firstName: resolvedContact?.firstName ?? threadRow.firstName,
      lastName: resolvedContact?.lastName ?? threadRow.lastName,
      email: resolvedContact?.email ?? threadRow.email,
      phone: resolvedContact?.phone ?? threadRow.phone,
      ghlContactId: threadRow.ghlContactId
    });

  return c.json({
    thread: {
      id: threadRow.threadId,
      locationId: threadRow.locationId,
      ghlLocationId: threadRow.ghlLocationId,
      locationName: resolvedLocationName,
      contactId: threadRow.contactId,
      contactName: formatContactName(
        resolvedContact?.firstName ?? threadRow.firstName,
        resolvedContact?.lastName ?? threadRow.lastName,
        resolvedContact?.email ?? threadRow.email,
        resolvedContact?.phone ?? threadRow.phone
      ),
      contactEmail: resolvedContact?.email ?? threadRow.email,
      contactPhone: resolvedContact?.phone ?? threadRow.phone,
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

app.post("/threads/:id/reply", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const threadId = c.req.param("id");
  const body = asRecord(await c.req.json().catch(() => ({})));
  const messageBody = stringValue(body.message).trim();
  const subject = stringOrNull(body.subject)?.trim() || null;
  const channel = normalizeReplyChannel(body.channel);

  if (!messageBody) {
    return c.json({ error: "message is required" }, 400);
  }

  const [threadRow] = await db
    .select({
      threadId: threads.id,
      locationId: threads.locationId,
      ghlLocationId: locations.ghlLocationId,
      contactId: contacts.id,
      ghlContactId: contacts.ghlContactId
    })
    .from(threads)
    .innerJoin(locations, eq(threads.locationId, locations.id))
    .innerJoin(contacts, eq(threads.contactId, contacts.id))
    .where(eq(threads.id, threadId))
    .limit(1);

  if (!threadRow) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const accessTokens = await getAccessTokensForLocation(c.env, db, threadRow.ghlLocationId);
  if (accessTokens.length === 0) {
    return c.json({ error: "No GoHighLevel token available for this location" }, 400);
  }

  let lastError: string | null = null;
  for (const accessToken of accessTokens) {
    const sent = await sendConversationMessageWithToken(c.env, {
      accessToken,
      channel,
      ghlContactId: threadRow.ghlContactId,
      ghlLocationId: threadRow.ghlLocationId,
      message: messageBody,
      subject
    });
    if (!sent.ok) {
      lastError = sent.error ?? `status_${sent.status}`;
      continue;
    }

    const sentAt = new Date();
    const ghlMessageId = sent.messageId ?? `outbound-${crypto.randomUUID()}`;
    const [stored] = await db
      .insert(messages)
      .values({
        threadId: threadRow.threadId,
        locationId: threadRow.locationId,
        contactId: threadRow.contactId,
        ghlMessageId,
        channel,
        direction: "outbound",
        subject: channel === "email" ? subject : null,
        body: messageBody,
        from: null,
        to: null,
        sentAt,
        raw: sent.raw
      })
      .onConflictDoNothing({
        target: [messages.threadId, messages.ghlMessageId]
      })
      .returning({
        id: messages.id,
        ghlMessageId: messages.ghlMessageId,
        channel: messages.channel,
        direction: messages.direction,
        subject: messages.subject,
        body: messages.body,
        from: messages.from,
        to: messages.to,
        sentAt: messages.sentAt
      });

    await db
      .update(threads)
      .set({
        pendingReply: false,
        unreadCount: 0,
        lastMessageAt: sentAt,
        updatedAt: sentAt
      })
      .where(eq(threads.id, threadRow.threadId));

    return c.json({
      ok: true,
      message: stored
        ? {
            id: stored.id,
            ghlMessageId: stored.ghlMessageId,
            channel: stored.channel,
            direction: stored.direction,
            subject: stored.subject,
            body: stored.body,
            from: stored.from,
            to: stored.to,
            sentAt: stored.sentAt.toISOString()
          }
        : null
    });
  }

  return c.json(
    {
      error: "Unable to send message with available GoHighLevel token",
      details: lastError
    },
    502
  );
});

async function exchangeGhlOAuthCode(
  env: Env,
  code: string
): Promise<GhlOAuthTokenResponse> {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const requestBody = new URLSearchParams({
    client_id: env.GHL_CLIENT_ID ?? "",
    client_secret: env.GHL_CLIENT_SECRET ?? "",
    grant_type: "authorization_code",
    code,
    user_type: env.GHL_OAUTH_USER_TYPE ?? "Company",
    redirect_uri: env.GHL_OAUTH_REDIRECT_URI ?? ""
  });
  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: requestBody.toString()
  });

  const raw = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = asRecord(raw);
    const message =
      stringValue(error.message) ||
      stringValue(error.error_description) ||
      stringValue(error.error) ||
      response.statusText ||
      String(response.status);
    throw new Error(`GoHighLevel token exchange failed: ${message}`);
  }

  const token = asRecord(raw);
  const userType = stringValue(token.userType ?? token.user_type);
  const companyId = stringValue(token.companyId ?? token.company_id);

  if (
    !stringValue(token.access_token ?? token.accessToken) ||
    !stringValue(token.refresh_token ?? token.refreshToken) ||
    !companyId ||
    (userType !== "Company" && userType !== "Location")
  ) {
    throw new Error("GoHighLevel token response is missing required fields");
  }

  return {
    accessToken: stringValue(token.access_token ?? token.accessToken),
    refreshToken: stringValue(token.refresh_token ?? token.refreshToken),
    tokenType: stringValue(token.token_type ?? token.tokenType) || "Bearer",
    expiresIn: Number(token.expires_in ?? token.expiresIn ?? 86400),
    scope: stringOrNull(token.scope),
    refreshTokenId: stringOrNull(token.refreshTokenId ?? token.refresh_token_id),
    userType,
    companyId,
    locationId: stringOrNull(token.locationId ?? token.location_id),
    userId: stringOrNull(token.userId ?? token.user_id),
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

type ContactIdentitySnapshot = {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  tags: string[] | null;
};

async function fetchContactProfileForWebhookIfNeeded(
  env: Env,
  db: ReturnType<typeof createDb>,
  locationId: string,
  ghlLocationId: string,
  ghlContactId: string,
  webhookIdentity: Omit<ContactIdentitySnapshot, "tags">
) {
  const existingContact = await getStoredContactIdentity(db, locationId, ghlContactId);
  const webhookIncludesIdentity = hasAnyContactIdentity(webhookIdentity);
  const existingHasIdentity = hasAnyContactIdentity(existingContact);
  const existingHasTags = Array.isArray(existingContact?.tags);

  if (webhookIncludesIdentity || (existingHasIdentity && existingHasTags)) {
    return null;
  }

  return fetchContactProfileOnDemand(env, db, ghlLocationId, ghlContactId);
}

async function getStoredContactIdentity(
  db: ReturnType<typeof createDb>,
  locationId: string,
  ghlContactId: string
): Promise<ContactIdentitySnapshot | null> {
  const [existingContact] = await db
    .select({
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      email: contacts.email,
      phone: contacts.phone,
      tags: contacts.tags
    })
    .from(contacts)
    .where(and(eq(contacts.locationId, locationId), eq(contacts.ghlContactId, ghlContactId)))
    .limit(1);

  if (!existingContact) {
    return null;
  }

  return {
    firstName: existingContact.firstName,
    lastName: existingContact.lastName,
    email: existingContact.email,
    phone: existingContact.phone,
    tags: normalizeStoredContactTags(existingContact.tags)
  };
}

function hasAnyContactIdentity(
  identity: Pick<ContactIdentitySnapshot, "firstName" | "lastName" | "email" | "phone"> | null | undefined
) {
  if (!identity) {
    return false;
  }
  return Boolean(identity.firstName || identity.lastName || identity.email || identity.phone);
}

function normalizeStoredContactTags(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map(stringValue).map((tag) => tag.trim()).filter(Boolean);
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
        name: sql`COALESCE(EXCLUDED.name, ${locations.name})`,
        updatedAt: now
      }
    })
    .returning({ id: locations.id });

  if (!location) {
    throw new Error("Failed to upsert location");
  }

  const contactProfile = await fetchContactProfileForWebhookIfNeeded(
    env,
    db,
    location.id,
    event.location.ghlLocationId,
    event.contact.ghlContactId,
    {
      firstName: event.contact.firstName ?? null,
      lastName: event.contact.lastName ?? null,
      email: event.contact.email ?? null,
      phone: event.contact.phone ?? null
    }
  );

  const [contact] = await db
    .insert(contacts)
    .values({
      locationId: location.id,
      ghlContactId: event.contact.ghlContactId,
      firstName: event.contact.firstName ?? contactProfile?.firstName ?? null,
      lastName: event.contact.lastName ?? contactProfile?.lastName ?? null,
      email: event.contact.email ?? contactProfile?.email ?? null,
      phone: event.contact.phone ?? contactProfile?.phone ?? null,
      tags: contactProfile?.tags ?? null,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [contacts.locationId, contacts.ghlContactId],
      set: {
        firstName: sql`COALESCE(EXCLUDED.first_name, ${contacts.firstName})`,
        lastName: sql`COALESCE(EXCLUDED.last_name, ${contacts.lastName})`,
        email: sql`COALESCE(EXCLUDED.email, ${contacts.email})`,
        phone: sql`COALESCE(EXCLUDED.phone, ${contacts.phone})`,
        tags: sql`COALESCE(EXCLUDED.tags, ${contacts.tags})`,
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
        name: sql`COALESCE(EXCLUDED.name, ${locations.name})`,
        updatedAt: now
      }
    })
    .returning({ id: locations.id });

  if (!location) {
    throw new Error("Failed to upsert location");
  }

  let contactId: string | null = null;
  if (event.contact.ghlContactId) {
    const contactProfile = await fetchContactProfileForWebhookIfNeeded(
      env,
      db,
      location.id,
      event.location.ghlLocationId,
      event.contact.ghlContactId,
      {
        firstName: null,
        lastName: null,
        email: null,
        phone: null
      }
    );

    const [contact] = await db
      .insert(contacts)
      .values({
        locationId: location.id,
        ghlContactId: event.contact.ghlContactId,
        firstName: contactProfile?.firstName ?? null,
        lastName: contactProfile?.lastName ?? null,
        email: contactProfile?.email ?? null,
        phone: contactProfile?.phone ?? null,
        tags: contactProfile?.tags ?? null,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [contacts.locationId, contacts.ghlContactId],
        set: {
          firstName: sql`COALESCE(EXCLUDED.first_name, ${contacts.firstName})`,
          lastName: sql`COALESCE(EXCLUDED.last_name, ${contacts.lastName})`,
          email: sql`COALESCE(EXCLUDED.email, ${contacts.email})`,
          phone: sql`COALESCE(EXCLUDED.phone, ${contacts.phone})`,
          tags: sql`COALESCE(EXCLUDED.tags, ${contacts.tags})`,
          updatedAt: now
        }
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
        name: event.location.name ?? null,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: locations.ghlLocationId,
        set: {
          agencyId: agency.id,
          name: sql`COALESCE(EXCLUDED.name, ${locations.name})`,
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
  db: ReturnType<typeof createDb>,
  ghlLocationId: string,
  ghlContactId: string
): Promise<ContactOnDemandDetails | null> {
  return fetchContactProfileOnDemand(env, db, ghlLocationId, ghlContactId);
}

function toStoredContactDetails(value: {
  tags: unknown;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  ghlContactId: string;
}): ContactOnDemandDetails | null {
  const normalizedTags = normalizeStoredContactTags(value.tags);
  const fullName = formatContactName(value.firstName, value.lastName, value.email, value.phone);
  if (!normalizedTags && fullName === "Unknown contact") {
    return null;
  }
  return {
    id: value.ghlContactId,
    firstName: value.firstName,
    lastName: value.lastName,
    fullName: fullName === "Unknown contact" ? null : fullName,
    email: value.email,
    phone: value.phone,
    companyName: null,
    address1: null,
    city: null,
    state: null,
    country: null,
    postalCode: null,
    website: null,
    source: null,
    type: null,
    dnd: null,
    dateAdded: null,
    dateUpdated: null,
    lastActivityDate: null,
    tags: normalizedTags ?? [],
    customFields: []
  };
}

type ContactProfileOnDemand = ContactOnDemandDetails;

async function fetchContactProfileOnDemand(
  env: Env,
  db: ReturnType<typeof createDb>,
  ghlLocationId: string,
  ghlContactId: string
): Promise<ContactProfileOnDemand | null> {
  const accessTokens = await getAccessTokensForLocation(env, db, ghlLocationId);
  for (const accessToken of accessTokens) {
    const profile = await fetchContactProfileWithToken(env, ghlLocationId, ghlContactId, accessToken);
    if (profile) {
      return profile;
    }
  }

  return null;
}

async function fetchContactProfileWithToken(
  env: Env,
  ghlLocationId: string,
  ghlContactId: string,
  accessToken: string
): Promise<ContactProfileOnDemand | null> {
  try {
    const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
    const requestUrls = [
      `${baseUrl}/contacts/${encodeURIComponent(ghlContactId)}?locationId=${encodeURIComponent(ghlLocationId)}`,
      `${baseUrl}/contacts/${encodeURIComponent(ghlContactId)}`
    ];

    for (const requestUrl of requestUrls) {
      const response = await fetch(requestUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Version: "2021-07-28",
          "Location-Id": ghlLocationId,
          locationId: ghlLocationId
        }
      });

      if (!response.ok) {
        continue;
      }

      const data = asRecord(await response.json());
      const contact = asRecord(data.contact ?? data);
      const firstName = stringOrNull(contact.firstName);
      const lastName = stringOrNull(contact.lastName);
      const email = stringOrNull(contact.email);
      const phone = stringOrNull(contact.phone);
      return {
        id: stringOrNull(contact.id ?? contact.contactId ?? ghlContactId),
        firstName,
        lastName,
        fullName: firstNonEmptyString(
          stringOrNull(contact.name),
          stringOrNull(contact.contactName),
          formatContactName(firstName, lastName, email, phone)
        ),
        email,
        phone,
        companyName: stringOrNull(contact.companyName ?? contact.company),
        address1: stringOrNull(contact.address1 ?? contact.address),
        city: stringOrNull(contact.city),
        state: stringOrNull(contact.state),
        country: stringOrNull(contact.country),
        postalCode: stringOrNull(contact.postalCode ?? contact.zip),
        website: stringOrNull(contact.website),
        source: stringOrNull(contact.source),
        type: stringOrNull(contact.type),
        dnd: normalizeBoolean(contact.dnd),
        dateAdded: stringOrNull(contact.dateAdded ?? contact.createdAt),
        dateUpdated: stringOrNull(contact.dateUpdated ?? contact.updatedAt),
        lastActivityDate: stringOrNull(contact.lastActivityDate ?? contact.lastActivityAt),
        tags: toStringArray(contact.tags),
        customFields: toCustomFields(contact.customFields ?? contact.customField)
      };
    }
    return null;
  } catch (error) {
    console.warn("Failed to fetch GoHighLevel contact details", error);
    return null;
  }
}

async function hydrateMissingLocationNames(
  env: Env,
  db: ReturnType<typeof createDb>,
  entries: Array<{
    locationId: string;
    ghlLocationId: string;
    locationName: string | null;
  }>
) {
  const locationNameMap = new Map(entries.map((entry) => [entry.locationId, entry.locationName]));

  const missingByGhlId = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.locationName) {
      continue;
    }
    const ids = missingByGhlId.get(entry.ghlLocationId) ?? [];
    ids.push(entry.locationId);
    missingByGhlId.set(entry.ghlLocationId, ids);
  }

  for (const [ghlLocationId, locationIds] of missingByGhlId.entries()) {
    const fetchedName = await fetchLocationNameOnDemand(env, db, ghlLocationId);
    if (!fetchedName) {
      continue;
    }

    for (const locationId of locationIds) {
      locationNameMap.set(locationId, fetchedName);
      await db
        .update(locations)
        .set({ name: fetchedName, updatedAt: new Date() })
        .where(eq(locations.id, locationId));
    }
  }

  return locationNameMap;
}

async function hydrateMissingContactFields(
  env: Env,
  db: ReturnType<typeof createDb>,
  entries: Array<{
    contactId: string;
    ghlContactId: string;
    ghlLocationId: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  }>
) {
  const contactFieldMap = new Map(
    entries.map((entry) => [
      entry.contactId,
      {
        firstName: entry.firstName,
        lastName: entry.lastName,
        email: entry.email,
        phone: entry.phone
      }
    ])
  );

  const missingByLookupKey = new Map<
    string,
    {
      ghlContactId: string;
      ghlLocationId: string;
      contactIds: string[];
    }
  >();

  for (const entry of entries) {
    const hasAnyIdentityField = Boolean(entry.firstName || entry.lastName || entry.email || entry.phone);
    if (hasAnyIdentityField) {
      continue;
    }

    const rawIdentity = await getContactIdentityFromLatestMessage(db, entry.contactId);
    if (rawIdentity && (rawIdentity.firstName || rawIdentity.lastName || rawIdentity.email || rawIdentity.phone)) {
      contactFieldMap.set(entry.contactId, rawIdentity);
      await updateContactIdentity(db, entry.contactId, rawIdentity);
      continue;
    }

    const key = `${entry.ghlLocationId}:${entry.ghlContactId}`;
    const existing = missingByLookupKey.get(key);
    if (existing) {
      existing.contactIds.push(entry.contactId);
      continue;
    }
    missingByLookupKey.set(key, {
      ghlContactId: entry.ghlContactId,
      ghlLocationId: entry.ghlLocationId,
      contactIds: [entry.contactId]
    });
  }

  for (const { ghlContactId, ghlLocationId, contactIds } of missingByLookupKey.values()) {
    const profile = await fetchContactProfileOnDemand(env, db, ghlLocationId, ghlContactId);
    if (!profile) {
      continue;
    }

    for (const contactId of contactIds) {
      const resolved = {
        firstName: profile.firstName,
        lastName: profile.lastName,
        email: profile.email,
        phone: profile.phone,
        tags: profile.tags
      };
      contactFieldMap.set(contactId, resolved);
      await updateContactIdentity(db, contactId, resolved);
    }
  }

  return contactFieldMap;
}

async function getContactIdentityFromLatestMessage(
  db: ReturnType<typeof createDb>,
  contactId: string
): Promise<{ firstName: string | null; lastName: string | null; email: string | null; phone: string | null } | null> {
  const [latestMessage] = await db
    .select({
      raw: messages.raw
    })
    .from(messages)
    .where(eq(messages.contactId, contactId))
    .orderBy(desc(messages.sentAt))
    .limit(1);

  if (!latestMessage?.raw) {
    return null;
  }

  const raw = asRecord(latestMessage.raw);
  const rawContact = asRecord(raw.contact ?? raw.message?.contact ?? raw.messageData?.contact);
  const rawName = stringOrNull(raw.contactName ?? rawContact.name ?? raw.name);
  const splitRawName = splitContactName(rawName);
  const firstName = stringOrNull(rawContact.firstName ?? raw.firstName ?? splitRawName.firstName);
  const lastName = stringOrNull(rawContact.lastName ?? raw.lastName ?? splitRawName.lastName);
  const email = stringOrNull(rawContact.email ?? raw.email);
  const phone = stringOrNull(rawContact.phone ?? raw.phone);

  if (!firstName && !lastName && !email && !phone) {
    return null;
  }

  return { firstName, lastName, email, phone };
}

async function updateContactIdentity(
  db: ReturnType<typeof createDb>,
  contactId: string,
  identity: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    tags?: string[] | null;
  }
) {
  const update: Record<string, string | string[] | Date> = { updatedAt: new Date() };
  if (identity.firstName) {
    update.firstName = identity.firstName;
  }
  if (identity.lastName) {
    update.lastName = identity.lastName;
  }
  if (identity.email) {
    update.email = identity.email;
  }
  if (identity.phone) {
    update.phone = identity.phone;
  }
  if (Array.isArray(identity.tags)) {
    update.tags = identity.tags;
  }

  if (Object.keys(update).length > 1) {
    await db.update(contacts).set(update).where(eq(contacts.id, contactId));
  }
}

async function getAccessTokensForLocation(
  env: Env,
  db: ReturnType<typeof createDb>,
  ghlLocationId: string
) {
  const candidates: Array<string | null | undefined> = [env.GHL_API_TOKEN?.trim()];

  const [locationInstallation] = await db
    .select({
      accessToken: ghlOAuthInstallations.accessToken
    })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.locationId, ghlLocationId))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(1);
  candidates.push(locationInstallation?.accessToken);

  const companyInstallation = await getCompanyOAuthInstallationForLocation(db, ghlLocationId);
  candidates.push(companyInstallation?.accessToken);
  if (!candidates.some((token) => token?.trim())) {
    const fallbackCompanyInstallations = await getRecentCompanyOAuthInstallations(db);
    for (const installation of fallbackCompanyInstallations) {
      candidates.push(installation.accessToken);
    }
  }

  const deduped = new Set<string>();
  for (const token of candidates) {
    const normalized = token?.trim();
    if (normalized) {
      deduped.add(normalized);
    }
  }
  return Array.from(deduped);
}

async function fetchLocationNameOnDemand(
  env: Env,
  db: ReturnType<typeof createDb>,
  ghlLocationId: string
): Promise<string | null> {
  const accessTokens = await getAccessTokensForLocation(env, db, ghlLocationId);
  for (const accessToken of accessTokens) {
    const fetchedName = await fetchLocationNameWithToken(env, ghlLocationId, accessToken);
    if (fetchedName) {
      return fetchedName;
    }
  }

  return null;
}

async function getCompanyOAuthInstallationForLocation(
  db: ReturnType<typeof createDb>,
  ghlLocationId: string
) {
  const [locationWithAgency] = await db
    .select({
      ghlAgencyId: agencies.ghlAgencyId
    })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(eq(locations.ghlLocationId, ghlLocationId))
    .limit(1);

  if (!locationWithAgency?.ghlAgencyId) {
    return null;
  }

  const [companyInstallation] = await db
    .select({
      companyId: ghlOAuthInstallations.companyId,
      locationId: ghlOAuthInstallations.locationId,
      userType: ghlOAuthInstallations.userType,
      accessToken: ghlOAuthInstallations.accessToken,
      expiresAt: ghlOAuthInstallations.expiresAt,
      updatedAt: ghlOAuthInstallations.updatedAt
    })
    .from(ghlOAuthInstallations)
    .where(
      and(
        eq(ghlOAuthInstallations.companyId, locationWithAgency.ghlAgencyId),
        eq(ghlOAuthInstallations.userType, "Company")
      )
    )
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(1);

  return companyInstallation ?? null;
}

async function getRecentCompanyOAuthInstallations(db: ReturnType<typeof createDb>, limit = 5) {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return db
    .select({
      companyId: ghlOAuthInstallations.companyId,
      locationId: ghlOAuthInstallations.locationId,
      userType: ghlOAuthInstallations.userType,
      accessToken: ghlOAuthInstallations.accessToken,
      expiresAt: ghlOAuthInstallations.expiresAt,
      updatedAt: ghlOAuthInstallations.updatedAt
    })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.userType, "Company"))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(safeLimit);
}

async function fetchLocationNameWithToken(
  env: Env,
  ghlLocationId: string,
  accessToken: string
): Promise<string | null> {
  const result = await fetchLocationDetailsWithToken(env, ghlLocationId, accessToken);
  return result.ok ? result.name : null;
}

async function fetchLocationDetailsWithToken(
  env: Env,
  ghlLocationId: string,
  accessToken: string
): Promise<{
  ok: boolean;
  status: number;
  name: string | null;
  response: unknown;
  responseRawBody: string | null;
  responseHeaders: Record<string, string>;
  request: {
    endpoint: string;
    query: Record<string, string>;
    body: null;
  };
}> {
  const result = await fetchRawLocationResponse(env, ghlLocationId, accessToken);
  const data = asRecord(safeJsonParse(result.responseRawBody ?? "") ?? {});
  const location = asRecord(data.location ?? data.data ?? data);
  return {
    ok: result.ok,
    status: result.status,
    name: stringOrNull(location.name ?? location.locationName ?? location.businessName),
    response: data,
    responseRawBody: result.responseRawBody,
    responseHeaders: result.responseHeaders,
    request: result.request
  };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

async function fetchRawLocationResponse(
  env: Env,
  ghlLocationId: string,
  accessToken: string | null
): Promise<{
  ok: boolean;
  status: number;
  response: unknown;
  responseRawBody: string | null;
  responseHeaders: Record<string, string>;
  request: {
    endpoint: string;
    query: Record<string, string>;
    body: null;
  };
}> {
  const request = buildGhlLocationLookupRequest(env, ghlLocationId);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Version: "2021-07-28"
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  try {
    const response = await fetch(request.endpoint, { headers });
    return {
      ok: response.ok,
      status: response.status,
      response: null,
      responseRawBody: await response.text(),
      responseHeaders: headersToRecord(response.headers),
      request
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      response: error instanceof Error ? error.message : "unknown_error",
      responseRawBody: null,
      responseHeaders: {},
      request
    };
  }
}

async function sendConversationMessageWithToken(
  env: Env,
  params: {
    accessToken: string;
    ghlLocationId: string;
    ghlContactId: string;
    channel: MessageChannel;
    message: string;
    subject: string | null;
  }
): Promise<{ ok: boolean; status: number; messageId: string | null; raw: unknown; error: string | null }> {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const payload: Record<string, unknown> = {
    type: params.channel === "email" ? "Email" : "SMS",
    contactId: params.ghlContactId,
    locationId: params.ghlLocationId,
    message: params.message
  };
  if (params.channel === "email" && params.subject) {
    payload.subject = params.subject;
  }

  try {
    const response = await fetch(`${baseUrl}/conversations/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        Version: "2021-04-15",
        "Location-Id": params.ghlLocationId,
        locationId: params.ghlLocationId
      },
      body: JSON.stringify(payload)
    });
    const rawBody = await response.text();
    const parsed = asRecord(safeJsonParse(rawBody) ?? {});
    return {
      ok: response.ok,
      status: response.status,
      messageId: stringOrNull(parsed.messageId ?? parsed.id ?? parsed.message?.id ?? parsed.msgId),
      raw: {
        request: payload,
        response: parsed,
        responseRawBody: rawBody
      },
      error: response.ok
        ? null
        : stringOrNull(parsed.message ?? parsed.error ?? parsed.error_description) ?? response.statusText
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      messageId: null,
      raw: { request: payload, response: error instanceof Error ? error.message : String(error) },
      error: error instanceof Error ? error.message : "request_failed"
    };
  }
}

function buildGhlLocationLookupRequest(env: Env, ghlLocationId: string) {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const requestUrl = new URL(`/locations/${encodeURIComponent(ghlLocationId)}`, baseUrl);
  const query: Record<string, string> = {};
  requestUrl.searchParams.forEach((value, key) => {
    query[key] = value;
  });
  return {
    endpoint: requestUrl.toString(),
    query,
    body: null as null
  };
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
      ghlLocationId: stringOrNull(root.locationId),
      name: stringOrNull(root.locationName ?? root.location?.name)
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

function normalizeReplyChannel(value: unknown): MessageChannel {
  const normalized = normalizeChannel(value);
  return normalized ?? "sms";
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

function firstNonEmptyString(...values: Array<string | null | undefined>) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function normalizeBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = stringValue(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return null;
}

function getViewerKey(c: Context<HonoBindings>) {
  const viewerHeader = c.req.header("x-viewer-key");
  const viewerQuery = c.req.query("viewerKey");
  return (viewerHeader ?? viewerQuery ?? "default").trim() || "default";
}

async function getHiddenLocationIdsForViewer(
  db: ReturnType<typeof createDb>,
  viewerKey: string
) {
  const hiddenRows = await db
    .select({
      locationId: userSubaccountVisibilities.locationId
    })
    .from(userSubaccountVisibilities)
    .where(
      and(
        eq(userSubaccountVisibilities.userKey, viewerKey),
        eq(userSubaccountVisibilities.isVisible, false)
      )
    );
  return hiddenRows.map((row) => row.locationId);
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
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

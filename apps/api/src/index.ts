import {
  createDb,
  agencies,
  appointments,
  contacts,
  ghlOAuthInstallations,
  ghlWebhookAppMirror,
  ghlWebhookAppointmentMirror,
  ghlWebhookAssociationMirror,
  ghlWebhookCampaignMirror,
  ghlWebhookContactMirror,
  ghlWebhookConversationMirror,
  ghlWebhookEmailStatsMirror,
  ghlWebhookExternalAuthMirror,
  ghlWebhookInvoiceMirror,
  ghlWebhookLocationMirror,
  ghlWebhookMiscMirror,
  ghlWebhookMirrorEvents,
  ghlWebhookNoteMirror,
  ghlWebhookObjectSchemaMirror,
  ghlWebhookOpportunityMirror,
  ghlWebhookOrderMirror,
  ghlWebhookPriceMirror,
  ghlWebhookProductMirror,
  ghlWebhookRecordMirror,
  ghlWebhookRelationMirror,
  ghlWebhookSaasPlanMirror,
  ghlWebhookTaskMirror,
  ghlWebhookUserMirror,
  ghlWebhookVoiceAiMirror,
  invoices,
  locations,
  messages,
  threads,
  userSubaccountVisibilities,
  webhookEvents
} from "@agentflow/db";
import { DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE, normalizeGhlMarketplaceOAuthScope } from "@agentflow/shared";
import type {
  ContactOnDemandDetails,
  MessageChannel,
  MessageDirection,
  OpportunityStageOption,
  NormalizedGhlAppointmentWebhookEvent,
  NormalizedGhlInstallWebhookEvent,
  NormalizedGhlInvoiceWebhookEvent,
  NormalizedGhlMessageWebhookEvent,
  NormalizedGhlWebhookEvent,
  ThreadOpportunity
} from "@agentflow/shared";
import { and, desc, eq, exists, inArray, notExists, notInArray, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";

import { authLoginHandler } from "./auth-password-handlers.js";
import {
  adminGetUserSubaccounts,
  adminListLocations,
  adminListUsers,
  adminPutUserSubaccounts
} from "./workspace-admin.js";
import {
  getHiddenLocationIdsForPolicy,
  meHandler,
  provisionWorkspaceUserFromGhlAccount,
  resolveAccessPolicy,
  signSessionForProvisionedUser
} from "./workspace-access.js";
import {
  mePutLocationSelectionsHandler,
  workspaceSelectionMatrixHandler
} from "./workspace-selection-handlers.js";
import { fetchSelectionLocationRows, rowsToNullableSelectionSet } from "./workspace-selection-db.js";

function jwtConfiguredForWorkspace(env: Env) {
  return Boolean(env.JWT_SECRET?.trim());
}

type Env = {
  DATABASE_URL: string;
  GHL_WEBHOOK_SECRET?: string;
  GHL_API_TOKEN?: string;
  GHL_API_BASE_URL?: string;
  GHL_CLIENT_ID?: string;
  GHL_CLIENT_SECRET?: string;
  GHL_APP_ID?: string;
  GHL_INSTALL_URL?: string;
  /**
   * Full "Installation URL" from Developer Portal → your app → Advanced Settings → Auth (Show install link).
   * Prefer this over GHL_INSTALL_URL — same OAuth/iframe flow without assembling Marketplace query params by hand.
   */
  GHL_OAUTH_START_URL?: string;
  /** Space-separated scopes for Marketplace install URL; overrides default when set. */
  GHL_OAUTH_SCOPE?: string;
  /** Marketplace app version id; used if absent from GHL_INSTALL_URL query. */
  GHL_VERSION_ID?: string;
  GHL_OAUTH_REDIRECT_URI?: string;
  GHL_OAUTH_USER_TYPE?: string;
  FRONTEND_BASE_URL?: string;
  MESSAGE_QUEUE: Queue<NormalizedGhlWebhookEvent>;
  JWT_SECRET?: string;
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

type WebhookMirrorCategory =
  | "app"
  | "appointment"
  | "association"
  | "campaign"
  | "contact"
  | "conversation"
  | "external_auth"
  | "invoice"
  | "email_stats"
  | "location"
  | "note"
  | "object_schema"
  | "opportunity"
  | "order"
  | "price"
  | "product"
  | "record"
  | "relation"
  | "saas_plan"
  | "task"
  | "user"
  | "voice_ai"
  | "misc";

const supportedWebhookEvents = [
  "AppInstall",
  "AppUninstall",
  "AppUpdate",
  "AppointmentCreate",
  "AppointmentDelete",
  "AppointmentUpdate",
  "AssociationCreate",
  "AssociationDelete",
  "AssociationUpdate",
  "CampaignStatusUpdate",
  "ContactCreate",
  "ContactUpdate",
  "ContactDelete",
  "ContactDndUpdate",
  "ContactTagUpdate",
  "ExternalAuthConnected",
  "InvoiceCreate",
  "InvoiceDelete",
  "InvoicePaid",
  "InvoiceSent",
  "InvoiceUpdate",
  "InvoiceVoid",
  "LCEmailStats",
  "LocationCreate",
  "LocationUpdate",
  "NoteCreate",
  "NoteDelete",
  "NoteUpdate",
  "ObjectSchemaCreate",
  "ObjectSchemaUpdate",
  "OpportunityAssignedToUpdate",
  "OpportunityCreate",
  "OpportunityDelete",
  "OpportunityMonetaryValueUpdate",
  "OpportunityStageUpdate",
  "OpportunityStatusUpdate",
  "OpportunityUpdate",
  "OrderCreate",
  "OrderStatusUpdate",
  "PlanChange",
  "PriceCreate",
  "PriceDelete",
  "PriceUpdate",
  "ProductCreate",
  "ProductDelete",
  "ProductUpdate",
  "RecordCreate",
  "RecordDelete",
  "RecordUpdate",
  "RelationCreate",
  "RelationDelete",
  "SaaSPlanCreate",
  "TaskComplete",
  "TaskCreate",
  "TaskDelete",
  "UserCreate",
  "UserDelete",
  "UserUpdate",
  "VoiceAiCallEnd"
] as const;

const mirrorTableByCategory = {
  app: ghlWebhookAppMirror,
  appointment: ghlWebhookAppointmentMirror,
  association: ghlWebhookAssociationMirror,
  campaign: ghlWebhookCampaignMirror,
  contact: ghlWebhookContactMirror,
  conversation: ghlWebhookConversationMirror,
  external_auth: ghlWebhookExternalAuthMirror,
  invoice: ghlWebhookInvoiceMirror,
  email_stats: ghlWebhookEmailStatsMirror,
  location: ghlWebhookLocationMirror,
  note: ghlWebhookNoteMirror,
  object_schema: ghlWebhookObjectSchemaMirror,
  opportunity: ghlWebhookOpportunityMirror,
  order: ghlWebhookOrderMirror,
  price: ghlWebhookPriceMirror,
  product: ghlWebhookProductMirror,
  record: ghlWebhookRecordMirror,
  relation: ghlWebhookRelationMirror,
  saas_plan: ghlWebhookSaasPlanMirror,
  task: ghlWebhookTaskMirror,
  user: ghlWebhookUserMirror,
  voice_ai: ghlWebhookVoiceAiMirror,
  misc: ghlWebhookMiscMirror
} satisfies Record<WebhookMirrorCategory, any>;

const app = new Hono<HonoBindings>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-ghl-access-token", "x-viewer-key"]
  })
);

app.get("/health", (c) => c.json({ ok: true }));

app.post("/auth/login", authLoginHandler);
app.get("/auth/me", meHandler);
app.put("/workspace/me/location-selections", mePutLocationSelectionsHandler);
app.get("/workspace/selection-matrix", workspaceSelectionMatrixHandler);
app.get("/admin/workspace-users", adminListUsers);
app.get("/admin/workspace-locations", adminListLocations);
app.get("/admin/workspace-users/:id/subaccounts", adminGetUserSubaccounts);
app.put("/admin/workspace-users/:id/subaccounts", adminPutUserSubaccounts);

app.get("/webhooks/gohighlevel", (c) =>
  c.json({
    provider: "gohighlevel",
    defaultWebhookUrl: `${new URL(c.req.url).origin}/webhooks/gohighlevel`,
    method: "POST",
    events: supportedWebhookEvents,
    callsExcluded: true
  })
);

app.get("/oauth/gohighlevel/start", (c) => {
  const hasPortalTemplate = Boolean(c.env.GHL_OAUTH_START_URL?.trim());
  const hasLegacyInstall = Boolean(c.env.GHL_INSTALL_URL?.trim());
  if (!hasPortalTemplate && !hasLegacyInstall) {
    return c.json(
      {
        error: "oauth_start_not_configured",
        message: "Set GHL_OAUTH_START_URL (Installation URL from the GHL developer portal) or GHL_INSTALL_URL"
      },
      500
    );
  }

  const state = crypto.randomUUID();
  let installUrl: URL;
  try {
    installUrl = hasPortalTemplate
      ? prepareGhlOAuthRedirectFromPortalStartUrl(c.env, c.env.GHL_OAUTH_START_URL!, state)
      : prepareGhlOAuthRedirectFromLegacyInstallUrl(c.env, c.env.GHL_INSTALL_URL!, state);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "invalid_ghl_oauth_config", message }, 500);
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

    const establishedCompanyIds = await loadEstablishedGhlCompanyIds(db);
    const incomingCompanyId = tokenResponse.companyId.trim();
    if (establishedCompanyIds.size > 0 && !establishedCompanyIds.has(incomingCompanyId)) {
      return redirectToFrontend(
        c,
        `/login?ghl=error&reason=${encodeURIComponent("wrong_agency")}`
      );
    }

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

    const ghlUserId = tokenResponse.userId?.trim() ?? "";

    let nextPath = "/settings/integrations?ghl=connected";
    if (jwtConfiguredForWorkspace(c.env)) {
      if (!ghlUserId) {
        nextPath = "/login?ghl=error&reason=no_ghl_user_id";
      } else {
        const provisioned = await provisionWorkspaceUserFromGhlAccount(db, ghlUserId);
        if (!provisioned) {
          nextPath = "/login?ghl=error&reason=provision_failed";
        } else {
          try {
            const sessionToken = await signSessionForProvisionedUser(c.env, {
              ...provisioned,
              role: provisioned.role === "admin" ? "admin" : "user"
            });
            nextPath = `/login#session=${encodeURIComponent(sessionToken)}`;
          } catch {
            nextPath = "/login?ghl=error&reason=jwt_issue_failed";
          }
        }
      }
    }

    return redirectToFrontend(c, nextPath);
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

  const db = createDb(c.env.DATABASE_URL);
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch (error) {
    const invalidMirrorEvent = await buildWebhookMirrorRecord({
      payload: { invalidJson: true },
      rawBody,
      headers: c.req.raw.headers,
      webhookType: "invalid_json",
      fallbackCategory: "misc"
    });
    try {
      await persistWebhookMirrorRecord(db, invalidMirrorEvent);
    } catch (mirrorError) {
      console.error("Failed to persist invalid-json webhook mirror event", mirrorError);
      return c.json({
        accepted: true,
        mirrored: false,
        ignored: true,
        reason: "invalid_json"
      }, 202);
    }
    console.error("Invalid GoHighLevel webhook payload JSON", error);
    return c.json({ accepted: true, mirrored: true, ignored: true, reason: "invalid_json" }, 202);
  }

  const mirrorRecord = await buildWebhookMirrorRecord({
    payload,
    rawBody,
    headers: c.req.raw.headers
  });
  let mirrored = true;
  try {
    await persistWebhookMirrorRecord(db, mirrorRecord);
  } catch (error) {
    console.error("Failed to persist mirrored webhook event", error);
    mirrored = false;
  }

  const normalized = await normalizeGhlWebhook(payload, c.req.raw.headers, rawBody);
  if (!normalized) {
    return c.json({
      accepted: true,
      mirrored,
      ignored: true,
      reason: "unsupported_event",
      webhookType: mirrorRecord.webhookType
    });
  }

  try {
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
    return c.json({ accepted: true, mirrored, queued: true }, 202);
  } catch (error) {
    console.error("Failed to persist GoHighLevel webhook", error);
    return c.json({ accepted: false, queued: false, error: "webhook_queue_persist_failed" }, 500);
  }
});

app.get("/threads", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const pendingReply = c.req.query("pendingReply");
  const locationId = c.req.query("locationId");
  const filters = [];

  if (policy.kind === "legacy") {
    const hiddenLocationIds = await getHiddenLocationIdsForPolicy(db, policy);
    if (hiddenLocationIds.length > 0) {
      filters.push(notInArray(threads.locationId, hiddenLocationIds));
    }
  }

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
  const latestMessageIdentityByContactId = await getLatestMessageIdentityByContactId(
    db,
    rows.map((row) => row.contactId)
  );

  return c.json({
    threads: rows.map((row) => {
      const messageIdentity = latestMessageIdentityByContactId.get(row.contactId);
      const resolvedFirstName = row.firstName ?? messageIdentity?.firstName ?? null;
      const resolvedLastName = row.lastName ?? messageIdentity?.lastName ?? null;
      const resolvedEmail = row.email ?? messageIdentity?.email ?? null;
      const resolvedPhone = row.phone ?? messageIdentity?.phone ?? null;
      return {
        id: row.threadId,
        locationId: row.locationId,
        ghlLocationId: row.ghlLocationId,
        locationName: locationNameMap.get(row.locationId) ?? row.locationName,
        contactId: row.contactId,
        contactName: formatContactName(
          resolvedFirstName,
          resolvedLastName,
          resolvedEmail,
          resolvedPhone
        ),
        contactEmail: resolvedEmail,
        contactPhone: resolvedPhone,
        pendingReply: row.pendingReply,
        unreadCount: row.unreadCount,
        lastMessageAt: row.lastMessageAt?.toISOString() ?? null
      };
    })
  });
});

app.get("/appointments", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const locationId = c.req.query("locationId");
  const time = c.req.query("time") ?? "future";
  const paymentStatus = c.req.query("paymentStatus") ?? "unpaid";
  const filters = [];

  if (policy.kind === "legacy") {
    const hiddenLocationIds = await getHiddenLocationIdsForPolicy(db, policy);
    if (hiddenLocationIds.length > 0) {
      filters.push(notInArray(appointments.locationId, hiddenLocationIds));
    }
  }

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
      appointmentCreatedAt: sql<Date>`COALESCE(${appointments.dateAdded}, ${appointments.createdAt})`,
      isPaid: exists(buildAppointmentPaidSubquery(db)),
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

  if (time === "future") {
    filters.push(sql`${appointments.startTime} >= NOW()`);
  } else if (time === "past") {
    filters.push(sql`${appointments.startTime} < NOW()`);
  }

  if (paymentStatus === "unpaid") {
    filters.push(notExists(buildAppointmentPaidSubquery(db)));
  } else if (paymentStatus === "paid") {
    filters.push(exists(buildAppointmentPaidSubquery(db)));
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
      ghlContactId: row.ghlContactId ?? null,
      contactName: formatContactName(row.firstName, row.lastName, row.email, row.phone),
      contactEmail: row.email,
      contactPhone: row.phone,
      title: row.title,
      status: row.status,
      startTime: row.startTime?.toISOString() ?? null,
      endTime: row.endTime?.toISOString() ?? null,
      appointmentCreatedAt: toMaybeIso(row.appointmentCreatedAt),
      paymentStatus: coerceSqlBoolean(row.isPaid) ? "paid" : "unpaid",
      updatedAt: row.updatedAt.toISOString()
    }))
  });
});

app.get("/locations", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const limit = Math.min(Number(c.req.query("limit") ?? 200) || 200, 500);

  const filters = [];

  if (policy.kind === "legacy") {
    const hiddenLocationIds = await getHiddenLocationIdsForPolicy(db, policy);
    if (hiddenLocationIds.length > 0) {
      filters.push(notInArray(locations.id, hiddenLocationIds));
    }
  }

  let query = db
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
    .$dynamic();

  if (filters.length > 0) {
    query = query.where(and(...filters));
  }

  const rows = await query.orderBy(desc(locations.updatedAt)).limit(limit);

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

function buildAppointmentPaidSubquery(db: ReturnType<typeof createDb>) {
  const matchWhere = and(
    eq(invoices.locationId, appointments.locationId),
    eq(invoices.contactId, appointments.contactId),
    eq(invoices.isDeleted, false),
    sql`${appointments.contactId} is not null`,
    sql`${appointments.startTime} is not null`,
    sql`coalesce(${invoices.ghlUpdatedAt}, ${invoices.issueDate}, ${invoices.dueDate}, ${invoices.updatedAt}, ${invoices.createdAt})
        between coalesce(${appointments.dateAdded}, ${appointments.createdAt})
        and ${appointments.startTime}`,
    or(
      sql`lower(coalesce(${invoices.lastEventType}, '')) = 'invoicepaid'`,
      sql`lower(coalesce(${invoices.status}, '')) = 'paid'`,
      sql`(coalesce(${invoices.amountPaid}, 0) > 0 and coalesce(${invoices.total}, ${invoices.amountPaid}, 0) > 0 and ${invoices.amountPaid} >= coalesce(${invoices.total}, ${invoices.amountPaid}))`
    )
  );

  return db.select({ one: sql`1`.as("one") }).from(invoices).where(matchWhere);
}

function toMaybeIso(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value.toISOString() : null;
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : value;
  }

  return null;
}

function coerceSqlBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "t" || normalized === "1") {
      return true;
    }
    return false;
  }
  return Boolean(value);
}

app.get("/subaccounts/overview", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const viewerKey = policy.kind === "legacy" ? policy.viewerKey : policy.workspaceUserId;
  const surface = c.req.query("surface") ?? "all";

  const locationsQuery = db
    .select({
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name,
      agencyId: locations.agencyId,
      agencyName: agencies.name
    })
    .from(locations)
    .leftJoin(agencies, eq(locations.agencyId, agencies.id))
    .orderBy(locations.ghlLocationId);

  const visibilityLegacyPromise =
    policy.kind === "legacy"
      ? db
          .select({
            locationId: userSubaccountVisibilities.locationId,
            isVisible: userSubaccountVisibilities.isVisible
          })
          .from(userSubaccountVisibilities)
          .where(eq(userSubaccountVisibilities.userKey, policy.viewerKey))
      : Promise.resolve<{ locationId: string; isVisible: boolean }[]>([]);

  const jwtSelectionPromise =
    policy.kind === "jwt_workspace" ? fetchSelectionLocationRows(db, policy.workspaceUserId) : Promise.resolve([]);

  const includeConversationCounts = surface !== "appointments";

  const [
    locationRows,
    conversationRows,
    pendingRows,
    appointmentRows,
    visibilityRows,
    workspaceSelectionRows
  ] = await Promise.all([
    locationsQuery,
    includeConversationCounts
      ? db
          .select({
            locationId: threads.locationId,
            count: sql<number>`count(*)::int`
          })
          .from(threads)
          .groupBy(threads.locationId)
      : Promise.resolve([]),
    includeConversationCounts
      ? db
          .select({
            locationId: threads.locationId,
            count: sql<number>`count(*)::int`
          })
          .from(threads)
          .where(eq(threads.pendingReply, true))
          .groupBy(threads.locationId)
      : Promise.resolve([]),
    db
      .select({
        locationId: appointments.locationId,
        count: sql<number>`count(*)::int`
      })
      .from(appointments)
      .groupBy(appointments.locationId),
    visibilityLegacyPromise,
    jwtSelectionPromise
  ]);

  const conversationsByLocation = new Map(
    conversationRows.map((row) => [row.locationId, Number(row.count)])
  );
  const pendingByLocation = new Map(pendingRows.map((row) => [row.locationId, Number(row.count)]));
  const appointmentsByLocation = new Map(
    appointmentRows.map((row) => [row.locationId, Number(row.count)])
  );
  const visibilityByLocation = new Map(visibilityRows.map((row) => [row.locationId, row.isVisible]));
  const jwtSelectionNullable = rowsToNullableSelectionSet(workspaceSelectionRows);

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
      visible:
        policy.kind === "legacy"
          ? (visibilityByLocation.get(row.locationId) ?? true)
          : jwtSelectionNullable === null
            ? true
            : jwtSelectionNullable.has(row.locationId),
      implicitAllSelections: policy.kind === "jwt_workspace" && jwtSelectionNullable === null
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
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  if (policy.kind !== "legacy") {
    return c.json(
      {
        error: "forbidden_legacy_only",
        hint: "JWT workspace callers should PUT /workspace/me/location-selections with a replacement locationIds list."
      },
      403
    );
  }

  const viewerKey = policy.viewerKey;
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

  const [paymentsRow] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${invoices.amountPaid}), 0)::float`,
      currency: sql<string | null>`MAX(${invoices.currency})`
    })
    .from(invoices)
    .where(
      and(
        eq(invoices.locationId, threadRow.locationId),
        eq(invoices.contactId, threadRow.contactId),
        eq(invoices.isDeleted, false)
      )
    );

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
    contactDetails,
    paymentsSummary: {
      total: Number(paymentsRow?.total ?? 0),
      currency: paymentsRow?.currency ?? "USD"
    }
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

  let lastError: string | null = null;
  const trySendWithCurrentTokens = async () => {
    const accessTokens = await getAccessTokensForLocation(c.env, db, threadRow.ghlLocationId);
    if (accessTokens.length === 0) {
      return {
        ok: false as const,
        shouldRefreshToken: false,
        noTokens: true
      };
    }

    let shouldRefreshToken = false;
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
        shouldRefreshToken = shouldRefreshToken || sent.shouldRefreshToken;
        continue;
      }

      return {
        ok: true as const,
        sent
      };
    }

    return {
      ok: false as const,
      shouldRefreshToken,
      noTokens: false
    };
  };

  const initialAttempt = await trySendWithCurrentTokens();
  if (initialAttempt.noTokens) {
    return c.json({ error: "No GoHighLevel token available for this location" }, 400);
  }

  const successfulSend = initialAttempt.ok
    ? initialAttempt.sent
    : initialAttempt.shouldRefreshToken
      ? await (async () => {
          const refreshedCount = await refreshOAuthAccessTokensForLocation(c.env, db, threadRow.ghlLocationId);
          if (refreshedCount <= 0) {
            return null;
          }
          const retriedAttempt = await trySendWithCurrentTokens();
          if (retriedAttempt.ok) {
            return retriedAttempt.sent;
          }
          return null;
        })()
      : null;

  if (successfulSend) {
    const sentAt = new Date();
    const ghlMessageId = successfulSend.messageId ?? `outbound-${crypto.randomUUID()}`;
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
        raw: successfulSend.raw
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

app.get("/threads/:id/opportunities", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const threadId = c.req.param("id");
  const threadContext = await getThreadContextById(db, threadId);
  if (!threadContext) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const result = await fetchThreadOpportunitiesForContact(
    c.env,
    db,
    threadContext.ghlLocationId,
    threadContext.ghlContactId
  );

  if (!result.ok) {
    return c.json(
      {
        error: "Unable to load opportunities for this contact",
        details: result.error
      },
      502
    );
  }

  return c.json({
    opportunities: result.opportunities,
    stageOptions: result.stageOptions
  });
});

app.patch("/threads/:id/opportunities/:opportunityId", async (c) => {
  const db = createDb(c.env.DATABASE_URL);
  const threadId = c.req.param("id");
  const opportunityId = c.req.param("opportunityId");
  const body = asRecord(await c.req.json().catch(() => ({})));
  const stageId = stringOrNull(body.stageId ?? body.pipelineStageId);
  const status = normalizeOpportunityStatus(body.status ?? body.opportunityStatus);

  if (!stageId && !status) {
    return c.json({ error: "stageId or status is required" }, 400);
  }

  const threadContext = await getThreadContextById(db, threadId);
  if (!threadContext) {
    return c.json({ error: "Thread not found" }, 404);
  }

  const accessTokens = await getAccessTokensForLocation(c.env, db, threadContext.ghlLocationId);
  if (accessTokens.length === 0) {
    return c.json({ error: "No GoHighLevel token available for this location" }, 400);
  }

  let lastError: string | null = null;
  for (const accessToken of accessTokens) {
    const updated = await updateOpportunityWithToken(c.env, {
      accessToken,
      ghlLocationId: threadContext.ghlLocationId,
      opportunityId,
      stageId,
      status
    });
    if (!updated.ok) {
      lastError = updated.error ?? `status_${updated.status}`;
      continue;
    }

    const refreshed = await fetchThreadOpportunitiesWithToken(c.env, {
      accessToken,
      ghlLocationId: threadContext.ghlLocationId,
      ghlContactId: threadContext.ghlContactId
    });
    if (refreshed.ok) {
      return c.json({
        ok: true,
        opportunities: refreshed.opportunities,
        stageOptions: refreshed.stageOptions,
        updatedOpportunityId: opportunityId
      });
    }

    return c.json({
      ok: true,
      opportunities: [],
      stageOptions: [],
      updatedOpportunityId: opportunityId
    });
  }

  return c.json(
    {
      error: "Unable to update opportunity with available GoHighLevel token",
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

/** Legacy marketplace path; v2 uses version_id + client_id and must not set appId from version_id (breaks HL UI). */
function normalizeGhlMarketplaceInstallUrl(url: URL) {
  const hosts = new Set(["marketplace.gohighlevel.com", "marketplace.leadconnectorhq.com"]);
  if (!hosts.has(url.hostname)) {
    return;
  }
  if (url.pathname === "/oauth/chooselocation") {
    url.pathname = "/v2/oauth/chooselocation";
  }
}

function assertAllowedGhlMarketplaceHost(url: URL) {
  const host = url.hostname.toLowerCase();
  const ok = host === "marketplace.gohighlevel.com" || host === "marketplace.leadconnectorhq.com";
  if (!ok) {
    throw new Error(
      `Host must be marketplace.gohighlevel.com or marketplace.leadconnectorhq.com (got ${url.hostname})`
    );
  }
}

function prepareGhlOAuthRedirectFromPortalStartUrl(env: Env, rawPortalUrl: string, state: string): URL {
  const installUrl = new URL(rawPortalUrl.trim());
  normalizeGhlMarketplaceInstallUrl(installUrl);

  if (!getNonEmptyQueryParam(installUrl, "client_id") && env.GHL_CLIENT_ID?.trim()) {
    installUrl.searchParams.set("client_id", env.GHL_CLIENT_ID.trim());
  }
  if (!getNonEmptyQueryParam(installUrl, "scope")) {
    const scopeSource = env.GHL_OAUTH_SCOPE?.trim() ?? DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE;
    installUrl.searchParams.set("scope", normalizeGhlMarketplaceOAuthScope(scopeSource));
  }
  if (!getNonEmptyQueryParam(installUrl, "response_type")) {
    installUrl.searchParams.set("response_type", "code");
  }

  if (env.GHL_OAUTH_REDIRECT_URI?.trim()) {
    installUrl.searchParams.set("redirect_uri", env.GHL_OAUTH_REDIRECT_URI.trim());
  }

  if (!getNonEmptyQueryParam(installUrl, "user_type") && env.GHL_OAUTH_USER_TYPE?.trim()) {
    installUrl.searchParams.set("user_type", env.GHL_OAUTH_USER_TYPE.trim());
  }

  installUrl.searchParams.set("state", state);
  assertAllowedGhlMarketplaceHost(installUrl);
  return installUrl;
}

function prepareGhlOAuthRedirectFromLegacyInstallUrl(env: Env, rawInstallUrl: string, state: string): URL {
  const installUrl = new URL(rawInstallUrl);
  normalizeGhlMarketplaceInstallUrl(installUrl);

  let versionId =
    getNonEmptyQueryParam(installUrl, "versionId") ?? getNonEmptyQueryParam(installUrl, "version_id");
  if (!versionId && env.GHL_VERSION_ID?.trim()) {
    versionId = env.GHL_VERSION_ID.trim();
  }

  const clientId =
    getNonEmptyQueryParam(installUrl, "client_id") ?? env.GHL_CLIENT_ID?.trim() ?? null;

  const marketplaceAppId = getNonEmptyQueryParam(installUrl, "appId") ?? env.GHL_APP_ID?.trim() ?? null;

  if (!clientId) {
    throw new Error("Missing GoHighLevel OAuth client_id (set on GHL_INSTALL_URL or GHL_CLIENT_ID)");
  }

  installUrl.searchParams.set("client_id", clientId);
  if (marketplaceAppId) {
    installUrl.searchParams.set("appId", marketplaceAppId);
  }
  installUrl.searchParams.set("response_type", "code");

  installUrl.searchParams.delete("versionId");

  const existingScope = getNonEmptyQueryParam(installUrl, "scope");
  const scopeSource = existingScope ?? env.GHL_OAUTH_SCOPE?.trim() ?? DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE;
  installUrl.searchParams.set("scope", normalizeGhlMarketplaceOAuthScope(scopeSource));

  if (versionId) {
    installUrl.searchParams.set("version_id", versionId);
  }

  if (!getNonEmptyQueryParam(installUrl, "user_type") && env.GHL_OAUTH_USER_TYPE?.trim()) {
    installUrl.searchParams.set("user_type", env.GHL_OAUTH_USER_TYPE.trim());
  }

  installUrl.searchParams.set("state", state);

  if (env.GHL_OAUTH_REDIRECT_URI) {
    installUrl.searchParams.set("redirect_uri", env.GHL_OAUTH_REDIRECT_URI);
  }

  assertAllowedGhlMarketplaceHost(installUrl);
  return installUrl;
}

async function loadEstablishedGhlCompanyIds(db: ReturnType<typeof createDb>): Promise<Set<string>> {
  const ids = new Set<string>();
  const agencyRows = await db.select({ ghlAgencyId: agencies.ghlAgencyId }).from(agencies);
  for (const row of agencyRows) {
    const v = row.ghlAgencyId?.trim();
    if (v) {
      ids.add(v);
    }
  }
  const oauthRows = await db.select({ companyId: ghlOAuthInstallations.companyId }).from(ghlOAuthInstallations);
  for (const row of oauthRows) {
    const v = row.companyId?.trim();
    if (v) {
      ids.add(v);
    }
  }
  return ids;
}

type WebhookMirrorRecord = {
  idempotencyKey: string;
  webhookType: string;
  category: WebhookMirrorCategory;
  companyId: string | null;
  locationId: string | null;
  contactId: string | null;
  entityId: string | null;
  eventTimestamp: Date | null;
  payload: unknown;
  headers: Record<string, string>;
  rawBody: string;
};

async function buildWebhookMirrorRecord(args: {
  payload: unknown;
  rawBody: string;
  headers: Headers;
  webhookType?: string;
  fallbackCategory?: WebhookMirrorCategory;
}): Promise<WebhookMirrorRecord> {
  const payloadRecord = asRecord(args.payload);
  const webhookType =
    args.webhookType ??
    firstNonEmptyString(
      stringOrNull(payloadRecord.type),
      stringOrNull(payloadRecord.event),
      stringOrNull(payloadRecord.eventType),
      "unknown"
    ) ??
    "unknown";
  const category = args.fallbackCategory ?? mapWebhookTypeToMirrorCategory(webhookType);
  const explicitIdempotency =
    getWebhookIdempotencyHeader(args.headers) ??
    firstNonEmptyString(
      stringOrNull(payloadRecord.idempotencyKey),
      stringOrNull(payloadRecord.webhookId),
      stringOrNull(payloadRecord.eventId)
    );
  const idempotencyKey = explicitIdempotency ?? `${webhookType}:${await sha256Hex(args.rawBody)}`;

  const message = asRecord(payloadRecord.message ?? payloadRecord.messageData);
  const appointment = asRecord(payloadRecord.appointment);
  const invoice = asRecord(payloadRecord.invoice);
  const contact = asRecord(payloadRecord.contact ?? message.contact ?? appointment.contact ?? invoice.contact);
  const location = asRecord(payloadRecord.location ?? appointment.location ?? invoice.location);
  const company = asRecord(payloadRecord.company ?? payloadRecord.agency);
  const note = asRecord(payloadRecord.note);
  const opportunity = asRecord(payloadRecord.opportunity);
  const task = asRecord(payloadRecord.task);
  const user = asRecord(payloadRecord.user);
  const order = asRecord(payloadRecord.order);
  const product = asRecord(payloadRecord.product);
  const price = asRecord(payloadRecord.price);
  const relation = asRecord(payloadRecord.relation);
  const record = asRecord(payloadRecord.record);
  const objectSchema = asRecord(payloadRecord.objectSchema ?? payloadRecord.object_schema);

  const companyId = firstNonEmptyString(
    stringOrNull(payloadRecord.companyId),
    stringOrNull(payloadRecord.agencyId),
    stringOrNull(payloadRecord.company_id),
    stringOrNull(payloadRecord.agency_id),
    stringOrNull(company.id)
  );
  const locationId = firstNonEmptyString(
    stringOrNull(payloadRecord.locationId),
    stringOrNull(payloadRecord.location_id),
    stringOrNull(location.id),
    stringOrNull(message.locationId),
    stringOrNull(appointment.locationId),
    stringOrNull(invoice.locationId),
    stringOrNull(opportunity.locationId),
    stringOrNull(task.locationId),
    stringOrNull(contact.locationId)
  );
  const contactId = firstNonEmptyString(
    stringOrNull(payloadRecord.contactId),
    stringOrNull(payloadRecord.contact_id),
    stringOrNull(contact.id),
    stringOrNull(message.contactId),
    stringOrNull(appointment.contactId),
    stringOrNull(invoice.contactId),
    stringOrNull(opportunity.contactId),
    stringOrNull(task.contactId)
  );
  const entityId = firstNonEmptyString(
    stringOrNull(payloadRecord.id),
    stringOrNull(payloadRecord.messageId),
    stringOrNull(payloadRecord.appointmentId),
    stringOrNull(payloadRecord.invoiceId),
    stringOrNull(payloadRecord.noteId),
    stringOrNull(payloadRecord.opportunityId),
    stringOrNull(payloadRecord.taskId),
    stringOrNull(payloadRecord.userId),
    stringOrNull(payloadRecord.orderId),
    stringOrNull(payloadRecord.productId),
    stringOrNull(payloadRecord.priceId),
    stringOrNull(payloadRecord.recordId),
    stringOrNull(payloadRecord.relationId),
    stringOrNull(message.id),
    stringOrNull(appointment.id),
    stringOrNull(invoice.id),
    stringOrNull(note.id),
    stringOrNull(opportunity.id),
    stringOrNull(task.id),
    stringOrNull(user.id),
    stringOrNull(order.id),
    stringOrNull(product.id),
    stringOrNull(price.id),
    stringOrNull(record.id),
    stringOrNull(relation.id),
    stringOrNull(objectSchema.id)
  );
  const eventTimestamp = parseNullableDate(
    payloadRecord.timestamp ??
      payloadRecord.timeStamp ??
      payloadRecord.eventTimestamp ??
      payloadRecord.dateAdded ??
      payloadRecord.dateUpdated ??
      payloadRecord.createdAt ??
      payloadRecord.updatedAt ??
      message.dateAdded ??
      message.dateUpdated ??
      appointment.dateAdded ??
      appointment.dateUpdated ??
      invoice.createdAt ??
      invoice.updatedAt ??
      note.createdAt ??
      note.updatedAt ??
      opportunity.dateUpdated ??
      task.updatedAt
  );

  return {
    idempotencyKey,
    webhookType,
    category,
    companyId,
    locationId,
    contactId,
    entityId,
    eventTimestamp,
    payload: payloadRecord,
    headers: headersToRecord(args.headers),
    rawBody: args.rawBody
  };
}

async function persistWebhookMirrorRecord(db: ReturnType<typeof createDb>, record: WebhookMirrorRecord) {
  const now = new Date();
  const commonValues = {
    idempotencyKey: record.idempotencyKey,
    webhookType: record.webhookType,
    companyId: record.companyId,
    locationId: record.locationId,
    contactId: record.contactId,
    entityId: record.entityId,
    eventTimestamp: record.eventTimestamp,
    payload: record.payload,
    headers: record.headers,
    rawBody: record.rawBody,
    updatedAt: now
  };

  await db
    .insert(ghlWebhookMirrorEvents)
    .values({
      ...commonValues
    })
    .onConflictDoUpdate({
      target: [ghlWebhookMirrorEvents.idempotencyKey],
      set: {
        ...commonValues
      }
    });

  const categoryTable = mirrorTableByCategory[record.category];
  await db
    .insert(categoryTable)
    .values({
      ...commonValues
    })
    .onConflictDoUpdate({
      target: [categoryTable.idempotencyKey],
      set: {
        ...commonValues
      }
    });
}

function mapWebhookTypeToMirrorCategory(webhookType: string): WebhookMirrorCategory {
  const normalized = webhookType.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized.startsWith("appinstall") || normalized.startsWith("appuninstall") || normalized.startsWith("appupdate") || normalized.startsWith("planchange")) {
    return "app";
  }
  if (normalized.startsWith("appointment")) {
    return "appointment";
  }
  if (normalized.startsWith("association")) {
    return "association";
  }
  if (normalized.startsWith("campaign")) {
    return "campaign";
  }
  if (normalized.startsWith("contact")) {
    return "contact";
  }
  if (
    normalized.startsWith("conversation") ||
    normalized === "inboundmessage" ||
    normalized === "outboundmessage" ||
    normalized === "provideroutboundmessage"
  ) {
    return "conversation";
  }
  if (normalized.startsWith("externalauth")) {
    return "external_auth";
  }
  if (normalized.startsWith("invoice")) {
    return "invoice";
  }
  if (normalized === "lcemailstats") {
    return "email_stats";
  }
  if (normalized.startsWith("location")) {
    return "location";
  }
  if (normalized.startsWith("note")) {
    return "note";
  }
  if (normalized.startsWith("objectschema")) {
    return "object_schema";
  }
  if (normalized.startsWith("opportunity")) {
    return "opportunity";
  }
  if (normalized.startsWith("order")) {
    return "order";
  }
  if (normalized.startsWith("price")) {
    return "price";
  }
  if (normalized.startsWith("product")) {
    return "product";
  }
  if (normalized.startsWith("record")) {
    return "record";
  }
  if (normalized.startsWith("relation")) {
    return "relation";
  }
  if (normalized.startsWith("saasplan")) {
    return "saas_plan";
  }
  if (normalized.startsWith("task")) {
    return "task";
  }
  if (normalized.startsWith("user")) {
    return "user";
  }
  if (normalized.startsWith("voiceai")) {
    return "voice_ai";
  }
  return "misc";
}

async function processWebhookEvent(env: Env, event: NormalizedGhlWebhookEvent) {
  if (event.kind === "message") {
    await markWebhookEventProcessed(env, event.idempotencyKey);
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

async function markWebhookEventProcessed(env: Env, idempotencyKey: string) {
  const db = createDb(env.DATABASE_URL);
  await db
    .update(webhookEvents)
    .set({ status: "processed", processedAt: new Date(), error: null })
    .where(eq(webhookEvents.idempotencyKey, idempotencyKey));
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

async function findStoredContactForInvoice(
  db: ReturnType<typeof createDb>,
  locationId: string,
  email: string | null,
  phone: string | null
) {
  const identityFilters = [];
  if (email) {
    identityFilters.push(sql`LOWER(${contacts.email}) = ${email.toLowerCase()}`);
  }
  if (phone) {
    identityFilters.push(eq(contacts.phone, phone));
  }

  if (identityFilters.length === 0) {
    return null;
  }

  const identityFilter = identityFilters.length === 1 ? identityFilters[0] : or(...identityFilters);
  const [storedContact] = await db
    .select({
      id: contacts.id,
      ghlContactId: contacts.ghlContactId
    })
    .from(contacts)
    .where(and(eq(contacts.locationId, locationId), identityFilter))
    .limit(1);

  return storedContact ?? null;
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
  const inferredContactPhone = getContactPhoneFromMessageDirection(
    event.message.direction,
    event.message.from ?? null,
    event.message.to ?? null
  );
  const inferredContactEmail = inferEmailAddress(event.message.from ?? null, event.message.to ?? null);

  const [contact] = await db
    .insert(contacts)
    .values({
      locationId: location.id,
      ghlContactId: event.contact.ghlContactId,
      firstName: event.contact.firstName ?? contactProfile?.firstName ?? null,
      lastName: event.contact.lastName ?? contactProfile?.lastName ?? null,
      email: event.contact.email ?? contactProfile?.email ?? inferredContactEmail ?? null,
      phone: event.contact.phone ?? contactProfile?.phone ?? inferredContactPhone ?? null,
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
  let ghlContactId = event.contact.ghlContactId;
  let contactProfile: ContactProfileOnDemand | null = null;

  if (!ghlContactId) {
    const storedContact = await findStoredContactForInvoice(
      db,
      location.id,
      event.contact.email,
      event.contact.phone
    );
    if (storedContact) {
      contactId = storedContact.id;
      ghlContactId = storedContact.ghlContactId;
    }
  }

  if (!ghlContactId) {
    contactProfile = await fetchContactProfileByIdentityOnDemand(
      env,
      db,
      event.location.ghlLocationId,
      event.contact.email,
      event.contact.phone
    );
    ghlContactId = contactProfile?.id ?? null;
  }

  if (ghlContactId) {
    const nameParts = splitContactName(event.contact.name);
    contactProfile =
      contactProfile ??
      (await fetchContactProfileForWebhookIfNeeded(env, db, location.id, event.location.ghlLocationId, ghlContactId, {
        firstName: nameParts.firstName,
        lastName: nameParts.lastName,
        email: event.contact.email,
        phone: event.contact.phone
      }));
    const [contact] = await db
      .insert(contacts)
      .values({
        locationId: location.id,
        ghlContactId,
        firstName: nameParts.firstName ?? contactProfile?.firstName ?? null,
        lastName: nameParts.lastName ?? contactProfile?.lastName ?? null,
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
type ContactProfileFetchResult = {
  profile: ContactProfileOnDemand | null;
  error: string | null;
  shouldRefreshToken: boolean;
};

async function fetchContactProfileOnDemand(
  env: Env,
  db: ReturnType<typeof createDb>,
  ghlLocationId: string,
  ghlContactId: string
): Promise<ContactProfileOnDemand | null> {
  const tryWithCurrentTokens = async (): Promise<ContactProfileFetchResult> => {
    const accessTokens = await getAccessTokensForLocation(env, db, ghlLocationId);
    let lastError: string | null = null;
    let shouldRefreshToken = false;

    for (const accessToken of accessTokens) {
      const result = await fetchContactProfileWithToken(env, ghlLocationId, ghlContactId, accessToken);
      if (result.profile) {
        return result;
      }
      if (result.error) {
        lastError = result.error;
      }
      shouldRefreshToken = shouldRefreshToken || result.shouldRefreshToken;
    }

    return {
      profile: null,
      error: lastError,
      shouldRefreshToken
    };
  };

  const initialAttempt = await tryWithCurrentTokens();
  if (initialAttempt.profile) {
    return initialAttempt.profile;
  }

  if (!initialAttempt.shouldRefreshToken) {
    return null;
  }

  const refreshedCount = await refreshOAuthAccessTokensForLocation(env, db, ghlLocationId);
  if (refreshedCount <= 0) {
    return null;
  }

  const retriedAttempt = await tryWithCurrentTokens();
  return retriedAttempt.profile;
}

async function fetchContactProfileByIdentityOnDemand(
  env: Env,
  db: ReturnType<typeof createDb>,
  ghlLocationId: string,
  email: string | null,
  phone: string | null
): Promise<ContactProfileOnDemand | null> {
  if (!email && !phone) {
    return null;
  }

  const tryWithCurrentTokens = async (): Promise<ContactProfileFetchResult> => {
    const accessTokens = await getAccessTokensForLocation(env, db, ghlLocationId);
    let lastError: string | null = null;
    let shouldRefreshToken = false;

    for (const accessToken of accessTokens) {
      const result = await fetchContactProfileByIdentityWithToken(env, ghlLocationId, email, phone, accessToken);
      if (result.profile) {
        return result;
      }
      if (result.error) {
        lastError = result.error;
      }
      shouldRefreshToken = shouldRefreshToken || result.shouldRefreshToken;
    }

    return {
      profile: null,
      error: lastError,
      shouldRefreshToken
    };
  };

  const initialAttempt = await tryWithCurrentTokens();
  if (initialAttempt.profile) {
    return initialAttempt.profile;
  }

  if (!initialAttempt.shouldRefreshToken) {
    return null;
  }

  const refreshedCount = await refreshOAuthAccessTokensForLocation(env, db, ghlLocationId);
  if (refreshedCount <= 0) {
    return null;
  }

  const retriedAttempt = await tryWithCurrentTokens();
  return retriedAttempt.profile;
}

async function fetchContactProfileByIdentityWithToken(
  env: Env,
  ghlLocationId: string,
  email: string | null,
  phone: string | null,
  accessToken: string
): Promise<ContactProfileFetchResult> {
  try {
    const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
    const requestUrl = new URL("/contacts/search/duplicate", baseUrl);
    requestUrl.searchParams.set("locationId", ghlLocationId);
    if (email) {
      requestUrl.searchParams.set("email", email);
    }
    if (phone) {
      requestUrl.searchParams.set("phone", phone);
    }

    const response = await fetch(requestUrl.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        Version: "2021-07-28",
        "Location-Id": ghlLocationId,
        locationId: ghlLocationId
      }
    });

    if (!response.ok) {
      const parsedError = asRecord(await response.json().catch(() => ({})));
      const responseError =
        stringOrNull(parsedError.message ?? parsedError.error ?? parsedError.error_description) ??
        response.statusText;
      return {
        profile: null,
        error: responseError,
        shouldRefreshToken: isTokenError(responseError) || response.status === 401 || response.status === 403
      };
    }

    const data = asRecord(await response.json());
    const contact = asRecord(data.contact ?? data.contacts?.[0] ?? data);
    const ghlContactId = stringOrNull(contact.id ?? contact.contactId);
    if (!ghlContactId) {
      return { profile: null, error: null, shouldRefreshToken: false };
    }

    const firstName = stringOrNull(contact.firstName);
    const lastName = stringOrNull(contact.lastName);
    const contactEmail = stringOrNull(contact.email) ?? email;
    const contactPhone = stringOrNull(contact.phone) ?? phone;
    return {
      profile: {
        id: ghlContactId,
        firstName,
        lastName,
        fullName: firstNonEmptyString(
          stringOrNull(contact.name),
          stringOrNull(contact.contactName),
          formatContactName(firstName, lastName, contactEmail, contactPhone)
        ),
        email: contactEmail,
        phone: contactPhone,
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
      },
      error: null,
      shouldRefreshToken: false
    };
  } catch (error) {
    console.warn("Failed to search GoHighLevel contact by payment identity", error);
    const message = error instanceof Error ? error.message : "request_failed";
    return {
      profile: null,
      error: message,
      shouldRefreshToken: isTokenError(message)
    };
  }
}

async function fetchContactProfileWithToken(
  env: Env,
  ghlLocationId: string,
  ghlContactId: string,
  accessToken: string
): Promise<ContactProfileFetchResult> {
  try {
    const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
    const requestAttempts = [
      {
        endpoint: `${baseUrl}/contacts/${encodeURIComponent(ghlContactId)}?locationId=${encodeURIComponent(ghlLocationId)}`,
        version: "2021-07-28"
      },
      {
        endpoint: `${baseUrl}/contacts/${encodeURIComponent(ghlContactId)}?location_id=${encodeURIComponent(ghlLocationId)}`,
        version: "2021-07-28"
      },
      {
        endpoint: `${baseUrl}/contacts/${encodeURIComponent(ghlContactId)}?locationId=${encodeURIComponent(ghlLocationId)}`,
        version: "2021-04-15"
      },
      {
        endpoint: `${baseUrl}/contacts/${encodeURIComponent(ghlContactId)}`,
        version: "2021-07-28"
      }
    ];
    let lastError: string | null = null;
    let shouldRefreshToken = false;

    for (const request of requestAttempts) {
      const response = await fetch(request.endpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Version: request.version,
          "Location-Id": ghlLocationId,
          locationId: ghlLocationId
        }
      });

      if (!response.ok) {
        const parsedError = asRecord(await response.json().catch(() => ({})));
        const responseError =
          stringOrNull(parsedError.message ?? parsedError.error ?? parsedError.error_description) ??
          response.statusText;
        lastError = responseError;
        shouldRefreshToken =
          shouldRefreshToken ||
          isTokenError(responseError) ||
          response.status === 401 ||
          response.status === 403;
        continue;
      }

      const data = asRecord(await response.json());
      const contact = asRecord(data.contact ?? data);
      const firstName = stringOrNull(contact.firstName);
      const lastName = stringOrNull(contact.lastName);
      const email = stringOrNull(contact.email);
      const phone = stringOrNull(contact.phone);
      return {
        profile: {
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
        },
        error: null,
        shouldRefreshToken: false
      };
    }
    return {
      profile: null,
      error: lastError,
      shouldRefreshToken
    };
  } catch (error) {
    console.warn("Failed to fetch GoHighLevel contact details", error);
    const message = error instanceof Error ? error.message : "request_failed";
    return {
      profile: null,
      error: message,
      shouldRefreshToken: isTokenError(message)
    };
  }
}

function isTokenError(value: string | null | undefined) {
  const normalized = value?.toLowerCase() ?? "";
  return (
    normalized.includes("invalid jwt") ||
    normalized.includes("invalid token") ||
    normalized.includes("unauthorized") ||
    normalized.includes("token expired")
  );
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
      raw: messages.raw,
      direction: messages.direction,
      from: messages.from,
      to: messages.to
    })
    .from(messages)
    .where(eq(messages.contactId, contactId))
    .orderBy(desc(messages.sentAt))
    .limit(1);

  if (!latestMessage) {
    return null;
  }

  return extractContactIdentityFromMessage({
    raw: latestMessage.raw,
    direction: latestMessage.direction,
    from: latestMessage.from,
    to: latestMessage.to
  });
}

async function getLatestMessageIdentityByContactId(
  db: ReturnType<typeof createDb>,
  contactIds: string[]
) {
  const uniqueContactIds = Array.from(new Set(contactIds));
  if (uniqueContactIds.length === 0) {
    return new Map<string, { firstName: string | null; lastName: string | null; email: string | null; phone: string | null }>();
  }

  const latestMessages = await db
    .select({
      contactId: messages.contactId,
      raw: messages.raw,
      direction: messages.direction,
      from: messages.from,
      to: messages.to
    })
    .from(messages)
    .where(inArray(messages.contactId, uniqueContactIds))
    .orderBy(desc(messages.sentAt));

  const identityMap = new Map<
    string,
    { firstName: string | null; lastName: string | null; email: string | null; phone: string | null }
  >();
  for (const message of latestMessages) {
    if (identityMap.has(message.contactId)) {
      continue;
    }
    const identity = extractContactIdentityFromMessage({
      raw: message.raw,
      direction: message.direction,
      from: message.from,
      to: message.to
    });
    if (identity) {
      identityMap.set(message.contactId, identity);
    }
  }

  return identityMap;
}

function extractContactIdentityFromMessage(message: {
  raw: unknown;
  direction: MessageDirection;
  from: string | null;
  to: string | null;
}): { firstName: string | null; lastName: string | null; email: string | null; phone: string | null } | null {
  const raw = asRecord(message.raw);
  const rawMessage = asRecord(raw.message ?? raw.messageData ?? raw.payload?.message);
  const rawContact = asRecord(
    raw.contact ??
      rawMessage.contact ??
      raw.messageData?.contact ??
      raw.payload?.contact ??
      raw.contactDetails
  );
  const rawName = stringOrNull(
    raw.contactName ??
      rawContact.name ??
      rawContact.fullName ??
      rawMessage.contactName ??
      rawMessage.fullName ??
      raw.name
  );
  const splitRawName = splitContactName(rawName);
  const firstName = stringOrNull(
    rawContact.firstName ?? raw.firstName ?? rawMessage.firstName ?? splitRawName.firstName
  );
  const lastName = stringOrNull(
    rawContact.lastName ?? raw.lastName ?? rawMessage.lastName ?? splitRawName.lastName
  );
  const email =
    stringOrNull(
      rawContact.email ??
        raw.email ??
        rawMessage.email ??
        rawContact.emailAddress ??
        rawMessage.emailAddress
    ) ?? inferEmailAddress(message.from, message.to);
  const phone =
    stringOrNull(rawContact.phone ?? raw.phone ?? rawMessage.phone ?? rawContact.phoneNumber) ??
    getContactPhoneFromMessageDirection(message.direction, message.from, message.to);

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
  const tokenCandidates = new Set<string>();
  const addTokenCandidate = (value: string | null | undefined) => {
    const token = value?.trim();
    if (token) {
      tokenCandidates.add(token);
    }
  };
  const isStillValid = (expiresAt: Date | null | undefined) => {
    if (!expiresAt) {
      return true;
    }
    return expiresAt.getTime() > Date.now() + 60_000;
  };

  const locationInstallations = await db
    .select({
      accessToken: ghlOAuthInstallations.accessToken,
      expiresAt: ghlOAuthInstallations.expiresAt
    })
    .from(ghlOAuthInstallations)
    .where(
      and(
        eq(ghlOAuthInstallations.locationId, ghlLocationId),
        eq(ghlOAuthInstallations.userType, "Location")
      )
    )
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(5);
  for (const installation of locationInstallations) {
    if (isStillValid(installation.expiresAt)) {
      addTokenCandidate(installation.accessToken);
    }
  }

  const companyInstallations = [
    ...(await getCompanyOAuthInstallationsForLocation(db, ghlLocationId)),
    ...(await getRecentCompanyOAuthInstallations(db, 5))
  ];
  const seenCompanyTokens = new Set<string>();
  for (const installation of companyInstallations) {
    const companyToken = installation.accessToken?.trim();
    if (!companyToken || seenCompanyTokens.has(companyToken)) {
      continue;
    }
    seenCompanyTokens.add(companyToken);

    const locationToken = await exchangeLocationAccessTokenFromCompanyToken(env, {
      companyId: installation.companyId,
      ghlLocationId,
      companyAccessToken: companyToken
    });
    if (!locationToken) {
      continue;
    }

    addTokenCandidate(locationToken.accessToken);
    await upsertLocationOAuthInstallationFromExchange(db, {
      companyId: installation.companyId,
      ghlLocationId,
      fallbackRefreshToken: installation.refreshToken,
      token: locationToken
    });
  }

  if (tokenCandidates.size === 0) {
    // Last-resort fallback for legacy setups where only company tokens were stored.
    for (const installation of companyInstallations) {
      addTokenCandidate(installation.accessToken);
    }
  }

  addTokenCandidate(env.GHL_API_TOKEN?.trim());
  return Array.from(tokenCandidates);
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
  const [installation] = await getCompanyOAuthInstallationsForLocation(db, ghlLocationId);
  return installation ?? null;
}

async function getCompanyOAuthInstallationsForLocation(
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
    return [];
  }

  return db
    .select({
      companyId: ghlOAuthInstallations.companyId,
      locationId: ghlOAuthInstallations.locationId,
      userType: ghlOAuthInstallations.userType,
      accessToken: ghlOAuthInstallations.accessToken,
      refreshToken: ghlOAuthInstallations.refreshToken,
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
    .limit(5);
}

async function getRecentCompanyOAuthInstallations(db: ReturnType<typeof createDb>, limit = 5) {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return db
    .select({
      companyId: ghlOAuthInstallations.companyId,
      locationId: ghlOAuthInstallations.locationId,
      userType: ghlOAuthInstallations.userType,
      accessToken: ghlOAuthInstallations.accessToken,
      refreshToken: ghlOAuthInstallations.refreshToken,
      expiresAt: ghlOAuthInstallations.expiresAt,
      updatedAt: ghlOAuthInstallations.updatedAt
    })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.userType, "Company"))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(safeLimit);
}

async function exchangeLocationAccessTokenFromCompanyToken(
  env: Env,
  params: {
    companyId: string;
    ghlLocationId: string;
    companyAccessToken: string;
  }
) {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const requestBody = new URLSearchParams({
    companyId: params.companyId,
    locationId: params.ghlLocationId
  });

  try {
    const response = await fetch(`${baseUrl}/oauth/locationToken`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.companyAccessToken}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Version: "2021-07-28"
      },
      body: requestBody.toString()
    });
    const raw = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      return null;
    }

    const accessToken = stringOrNull(raw.access_token ?? raw.accessToken);
    if (!accessToken) {
      return null;
    }

    return {
      accessToken,
      refreshToken: stringOrNull(raw.refresh_token ?? raw.refreshToken),
      tokenType: stringOrNull(raw.token_type ?? raw.tokenType) ?? "Bearer",
      expiresIn: Number(raw.expires_in ?? raw.expiresIn ?? 86400),
      scope: stringOrNull(raw.scope),
      userId: stringOrNull(raw.userId ?? raw.user_id),
      raw
    };
  } catch {
    return null;
  }
}

async function upsertLocationOAuthInstallationFromExchange(
  db: ReturnType<typeof createDb>,
  params: {
    companyId: string;
    ghlLocationId: string;
    fallbackRefreshToken: string | null;
    token: {
      accessToken: string;
      refreshToken: string | null;
      tokenType: string;
      expiresIn: number;
      scope: string | null;
      userId: string | null;
      raw: Record<string, any>;
    };
  }
) {
  const now = new Date();
  let refreshToken = params.token.refreshToken ?? params.fallbackRefreshToken;
  if (!refreshToken) {
    const [existing] = await db
      .select({
        refreshToken: ghlOAuthInstallations.refreshToken
      })
      .from(ghlOAuthInstallations)
      .where(
        and(
          eq(ghlOAuthInstallations.companyId, params.companyId),
          eq(ghlOAuthInstallations.locationId, params.ghlLocationId),
          eq(ghlOAuthInstallations.userType, "Location")
        )
      )
      .limit(1);
    refreshToken = existing?.refreshToken ?? null;
  }
  if (!refreshToken) {
    return;
  }

  const values = {
    companyId: params.companyId,
    locationId: params.ghlLocationId,
    userId: params.token.userId,
    userType: "Location" as const,
    accessToken: params.token.accessToken,
    refreshToken,
    tokenType: params.token.tokenType,
    scope: params.token.scope,
    refreshTokenId: stringOrNull(
      params.token.raw.refreshTokenId ?? params.token.raw.refresh_token_id
    ),
    expiresAt: addSecondsToNow(params.token.expiresIn),
    raw: params.token.raw,
    updatedAt: now
  };

  await db
    .insert(ghlOAuthInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: [
        ghlOAuthInstallations.companyId,
        ghlOAuthInstallations.locationId,
        ghlOAuthInstallations.userType
      ],
      set: values
    });
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
): Promise<{
  ok: boolean;
  status: number;
  messageId: string | null;
  raw: unknown;
  error: string | null;
  shouldRefreshToken: boolean;
}> {
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

  const requestVersions = ["2023-02-21", "2021-07-28", "2021-04-15"];
  let lastError: string | null = null;
  let shouldRefreshToken = false;
  let lastStatus = 0;

  for (const requestVersion of requestVersions) {
    try {
      const response = await fetch(`${baseUrl}/conversations/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: requestVersion,
          "Location-Id": params.ghlLocationId,
          locationId: params.ghlLocationId
        },
        body: JSON.stringify(payload)
      });
      const rawBody = await response.text();
      const parsed = asRecord(safeJsonParse(rawBody) ?? {});
      const parsedError =
        stringOrNull(parsed.message ?? parsed.error ?? parsed.error_description) ?? response.statusText;
      if (!response.ok) {
        lastError = parsedError;
        lastStatus = response.status;
        shouldRefreshToken =
          shouldRefreshToken ||
          response.status === 401 ||
          response.status === 403 ||
          isTokenError(parsedError);
        continue;
      }
      return {
        ok: response.ok,
        status: response.status,
        messageId: stringOrNull(parsed.messageId ?? parsed.id ?? parsed.message?.id ?? parsed.msgId),
        raw: {
          request: payload,
          response: parsed,
          responseRawBody: rawBody
        },
        error: null,
        shouldRefreshToken: false
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request_failed";
      lastStatus = 0;
      shouldRefreshToken = shouldRefreshToken || isTokenError(lastError);
    }
  }

  return {
    ok: false,
    status: lastStatus,
    messageId: null,
    raw: { request: payload },
    error: lastError,
    shouldRefreshToken
  };
}

async function getThreadContextById(db: ReturnType<typeof createDb>, threadId: string) {
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

  return threadRow ?? null;
}

async function fetchThreadOpportunitiesForContact(
  env: Env,
  db: ReturnType<typeof createDb>,
  ghlLocationId: string,
  ghlContactId: string
): Promise<{
  ok: boolean;
  opportunities: ThreadOpportunity[];
  stageOptions: OpportunityStageOption[];
  error: string | null;
}> {
  const tryWithCurrentTokens = async () => {
    const accessTokens = await getAccessTokensForLocation(env, db, ghlLocationId);
    if (accessTokens.length === 0) {
      return {
        ok: false as const,
        opportunities: [] as ThreadOpportunity[],
        stageOptions: [] as OpportunityStageOption[],
        error: "No GoHighLevel token available for this location"
      };
    }

    let lastError: string | null = null;
    for (const accessToken of accessTokens) {
      const result = await fetchThreadOpportunitiesWithToken(env, {
        accessToken,
        ghlLocationId,
        ghlContactId
      });
      if (result.ok) {
        return result;
      }
      lastError = result.error;
    }

    return {
      ok: false as const,
      opportunities: [] as ThreadOpportunity[],
      stageOptions: [] as OpportunityStageOption[],
      error: lastError
    };
  };

  const initialAttempt = await tryWithCurrentTokens();
  if (initialAttempt.ok) {
    return initialAttempt;
  }

  const normalizedError = initialAttempt.error?.toLowerCase() ?? "";
  const shouldRefresh = normalizedError.includes("jwt") || normalizedError.includes("token");
  if (!shouldRefresh) {
    return initialAttempt;
  }

  const refreshedCount = await refreshOAuthAccessTokensForLocation(env, db, ghlLocationId);
  if (refreshedCount <= 0) {
    return initialAttempt;
  }

  const retriedAttempt = await tryWithCurrentTokens();
  if (retriedAttempt.ok) {
    return retriedAttempt;
  }

  return retriedAttempt;
}

async function fetchThreadOpportunitiesWithToken(
  env: Env,
  params: {
    accessToken: string;
    ghlLocationId: string;
    ghlContactId: string;
  }
): Promise<{
  ok: boolean;
  opportunities: ThreadOpportunity[];
  stageOptions: OpportunityStageOption[];
  error: string | null;
}> {
  const opportunitiesResult = await fetchContactOpportunitiesWithToken(env, params);
  if (!opportunitiesResult.ok) {
    return {
      ok: false,
      opportunities: [],
      stageOptions: [],
      error: opportunitiesResult.error
    };
  }

  const pipelinesResult = await fetchOpportunityPipelinesWithToken(env, params.accessToken, params.ghlLocationId);
  const stageOptions = pipelinesResult.ok ? pipelinesResult.stageOptions : [];
  return {
    ok: true,
    opportunities: normalizeThreadOpportunities(opportunitiesResult.opportunitiesRaw, stageOptions),
    stageOptions,
    error: null
  };
}

async function fetchContactOpportunitiesWithToken(
  env: Env,
  params: {
    accessToken: string;
    ghlLocationId: string;
    ghlContactId: string;
  }
): Promise<{ ok: boolean; opportunitiesRaw: unknown[]; error: string | null }> {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const attempts: Array<{
    method: "POST" | "GET";
    endpoint: string;
    body: Record<string, unknown> | null;
    version: string;
  }> = [
    {
      method: "POST",
      endpoint: `${baseUrl}/opportunities/search`,
      body: {
        locationId: params.ghlLocationId,
        contactId: params.ghlContactId
      },
      version: "2023-02-21"
    },
    {
      method: "POST",
      endpoint: `${baseUrl}/opportunities/search`,
      body: {
        location_id: params.ghlLocationId,
        contact_id: params.ghlContactId
      },
      version: "2023-02-21"
    },
    {
      method: "GET",
      endpoint: `${baseUrl}/opportunities/search?locationId=${encodeURIComponent(params.ghlLocationId)}&contactId=${encodeURIComponent(params.ghlContactId)}`,
      body: null,
      version: "2023-02-21"
    },
    {
      method: "GET",
      endpoint: `${baseUrl}/opportunities/search?location_id=${encodeURIComponent(params.ghlLocationId)}&contact_id=${encodeURIComponent(params.ghlContactId)}`,
      body: null,
      version: "2023-02-21"
    }
  ];

  let lastError: string | null = null;
  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.endpoint, {
        method: attempt.method,
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: attempt.version,
          "Location-Id": params.ghlLocationId,
          locationId: params.ghlLocationId
        },
        body: attempt.body ? JSON.stringify(attempt.body) : undefined
      });
      const rawBody = await response.text();
      const parsed = safeJsonParse(rawBody);
      if (!response.ok) {
        const errorPayload = asRecord(parsed ?? {});
        lastError =
          stringOrNull(errorPayload.message ?? errorPayload.error ?? errorPayload.error_description) ??
          response.statusText;
        continue;
      }
      const opportunitiesRaw = extractOpportunitiesArray(parsed);
      return {
        ok: true,
        opportunitiesRaw,
        error: null
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request_failed";
    }
  }

  return {
    ok: false,
    opportunitiesRaw: [],
    error: lastError
  };
}

async function fetchOpportunityPipelinesWithToken(
  env: Env,
  accessToken: string,
  ghlLocationId: string
): Promise<{ ok: boolean; stageOptions: OpportunityStageOption[]; error: string | null }> {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const endpoints = [
    `${baseUrl}/opportunities/pipelines?locationId=${encodeURIComponent(ghlLocationId)}`,
    `${baseUrl}/opportunities/pipelines?location_id=${encodeURIComponent(ghlLocationId)}`,
    `${baseUrl}/opportunities/pipelines`
  ];
  let lastError: string | null = null;

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          Version: "2023-02-21",
          "Location-Id": ghlLocationId,
          locationId: ghlLocationId
        }
      });
      const rawBody = await response.text();
      const parsed = safeJsonParse(rawBody);
      if (!response.ok) {
        const errorPayload = asRecord(parsed ?? {});
        lastError =
          stringOrNull(errorPayload.message ?? errorPayload.error ?? errorPayload.error_description) ??
          response.statusText;
        continue;
      }
      return {
        ok: true,
        stageOptions: normalizeOpportunityStageOptions(parsed),
        error: null
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request_failed";
    }
  }

  return {
    ok: false,
    stageOptions: [],
    error: lastError
  };
}

function normalizeOpportunityStageOptions(payload: unknown): OpportunityStageOption[] {
  const root = asRecord(payload);
  const pipelineCandidates = [
    root.pipelines,
    root.data,
    asRecord(root.data ?? {}).pipelines,
    asRecord(root.data ?? {}).items
  ];
  const pipelines = pipelineCandidates.find(Array.isArray) as unknown[] | undefined;
  if (!pipelines) {
    return [];
  }

  const output = new Map<string, OpportunityStageOption>();
  for (const pipelineEntry of pipelines) {
    const pipeline = asRecord(pipelineEntry);
    const pipelineId = stringOrNull(pipeline.id ?? pipeline.pipelineId);
    const pipelineName = stringOrNull(pipeline.name ?? pipeline.pipelineName);
    const stages = [pipeline.stages, pipeline.pipelineStages, asRecord(pipeline.data ?? {}).stages].find(
      Array.isArray
    ) as unknown[] | undefined;
    if (!stages) {
      continue;
    }
    for (const stageEntry of stages) {
      const stage = asRecord(stageEntry);
      const stageId = stringOrNull(stage.id ?? stage.stageId);
      const stageName = stringOrNull(stage.name ?? stage.stageName);
      if (!stageId || !stageName) {
        continue;
      }
      output.set(stageId, {
        id: stageId,
        name: stageName,
        pipelineId,
        pipelineName
      });
    }
  }

  return Array.from(output.values());
}

function normalizeThreadOpportunities(
  opportunitiesRaw: unknown[],
  stageOptions: OpportunityStageOption[]
): ThreadOpportunity[] {
  const stageById = new Map(stageOptions.map((stage) => [stage.id, stage]));
  return opportunitiesRaw
    .map((entry) => {
      const row = asRecord(entry);
      const id = stringOrNull(row.id ?? row.opportunityId);
      if (!id) {
        return null;
      }
      const stageId = stringOrNull(row.pipelineStageId ?? row.stageId ?? row.pipeline_stage_id);
      const stageOption = stageId ? stageById.get(stageId) : null;
      const pipelineId =
        stringOrNull(row.pipelineId ?? row.pipeline_id ?? row.pipeline?.id) ?? stageOption?.pipelineId ?? null;
      return {
        id,
        name: stringOrNull(row.name ?? row.title ?? row.opportunityName),
        status: stringOrNull(row.status ?? row.opportunityStatus),
        pipelineId,
        pipelineName:
          stringOrNull(row.pipelineName ?? row.pipeline?.name) ?? stageOption?.pipelineName ?? null,
        stageId,
        stageName: stringOrNull(row.pipelineStageName ?? row.stageName) ?? stageOption?.name ?? null,
        monetaryValue: numberOrNull(row.monetaryValue ?? row.value ?? row.amount ?? row.opportunityValue),
        currency: stringOrNull(row.currency ?? row.currencyCode)
      };
    })
    .filter((value): value is ThreadOpportunity => Boolean(value));
}

function extractOpportunitiesArray(payload: unknown): unknown[] {
  const root = asRecord(payload);
  const nestedData = asRecord(root.data ?? {});
  const candidates = [root.opportunities, root.items, root.results, root.data, nestedData.opportunities, nestedData.items];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function normalizeOpportunityStatus(value: unknown) {
  const normalized = stringOrNull(value)?.toLowerCase();
  if (!normalized) {
    return null;
  }
  if (["open", "won", "lost", "abandoned"].includes(normalized)) {
    return normalized;
  }
  return null;
}

async function updateOpportunityWithToken(
  env: Env,
  params: {
    accessToken: string;
    ghlLocationId: string;
    opportunityId: string;
    stageId: string | null;
    status: string | null;
  }
): Promise<{ ok: boolean; status: number; error: string | null }> {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const payload: Record<string, unknown> = {
    locationId: params.ghlLocationId
  };
  if (params.stageId) {
    payload.stageId = params.stageId;
    payload.pipelineStageId = params.stageId;
  }
  if (params.status) {
    payload.status = params.status;
    payload.opportunityStatus = params.status;
  }

  const attempts: Array<{ method: "PUT"; endpoint: string }> = [
    { method: "PUT", endpoint: `${baseUrl}/opportunities/${encodeURIComponent(params.opportunityId)}` }
  ];
  let lastError: string | null = null;

  for (const attempt of attempts) {
    try {
      const response = await fetch(attempt.endpoint, {
        method: attempt.method,
        headers: {
          Authorization: `Bearer ${params.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: "2023-02-21",
          "Location-Id": params.ghlLocationId,
          locationId: params.ghlLocationId
        },
        body: JSON.stringify(payload)
      });
      const rawBody = await response.text();
      const parsed = asRecord(safeJsonParse(rawBody) ?? {});
      if (!response.ok) {
        lastError =
          stringOrNull(parsed.message ?? parsed.error ?? parsed.error_description) ?? response.statusText;
        continue;
      }
      return {
        ok: true,
        status: response.status,
        error: null
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : "request_failed";
    }
  }

  return {
    ok: false,
    status: 0,
    error: lastError
  };
}

async function refreshOAuthAccessTokensForLocation(
  env: Env,
  db: ReturnType<typeof createDb>,
  ghlLocationId: string
) {
  const clientId = env.GHL_CLIENT_ID?.trim();
  const clientSecret = env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return 0;
  }

  const [locationWithAgency] = await db
    .select({
      ghlAgencyId: agencies.ghlAgencyId
    })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(eq(locations.ghlLocationId, ghlLocationId))
    .limit(1);

  const filters = [eq(ghlOAuthInstallations.locationId, ghlLocationId)];
  if (locationWithAgency?.ghlAgencyId) {
    const companyFilter = and(
      eq(ghlOAuthInstallations.companyId, locationWithAgency.ghlAgencyId),
      eq(ghlOAuthInstallations.userType, "Company")
    );
    if (companyFilter) {
      filters.push(companyFilter);
    }
  }

  let installations = await db
    .select({
      id: ghlOAuthInstallations.id,
      refreshToken: ghlOAuthInstallations.refreshToken,
      userType: ghlOAuthInstallations.userType
    })
    .from(ghlOAuthInstallations)
    .where(or(...filters))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(8);

  if (installations.length === 0) {
    installations = await db
      .select({
        id: ghlOAuthInstallations.id,
        refreshToken: ghlOAuthInstallations.refreshToken,
        userType: ghlOAuthInstallations.userType
      })
      .from(ghlOAuthInstallations)
      .where(eq(ghlOAuthInstallations.userType, "Company"))
      .orderBy(desc(ghlOAuthInstallations.updatedAt))
      .limit(8);
  }

  let refreshedCount = 0;
  for (const installation of installations) {
    const refreshToken = installation.refreshToken?.trim();
    if (!refreshToken) {
      continue;
    }
    const refreshed = await refreshGhlAccessTokenWithRefreshToken(env, refreshToken, installation.userType);
    if (!refreshed) {
      continue;
    }
    await db
      .update(ghlOAuthInstallations)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: addSecondsToNow(refreshed.expiresIn),
        updatedAt: new Date()
      })
      .where(eq(ghlOAuthInstallations.id, installation.id));
    refreshedCount += 1;
  }

  return refreshedCount;
}

async function refreshGhlAccessTokenWithRefreshToken(
  env: Env,
  refreshToken: string,
  installationUserType: string | null
) {
  const clientId = env.GHL_CLIENT_ID?.trim();
  const clientSecret = env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }

  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const configuredUserType = normalizeOAuthUserType(
    stringOrNull(installationUserType) ?? env.GHL_OAUTH_USER_TYPE ?? "Company"
  );
  const fallbackUserType = configuredUserType === "Company" ? "Location" : "Company";
  const userTypeAttempts = [configuredUserType, fallbackUserType];

  for (const userType of userTypeAttempts) {
    const requestBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      user_type: userType
    });
    try {
      const response = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: requestBody.toString()
      });
      const raw = asRecord(await response.json().catch(() => ({})));
      if (!response.ok) {
        continue;
      }
      const nextAccessToken = stringOrNull(raw.access_token ?? raw.accessToken);
      if (!nextAccessToken) {
        continue;
      }
      return {
        accessToken: nextAccessToken,
        refreshToken: stringOrNull(raw.refresh_token ?? raw.refreshToken) ?? refreshToken,
        expiresIn: Number(raw.expires_in ?? raw.expiresIn ?? 86400)
      };
    } catch {
      continue;
    }
  }

  return null;
}

function addSecondsToNow(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return new Date(Date.now() + safeSeconds * 1000);
}

function normalizeOAuthUserType(value: string | null) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "location") {
    return "Location";
  }
  return "Company";
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

  return null;
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
      firstName: stringOrNull(
        root.contact?.firstName ??
          message.contact?.firstName ??
          message.contact?.name?.first ??
          root.firstName
      ),
      lastName: stringOrNull(
        root.contact?.lastName ??
          message.contact?.lastName ??
          message.contact?.name?.last ??
          root.lastName
      ),
      email: stringOrNull(
        root.contact?.email ??
          message.contact?.email ??
          root.email ??
          message.email ??
          inferEmailAddress(stringOrNull(root.from ?? message.from), stringOrNull(root.to ?? message.to))
      ),
      phone: stringOrNull(
        root.contact?.phone ??
          message.contact?.phone ??
          root.phone ??
          message.phone ??
          getContactPhoneFromMessageDirection(
            direction,
            stringOrNull(root.from ?? message.from),
            stringOrNull(root.to ?? message.to)
          )
      )
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

function getContactPhoneFromMessageDirection(
  direction: MessageDirection,
  from: string | null,
  to: string | null
) {
  const inboundPhone = normalizePhoneCandidate(from);
  const outboundPhone = normalizePhoneCandidate(to);
  return direction === "inbound" ? inboundPhone ?? outboundPhone : outboundPhone ?? inboundPhone;
}

function normalizePhoneCandidate(value: string | null) {
  const normalized = stringOrNull(value);
  if (!normalized || normalized.includes("@")) {
    return null;
  }
  return /\d/.test(normalized) ? normalized : null;
}

function inferEmailAddress(...values: Array<string | null>) {
  for (const value of values) {
    const normalized = stringOrNull(value);
    if (!normalized || !normalized.includes("@")) {
      continue;
    }
    return normalized;
  }
  return null;
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

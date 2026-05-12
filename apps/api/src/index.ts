import { createDb, agencies, contacts, locations, messages, threads, webhookEvents } from "@agentflow/db";
import type { ContactOnDemandDetails, MessageChannel, MessageDirection, NormalizedGhlWebhookEvent } from "@agentflow/shared";
import { and, desc, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";

type Env = {
  DATABASE_URL: string;
  GHL_WEBHOOK_SECRET?: string;
  GHL_API_TOKEN?: string;
  GHL_API_BASE_URL?: string;
  MESSAGE_QUEUE: Queue<NormalizedGhlWebhookEvent>;
};

type HonoBindings = {
  Bindings: Env;
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

async function processWebhookEvent(env: Env, event: NormalizedGhlWebhookEvent) {
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
  const message = asRecord(root.message ?? root.messageData ?? root);
  const eventType = stringValue(root.type ?? root.event ?? root.eventType ?? "message.received");
  const eventLower = eventType.toLowerCase();

  if (eventLower.includes("call")) {
    return null;
  }

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
  const idempotencyHeader =
    headers.get("x-ghl-idempotency-key") ??
    headers.get("x-gohighlevel-webhook-id") ??
    headers.get("x-webhook-id") ??
    headers.get("x-event-id");
  const idempotencyKey =
    idempotencyHeader ??
    `${ghlLocationId}:${ghlContactId}:${ghlMessageId}:${channel}:${direction}`;

  return {
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
    raw: payload
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

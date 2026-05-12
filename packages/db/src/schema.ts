import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

export const messageChannelEnum = pgEnum("message_channel", ["sms", "email"]);
export const messageDirectionEnum = pgEnum("message_direction", [
  "inbound",
  "outbound"
]);
export const webhookEventStatusEnum = pgEnum("webhook_event_status", [
  "queued",
  "processed",
  "failed"
]);
export const ghlUserTypeEnum = pgEnum("ghl_user_type", ["Company", "Location"]);

export const agencies = pgTable("agencies", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  ghlAgencyId: text("ghl_agency_id").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const locations = pgTable(
  "locations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    agencyId: uuid("agency_id")
      .notNull()
      .references(() => agencies.id, { onDelete: "cascade" }),
    ghlLocationId: text("ghl_location_id").notNull(),
    name: text("name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    ghlLocationUnique: uniqueIndex("locations_ghl_location_id_unique").on(
      table.ghlLocationId
    ),
    agencyIdx: index("locations_agency_id_idx").on(table.agencyId)
  })
);

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    ghlContactId: text("ghl_contact_id").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    contactPerLocationUnique: uniqueIndex(
      "contacts_location_id_ghl_contact_id_unique"
    ).on(table.locationId, table.ghlContactId),
    locationIdx: index("contacts_location_id_idx").on(table.locationId)
  })
);

export const threads = pgTable(
  "threads",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    pendingReply: boolean("pending_reply").notNull().default(false),
    unreadCount: integer("unread_count").notNull().default(0),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    threadPerContactUnique: uniqueIndex("threads_location_id_contact_id_unique").on(
      table.locationId,
      table.contactId
    ),
    pendingIdx: index("threads_pending_reply_idx").on(table.pendingReply),
    locationIdx: index("threads_location_id_idx").on(table.locationId)
  })
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    ghlMessageId: text("ghl_message_id").notNull(),
    channel: messageChannelEnum("channel").notNull(),
    direction: messageDirectionEnum("direction").notNull(),
    subject: text("subject"),
    body: text("body"),
    from: text("from_address"),
    to: text("to_address"),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    ghlMessagePerThreadUnique: uniqueIndex(
      "messages_thread_id_ghl_message_id_unique"
    ).on(table.threadId, table.ghlMessageId),
    threadSentAtIdx: index("messages_thread_id_sent_at_idx").on(
      table.threadId,
      table.sentAt
    ),
    contactIdx: index("messages_contact_id_idx").on(table.contactId)
  })
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    idempotencyKey: text("idempotency_key").notNull(),
    source: text("source").notNull().default("gohighlevel"),
    eventType: text("event_type").notNull(),
    status: webhookEventStatusEnum("status").notNull().default("queued"),
    payload: jsonb("payload").notNull(),
    error: text("error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    idempotencyKeyUnique: uniqueIndex("webhook_events_idempotency_key_unique").on(
      table.idempotencyKey
    ),
    statusIdx: index("webhook_events_status_idx").on(table.status)
  })
);

export const ghlOAuthInstallations = pgTable(
  "ghl_oauth_installations",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    companyId: text("company_id").notNull(),
    locationId: text("location_id").notNull().default(""),
    userId: text("user_id"),
    userType: ghlUserTypeEnum("user_type").notNull(),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    tokenType: text("token_type").notNull().default("Bearer"),
    scope: text("scope"),
    refreshTokenId: text("refresh_token_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    companyLocationUnique: uniqueIndex(
      "ghl_oauth_installations_company_location_user_type_unique"
    ).on(table.companyId, table.locationId, table.userType),
    companyIdx: index("ghl_oauth_installations_company_id_idx").on(table.companyId),
    locationIdx: index("ghl_oauth_installations_location_id_idx").on(table.locationId)
  })
);

export const agenciesRelations = relations(agencies, ({ many }) => ({
  locations: many(locations)
}));

export const locationsRelations = relations(locations, ({ one, many }) => ({
  agency: one(agencies, {
    fields: [locations.agencyId],
    references: [agencies.id]
  }),
  contacts: many(contacts),
  threads: many(threads),
  messages: many(messages)
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  location: one(locations, {
    fields: [contacts.locationId],
    references: [locations.id]
  }),
  threads: many(threads),
  messages: many(messages)
}));

export const threadsRelations = relations(threads, ({ one, many }) => ({
  location: one(locations, {
    fields: [threads.locationId],
    references: [locations.id]
  }),
  contact: one(contacts, {
    fields: [threads.contactId],
    references: [contacts.id]
  }),
  messages: many(messages)
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  thread: one(threads, {
    fields: [messages.threadId],
    references: [threads.id]
  }),
  location: one(locations, {
    fields: [messages.locationId],
    references: [locations.id]
  }),
  contact: one(contacts, {
    fields: [messages.contactId],
    references: [contacts.id]
  })
}));

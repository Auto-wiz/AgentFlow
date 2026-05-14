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
    tags: jsonb("tags").$type<string[]>(),
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

export const userSubaccountVisibilities = pgTable(
  "user_subaccount_visibilities",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    userKey: text("user_key").notNull(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    isVisible: boolean("is_visible").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    userLocationUnique: uniqueIndex("user_subaccount_visibilities_user_location_unique").on(
      table.userKey,
      table.locationId
    ),
    userKeyIdx: index("user_subaccount_visibilities_user_key_idx").on(table.userKey),
    locationIdx: index("user_subaccount_visibilities_location_id_idx").on(table.locationId)
  })
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    ghlAppointmentId: text("ghl_appointment_id").notNull(),
    calendarId: text("calendar_id"),
    groupId: text("group_id"),
    title: text("title"),
    address: text("address"),
    status: text("status"),
    assignedUserId: text("assigned_user_id"),
    users: jsonb("users").notNull().default(sql`'[]'::jsonb`),
    notes: text("notes"),
    source: text("source"),
    startTime: timestamp("start_time", { withTimezone: true }),
    endTime: timestamp("end_time", { withTimezone: true }),
    dateAdded: timestamp("date_added", { withTimezone: true }),
    dateUpdated: timestamp("date_updated", { withTimezone: true }),
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    appointmentPerLocationUnique: uniqueIndex(
      "appointments_location_id_ghl_appointment_id_unique"
    ).on(table.locationId, table.ghlAppointmentId),
    locationIdx: index("appointments_location_id_idx").on(table.locationId),
    contactIdx: index("appointments_contact_id_idx").on(table.contactId),
    startTimeIdx: index("appointments_start_time_idx").on(table.startTime)
  })
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    ghlInvoiceId: text("ghl_invoice_id").notNull(),
    status: text("status"),
    liveMode: boolean("live_mode"),
    amountPaid: integer("amount_paid"),
    amountDue: integer("amount_due"),
    total: integer("total"),
    currency: text("currency"),
    altId: text("alt_id"),
    altType: text("alt_type"),
    name: text("name"),
    title: text("title"),
    invoiceNumber: text("invoice_number"),
    issueDate: timestamp("issue_date", { withTimezone: true }),
    dueDate: timestamp("due_date", { withTimezone: true }),
    ghlCreatedAt: timestamp("ghl_created_at", { withTimezone: true }),
    ghlUpdatedAt: timestamp("ghl_updated_at", { withTimezone: true }),
    lastEventType: text("last_event_type").notNull(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    invoicePerLocationUnique: uniqueIndex("invoices_location_id_ghl_invoice_id_unique").on(
      table.locationId,
      table.ghlInvoiceId
    ),
    locationIdx: index("invoices_location_id_idx").on(table.locationId),
    contactIdx: index("invoices_contact_id_idx").on(table.contactId),
    statusIdx: index("invoices_status_idx").on(table.status),
    amountDueIdx: index("invoices_amount_due_idx").on(table.amountDue),
    dueDateIdx: index("invoices_due_date_idx").on(table.dueDate)
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
  subaccountVisibilities: many(userSubaccountVisibilities),
  contacts: many(contacts),
  threads: many(threads),
  messages: many(messages),
  appointments: many(appointments),
  invoices: many(invoices)
}));

export const userSubaccountVisibilitiesRelations = relations(
  userSubaccountVisibilities,
  ({ one }) => ({
    location: one(locations, {
      fields: [userSubaccountVisibilities.locationId],
      references: [locations.id]
    })
  })
);

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  location: one(locations, {
    fields: [contacts.locationId],
    references: [locations.id]
  }),
  threads: many(threads),
  messages: many(messages),
  appointments: many(appointments),
  invoices: many(invoices)
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

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  location: one(locations, {
    fields: [appointments.locationId],
    references: [locations.id]
  }),
  contact: one(contacts, {
    fields: [appointments.contactId],
    references: [contacts.id]
  })
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  location: one(locations, {
    fields: [invoices.locationId],
    references: [locations.id]
  }),
  contact: one(contacts, {
    fields: [invoices.contactId],
    references: [contacts.id]
  })
}));

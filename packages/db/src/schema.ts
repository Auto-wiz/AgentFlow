import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
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

export const workspaceRoleEnum = pgEnum("workspace_role", ["admin", "user"]);

export const workspaceUsers = pgTable(
  "workspace_users",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text("email"),
    passwordHash: text("password_hash"),
    /** GoHighLevel user id returned by Marketplace / oauth token responses. */
    ghlUserId: text("ghl_user_id"),
    displayName: text("display_name"),
    role: workspaceRoleEnum("role").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    roleIdx: index("workspace_users_role_idx").on(table.role),
    ghlIdx: uniqueIndex("workspace_users_ghl_user_id_unique").on(table.ghlUserId),
    emailPartialIdx: uniqueIndex("workspace_users_email_unique_partial").on(table.email)
  })
);

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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last successful GHL-backed fetch of location display name (cron hydrate / stale refresh); webhooks-only updates may leave null. */
    locationNameSyncedAt: timestamp("location_name_synced_at", { withTimezone: true }),
    /** Omit from workspace portfolio dashboard KPIs and subaccount rollup (still visible elsewhere unless legacy-hidden). */
    excludeFromDashboard: boolean("exclude_from_dashboard").notNull().default(false)
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

function createGhlWebhookMirrorTable(tableName: string, indexPrefix: string) {
  return pgTable(
    tableName,
    {
      id: uuid("id")
        .primaryKey()
        .default(sql`gen_random_uuid()`),
      idempotencyKey: text("idempotency_key").notNull(),
      webhookType: text("webhook_type").notNull(),
      companyId: text("company_id"),
      locationId: text("location_id"),
      contactId: text("contact_id"),
      entityId: text("entity_id"),
      eventTimestamp: timestamp("event_timestamp", { withTimezone: true }),
      payload: jsonb("payload").notNull(),
      headers: jsonb("headers")
        .$type<Record<string, string>>()
        .notNull()
        .default(sql`'{}'::jsonb`),
      rawBody: text("raw_body").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
    },
    (table) => ({
      idempotencyKeyUnique: uniqueIndex(`${indexPrefix}_idempotency_key_unique`).on(
        table.idempotencyKey
      ),
      webhookTypeIdx: index(`${indexPrefix}_webhook_type_idx`).on(table.webhookType),
      locationIdx: index(`${indexPrefix}_location_id_idx`).on(table.locationId),
      createdAtIdx: index(`${indexPrefix}_created_at_idx`).on(table.createdAt)
    })
  );
}

export const ghlWebhookMirrorEvents = createGhlWebhookMirrorTable(
  "ghl_webhook_mirror_events",
  "ghl_wh_mirror_events"
);
export const ghlWebhookAppMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_app_mirror",
  "ghl_wh_app"
);
export const ghlWebhookAppointmentMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_appointment_mirror",
  "ghl_wh_appt"
);
export const ghlWebhookAssociationMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_association_mirror",
  "ghl_wh_assoc"
);
export const ghlWebhookCampaignMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_campaign_mirror",
  "ghl_wh_campaign"
);
export const ghlWebhookContactMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_contact_mirror",
  "ghl_wh_contact"
);
export const ghlWebhookConversationMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_conversation_mirror",
  "ghl_wh_conversation"
);
export const ghlWebhookExternalAuthMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_external_auth_mirror",
  "ghl_wh_external_auth"
);
export const ghlWebhookInvoiceMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_invoice_mirror",
  "ghl_wh_invoice"
);
export const ghlWebhookEmailStatsMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_email_stats_mirror",
  "ghl_wh_email_stats"
);
export const ghlWebhookLocationMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_location_mirror",
  "ghl_wh_location"
);
export const ghlWebhookNoteMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_note_mirror",
  "ghl_wh_note"
);
export const ghlWebhookObjectSchemaMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_object_schema_mirror",
  "ghl_wh_object_schema"
);
export const ghlWebhookOpportunityMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_opportunity_mirror",
  "ghl_wh_opportunity"
);
export const ghlWebhookOrderMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_order_mirror",
  "ghl_wh_order"
);
export const ghlWebhookPriceMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_price_mirror",
  "ghl_wh_price"
);
export const ghlWebhookProductMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_product_mirror",
  "ghl_wh_product"
);
export const ghlWebhookRecordMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_record_mirror",
  "ghl_wh_record"
);
export const ghlWebhookRelationMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_relation_mirror",
  "ghl_wh_relation"
);
export const ghlWebhookSaasPlanMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_saas_plan_mirror",
  "ghl_wh_saas_plan"
);
export const ghlWebhookTaskMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_task_mirror",
  "ghl_wh_task"
);
export const ghlWebhookUserMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_user_mirror",
  "ghl_wh_user"
);
export const ghlWebhookVoiceAiMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_voice_ai_mirror",
  "ghl_wh_voice_ai"
);
export const ghlWebhookMiscMirror = createGhlWebhookMirrorTable(
  "ghl_webhook_misc_mirror",
  "ghl_wh_misc"
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

/** Per-workspace-user subaccount picker state (admins seed defaults via admin API). */
export const workspaceUserLocationSelection = pgTable(
  "workspace_user_location_selection",
  {
    workspaceUserId: uuid("workspace_user_id")
      .notNull()
      .references(() => workspaceUsers.id, { onDelete: "cascade" }),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceUserId, table.locationId] }),
    locIdx: index("workspace_user_location_sel_loc_idx").on(table.locationId)
  })
);

/** Append-only workspace audit trail (manual retention pruning in Worker cron). */
export const workspaceAuditLogs = pgTable(
  "workspace_audit_logs",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    actorWorkspaceUserId: uuid("actor_workspace_user_id").references(() => workspaceUsers.id, {
      onDelete: "set null"
    }),
    actionKind: text("action_kind").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`)
  },
  (table) => ({
    createdIdx: index("workspace_audit_logs_created_at_idx").on(table.createdAt),
    actionIdx: index("workspace_audit_logs_action_kind_idx").on(table.actionKind),
    actorIdx: index("workspace_audit_logs_actor_idx").on(table.actorWorkspaceUserId),
    locIdx: index("workspace_audit_logs_location_id_idx").on(table.locationId)
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Nullable: inherit computed payment (`force_paid` / `force_unpaid`). */
    manualPaymentOverride: text("manual_payment_override"),
    hiddenFromUi: boolean("hidden_from_ui").notNull().default(false),
    appointmentOverrideUpdatedAt: timestamp("appointment_override_updated_at", { withTimezone: true }),
    appointmentOverrideWorkspaceUserId: uuid("appointment_override_workspace_user_id").references(
      () => workspaceUsers.id,
      { onDelete: "set null" }
    )
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

/** GHL calendars seen via appointment webhooks (display names for drill-down). */
export const locationCalendars = pgTable(
  "location_calendars",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    ghlCalendarId: text("ghl_calendar_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    locationGhlCalendarUnique: uniqueIndex("location_calendars_location_ghl_calendar_unique").on(
      table.locationId,
      table.ghlCalendarId
    ),
    locationIdx: index("location_calendars_location_id_idx").on(table.locationId)
  })
);

/** Order webhook `source` objects (Deposit Link labels, etc.) for drill-down grouping. */
export const paymentSources = pgTable(
  "payment_sources",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull().default(""),
    sourceSubType: text("source_sub_type").notNull().default(""),
    externalId: text("external_id").notNull().default(""),
    displayName: text("display_name").notNull(),
    meta: jsonb("meta")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    locationSourceKeyUnique: uniqueIndex("payment_sources_location_source_key_unique").on(
      table.locationId,
      table.sourceType,
      table.sourceSubType,
      table.externalId
    ),
    locationIdx: index("payment_sources_location_id_idx").on(table.locationId)
  })
);

/** GoHighLevel payment orders from OrderCreate / OrderStatusUpdate webhooks. */
export const ghlPaymentOrders = pgTable(
  "ghl_payment_orders",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    /** Populated when order payload includes `source` (joined for dashboard drill-down). */
    paymentSourceId: uuid("payment_source_id").references(() => paymentSources.id, { onDelete: "set null" }),
    ghlOrderId: text("ghl_order_id").notNull(),
    status: text("status"),
    fulfillmentStatus: text("fulfillment_status"),
    liveMode: boolean("live_mode"),
    amount: integer("amount"),
    currency: text("currency"),
    altId: text("alt_id"),
    altType: text("alt_type"),
    ghlCreatedAt: timestamp("ghl_created_at", { withTimezone: true }),
    ghlUpdatedAt: timestamp("ghl_updated_at", { withTimezone: true }),
    lastEventType: text("last_event_type").notNull(),
    isDeleted: boolean("is_deleted").notNull().default(false),
    raw: jsonb("raw").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    paymentOrderPerLocationUnique: uniqueIndex("ghl_payment_orders_location_id_ghl_order_id_unique").on(
      table.locationId,
      table.ghlOrderId
    ),
    locationIdx: index("ghl_payment_orders_location_id_idx").on(table.locationId),
    contactIdx: index("ghl_payment_orders_contact_id_idx").on(table.contactId),
    statusIdx: index("ghl_payment_orders_status_idx").on(table.status),
    paymentSourceIdx: index("ghl_payment_orders_payment_source_id_idx").on(table.paymentSourceId)
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

/** Per-subaccount opt-in for pay-per-result wallet billing. */
export const locationBillingConfig = pgTable(
  "location_billing_config",
  {
    locationId: uuid("location_id")
      .primaryKey()
      .references(() => locations.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    currency: text("currency").notNull().default("USD"),
    ghlMeterId: text("ghl_meter_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedByWorkspaceUserId: uuid("updated_by_workspace_user_id").references(() => workspaceUsers.id, {
      onDelete: "set null"
    })
  },
  (table) => ({
    enabledIdx: index("location_billing_config_enabled_idx").on(table.enabled)
  })
);

/** One idempotent GHL wallet charge per paid appointment. */
export const clientResultCharges = pgTable(
  "client_result_charges",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    appointmentId: uuid("appointment_id")
      .notNull()
      .references(() => appointments.id, { onDelete: "restrict" }),
    depositSourceKind: text("deposit_source_kind").notNull(),
    paymentOrderId: uuid("payment_order_id").references(() => ghlPaymentOrders.id, {
      onDelete: "restrict"
    }),
    invoiceId: uuid("invoice_id").references(() => invoices.id, { onDelete: "restrict" }),
    depositAmount: integer("deposit_amount").notNull(),
    depositCurrency: text("deposit_currency").notNull(),
    chargeAmount: integer("charge_amount").notNull(),
    chargeCurrency: text("charge_currency").notNull(),
    status: text("status").notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    ghlReferenceId: text("ghl_reference_id"),
    ghlTransactionId: text("ghl_transaction_id"),
    requestSnapshot: jsonb("request_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    responseSnapshot: jsonb("response_snapshot")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastError: text("last_error"),
    attemptCount: integer("attempt_count").notNull().default(0),
    createdByWorkspaceUserId: uuid("created_by_workspace_user_id").references(() => workspaceUsers.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    succeededAt: timestamp("succeeded_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    reversedAt: timestamp("reversed_at", { withTimezone: true })
  },
  (table) => ({
    appointmentUnique: uniqueIndex("client_result_charges_appointment_unique").on(table.appointmentId),
    idempotencyUnique: uniqueIndex("client_result_charges_idempotency_unique").on(table.idempotencyKey),
    locationCreatedIdx: index("client_result_charges_location_created_idx").on(
      table.locationId,
      table.createdAt
    ),
    statusIdx: index("client_result_charges_status_idx").on(table.status),
    paymentOrderIdx: index("client_result_charges_payment_order_idx").on(table.paymentOrderId),
    invoiceIdx: index("client_result_charges_invoice_idx").on(table.invoiceId)
  })
);

/** Immutable history of every claim, outbound attempt, outcome, and reversal. */
export const clientResultChargeEvents = pgTable(
  "client_result_charge_events",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    chargeId: uuid("charge_id")
      .notNull()
      .references(() => clientResultCharges.id, { onDelete: "restrict" }),
    eventType: text("event_type").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    actorWorkspaceUserId: uuid("actor_workspace_user_id").references(() => workspaceUsers.id, {
      onDelete: "set null"
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => ({
    chargeCreatedIdx: index("client_result_charge_events_charge_created_idx").on(
      table.chargeId,
      table.createdAt
    )
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
  workspaceUserSelections: many(workspaceUserLocationSelection),
  contacts: many(contacts),
  threads: many(threads),
  messages: many(messages),
  appointments: many(appointments),
  locationCalendars: many(locationCalendars),
  paymentSources: many(paymentSources),
  invoices: many(invoices),
  ghlPaymentOrders: many(ghlPaymentOrders),
  billingConfig: one(locationBillingConfig),
  clientResultCharges: many(clientResultCharges)
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

export const workspaceUserLocationSelectionRelations = relations(
  workspaceUserLocationSelection,
  ({ one }) => ({
    workspaceUser: one(workspaceUsers, {
      fields: [workspaceUserLocationSelection.workspaceUserId],
      references: [workspaceUsers.id]
    }),
    location: one(locations, {
      fields: [workspaceUserLocationSelection.locationId],
      references: [locations.id]
    })
  })
);

export const workspaceUsersRelations = relations(workspaceUsers, ({ many }) => ({
  workspaceSelections: many(workspaceUserLocationSelection),
  billingConfigsUpdated: many(locationBillingConfig),
  clientResultChargesCreated: many(clientResultCharges),
  clientResultChargeEvents: many(clientResultChargeEvents)
}));

export const contactsRelations = relations(contacts, ({ one, many }) => ({
  location: one(locations, {
    fields: [contacts.locationId],
    references: [locations.id]
  }),
  threads: many(threads),
  messages: many(messages),
  appointments: many(appointments),
  invoices: many(invoices),
  ghlPaymentOrders: many(ghlPaymentOrders)
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
  }),
  clientResultCharge: one(clientResultCharges)
}));

export const locationCalendarsRelations = relations(locationCalendars, ({ one }) => ({
  location: one(locations, {
    fields: [locationCalendars.locationId],
    references: [locations.id]
  })
}));

export const paymentSourcesRelations = relations(paymentSources, ({ one, many }) => ({
  location: one(locations, {
    fields: [paymentSources.locationId],
    references: [locations.id]
  }),
  ghlPaymentOrders: many(ghlPaymentOrders)
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

export const ghlPaymentOrdersRelations = relations(ghlPaymentOrders, ({ one }) => ({
  location: one(locations, {
    fields: [ghlPaymentOrders.locationId],
    references: [locations.id]
  }),
  contact: one(contacts, {
    fields: [ghlPaymentOrders.contactId],
    references: [contacts.id]
  }),
  paymentSource: one(paymentSources, {
    fields: [ghlPaymentOrders.paymentSourceId],
    references: [paymentSources.id]
  }),
  clientResultCharge: one(clientResultCharges)
}));

export const locationBillingConfigRelations = relations(locationBillingConfig, ({ one }) => ({
  location: one(locations, {
    fields: [locationBillingConfig.locationId],
    references: [locations.id]
  }),
  updatedBy: one(workspaceUsers, {
    fields: [locationBillingConfig.updatedByWorkspaceUserId],
    references: [workspaceUsers.id]
  })
}));

export const clientResultChargesRelations = relations(clientResultCharges, ({ one, many }) => ({
  location: one(locations, {
    fields: [clientResultCharges.locationId],
    references: [locations.id]
  }),
  appointment: one(appointments, {
    fields: [clientResultCharges.appointmentId],
    references: [appointments.id]
  }),
  paymentOrder: one(ghlPaymentOrders, {
    fields: [clientResultCharges.paymentOrderId],
    references: [ghlPaymentOrders.id]
  }),
  invoice: one(invoices, {
    fields: [clientResultCharges.invoiceId],
    references: [invoices.id]
  }),
  createdBy: one(workspaceUsers, {
    fields: [clientResultCharges.createdByWorkspaceUserId],
    references: [workspaceUsers.id]
  }),
  events: many(clientResultChargeEvents)
}));

export const clientResultChargeEventsRelations = relations(clientResultChargeEvents, ({ one }) => ({
  charge: one(clientResultCharges, {
    fields: [clientResultChargeEvents.chargeId],
    references: [clientResultCharges.id]
  }),
  actor: one(workspaceUsers, {
    fields: [clientResultChargeEvents.actorWorkspaceUserId],
    references: [workspaceUsers.id]
  })
}));

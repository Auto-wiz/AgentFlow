export const SUPPORTED_MESSAGE_CHANNELS = ["sms", "email"] as const;
export const SUPPORTED_MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;

export type MessageChannel = (typeof SUPPORTED_MESSAGE_CHANNELS)[number];
export type MessageDirection = (typeof SUPPORTED_MESSAGE_DIRECTIONS)[number];

export type NormalizedGhlBaseWebhookEvent = {
  idempotencyKey: string;
  eventType: string;
  raw: unknown;
};

export type NormalizedGhlMessageWebhookEvent = NormalizedGhlBaseWebhookEvent & {
  kind: "message";
  location: {
    ghlLocationId: string;
    name?: string | null;
  };
  agency: {
    ghlAgencyId: string;
    name?: string | null;
  };
  contact: {
    ghlContactId: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  message: {
    ghlMessageId: string;
    channel: MessageChannel;
    direction: MessageDirection;
    subject?: string | null;
    body?: string | null;
    from?: string | null;
    to?: string | null;
    sentAt: string;
  };
};

export type NormalizedGhlAppointmentWebhookEvent = NormalizedGhlBaseWebhookEvent & {
  kind: "appointment";
  location: {
    ghlLocationId: string;
    name?: string | null;
  };
  agency: {
    ghlAgencyId: string;
    name?: string | null;
  };
  contact: {
    ghlContactId: string | null;
  };
  appointment: {
    ghlAppointmentId: string;
    calendarId: string | null;
    groupId: string | null;
    title: string | null;
    address: string | null;
    status: string | null;
    assignedUserId: string | null;
    users: string[];
    notes: string | null;
    source: string | null;
    startTime: string | null;
    endTime: string | null;
    dateAdded: string | null;
    dateUpdated: string | null;
  };
};

export type NormalizedGhlInstallWebhookEvent = NormalizedGhlBaseWebhookEvent & {
  kind: "install";
  appId: string | null;
  versionId: string | null;
  installType: string | null;
  location: {
    ghlLocationId: string | null;
    name?: string | null;
  };
  agency: {
    ghlAgencyId: string;
    name?: string | null;
  };
  userId: string | null;
  isWhitelabelCompany: boolean | null;
  timestamp: string | null;
};

export type NormalizedGhlInvoiceWebhookEvent = NormalizedGhlBaseWebhookEvent & {
  kind: "invoice";
  location: {
    ghlLocationId: string;
  };
  agency: {
    ghlAgencyId: string;
  };
  contact: {
    ghlContactId: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    companyName: string | null;
  };
  invoice: {
    ghlInvoiceId: string;
    status: string | null;
    liveMode: boolean | null;
    amountPaid: number | null;
    amountDue: number | null;
    total: number | null;
    currency: string | null;
    altId: string | null;
    altType: string | null;
    name: string | null;
    title: string | null;
    invoiceNumber: string | null;
    issueDate: string | null;
    dueDate: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    eventAction: string;
  };
};

export type NormalizedGhlWebhookEvent =
  | NormalizedGhlMessageWebhookEvent
  | NormalizedGhlAppointmentWebhookEvent
  | NormalizedGhlInstallWebhookEvent
  | NormalizedGhlInvoiceWebhookEvent;

export type ContactOnDemandDetails = {
  id: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  address1: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  website: string | null;
  source: string | null;
  type: string | null;
  dnd: boolean | null;
  dateAdded: string | null;
  dateUpdated: string | null;
  lastActivityDate: string | null;
  tags: string[];
  customFields: Array<{
    id?: string;
    name?: string;
    value: unknown;
  }>;
};

export type ThreadSummary = {
  id: string;
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  pendingReply: boolean;
  unreadCount: number;
  lastMessageAt: string | null;
};

export type ThreadMessagesResponse = {
  thread: ThreadSummary;
  messages: Array<{
    id: string;
    ghlMessageId: string;
    channel: MessageChannel;
    direction: MessageDirection;
    subject: string | null;
    body: string | null;
    from: string | null;
    to: string | null;
    sentAt: string;
  }>;
  contactDetails: ContactOnDemandDetails | null;
  paymentsSummary: {
    total: number;
    currency: string;
  };
};

export type ThreadOpportunity = {
  id: string;
  name: string | null;
  status: string | null;
  pipelineId: string | null;
  pipelineName: string | null;
  stageId: string | null;
  stageName: string | null;
  monetaryValue: number | null;
  currency: string | null;
};

export type OpportunityStageOption = {
  id: string;
  name: string;
  pipelineId: string | null;
  pipelineName: string | null;
};

export type ThreadOpportunitiesResponse = {
  opportunities: ThreadOpportunity[];
  stageOptions: OpportunityStageOption[];
};

export type AppointmentSummary = {
  id: string;
  ghlAppointmentId: string;
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  contactId: string | null;
  contactName: string;
  contactEmail: string | null;
  contactPhone: string | null;
  title: string | null;
  status: string | null;
  startTime: string | null;
  endTime: string | null;
  updatedAt: string;
};

export type AppointmentsResponse = {
  appointments: AppointmentSummary[];
};

export type SubaccountOverview = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  agencyId: string;
  agencyName: string | null;
  conversationCount: number;
  pendingCount: number;
  appointmentCount: number;
  visible: boolean;
};

export type SubaccountsOverviewResponse = {
  viewerKey: string;
  subaccounts: SubaccountOverview[];
};

export const SUPPORTED_MESSAGE_CHANNELS = ["sms", "email"] as const;
export const SUPPORTED_MESSAGE_DIRECTIONS = ["inbound", "outbound"] as const;

export type MessageChannel = (typeof SUPPORTED_MESSAGE_CHANNELS)[number];
export type MessageDirection = (typeof SUPPORTED_MESSAGE_DIRECTIONS)[number];

export type NormalizedGhlWebhookEvent = {
  idempotencyKey: string;
  eventType: string;
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
  raw: unknown;
};

export type ContactOnDemandDetails = {
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
};

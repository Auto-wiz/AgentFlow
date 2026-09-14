/** Current Marketplace app version (Developer Portal → Versions). Connect must use this, not a stale GHL_OAUTH_START_URL version_id. */
export const GHL_MARKETPLACE_APP_VERSION_ID = "6a6b5864ba65c71d784c0347";

/** Space-separated OAuth scopes for HighLevel Marketplace install / chooselocation (keep in sync with the published app version). */
export const DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE =
  "contacts.readonly conversations.readonly conversations.write conversations/message.readonly conversations/message.write conversations/reports.readonly conversations/livechat.write locations.readonly locations/tags.readonly locations/tags.write locations/customValues.readonly oauth.write oauth.readonly invoices.readonly invoices/schedule.readonly payments/orders.readonly payments/orders.collectPayment payments/integration.readonly payments/transactions.readonly payments/subscriptions.readonly payments/coupons.readonly payments/custom-provider.readonly opportunities.readonly opportunities.write calendars.readonly calendars/events.readonly calendars/groups.readonly calendars/resources.readonly charges.readonly charges.write saas/location.read saas/company.read";

export function normalizeGhlMarketplaceOAuthScope(raw: string): string {
  return raw
    .trim()
    .replace(/%2F/gi, "/")
    .replace(/\+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** Force Marketplace `version_id` so Connect never reinstalls a previous app version. */
export function applyGhlMarketplaceVersionId(url: URL, versionId: string | null | undefined) {
  const id = versionId?.trim();
  if (!id) {
    return;
  }
  url.searchParams.delete("versionId");
  url.searchParams.set("version_id", id);
}

/** Agency SaaS APIs need a Company token. Always set user_type so Connect cannot default to Location. */
export function applyGhlMarketplaceUserType(url: URL, userType?: string | null) {
  url.searchParams.set("user_type", userType?.trim() || "Company");
}

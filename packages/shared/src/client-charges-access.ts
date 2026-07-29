/** Workspace emails allowed to see and use Client Charges (UI + API). */
export const CLIENT_CHARGES_ALLOWED_EMAILS = [
  "info@autowiz.net",
  "omarurzim@gmail.com"
] as const;

export function normalizeWorkspaceEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

export function canAccessClientCharges(email: string | null | undefined): boolean {
  const normalized = normalizeWorkspaceEmail(email);
  if (!normalized) return false;
  if ((CLIENT_CHARGES_ALLOWED_EMAILS as readonly string[]).includes(normalized)) {
    return true;
  }
  const localPart = normalized.split("@")[0] ?? "";
  return localPart === "omarurzi" || localPart.startsWith("omarurzi");
}

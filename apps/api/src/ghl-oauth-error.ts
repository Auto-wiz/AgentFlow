/** Safe text from a HighLevel OAuth error body. Never returns tokens. */
export function sanitizeGhlOAuthError(status: number, raw: unknown): string {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const candidates = [record.message, record.error_description, record.error, record.msg];
  let message = "";
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      message = candidate.trim();
      break;
    }
    if (Array.isArray(candidate)) {
      const first = candidate.find((item) => typeof item === "string" && item.trim());
      if (typeof first === "string") {
        message = first.trim();
        break;
      }
    }
  }
  if (!message) message = `http_${status}`;
  message = message.replace(/bearer\s+\S+/gi, "bearer [redacted]");
  message = message.replace(/[A-Za-z0-9\-_]{40,}/g, "[redacted]");
  return message.slice(0, 180);
}

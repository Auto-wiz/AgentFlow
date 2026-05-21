/**
 * Prefer a friendly HighLevel location name when present.
 * Do not suffix with `ghlLocationId` here — callers that also show Location ID separately should use this helper.
 */
export function formatLocationName(locationName: string | null | undefined, ghlLocationId: string): string {
  const trimmed = typeof locationName === "string" ? locationName.trim() : "";
  return trimmed.length > 0 ? trimmed : ghlLocationId;
}

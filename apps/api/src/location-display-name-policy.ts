/** Live GHL Location API name wins; otherwise keep the stored label. */
export function overlayLocationDisplayName(
  stored: string | null | undefined,
  live: string | null | undefined
): string | null {
  const liveTrim = typeof live === "string" ? live.trim() : "";
  if (liveTrim) return liveTrim;
  const storedTrim = typeof stored === "string" ? stored.trim() : "";
  return storedTrim || null;
}

/** SaaS catalog names are often stale; never replace a stored Location API / webhook name. */
export function catalogNamePreservingStored(
  stored: string | null | undefined,
  catalog: string | null | undefined
): string | null {
  const storedTrim = typeof stored === "string" ? stored.trim() : "";
  if (storedTrim) return storedTrim;
  const catalogTrim = typeof catalog === "string" ? catalog.trim() : "";
  return catalogTrim || null;
}

export function locationNameNeedsGhlRefresh(
  stored: string | null | undefined,
  refreshExisting: boolean
): boolean {
  if (refreshExisting) return true;
  return !(typeof stored === "string" && stored.trim().length > 0);
}

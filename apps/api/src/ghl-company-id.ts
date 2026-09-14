/** Placeholder agency ids written when GHL webhooks omit companyId. They are not real SaaS company ids. */
export function isPlaceholderGhlCompanyId(value: string | null | undefined): boolean {
  const raw = value?.trim() ?? "";
  if (!raw) return true;
  const lower = raw.toLowerCase();
  return lower === "default" || lower.startsWith("agency_demo") || lower.startsWith("test-company");
}

export function usableGhlCompanyId(value: string | null | undefined): string | null {
  const raw = value?.trim() ?? "";
  if (!raw || isPlaceholderGhlCompanyId(raw)) return null;
  return raw;
}

export function pickFirstUsableGhlCompanyId(candidates: Array<string | null | undefined>): string | null {
  for (const candidate of candidates) {
    const usable = usableGhlCompanyId(candidate);
    if (usable) return usable;
  }
  return null;
}

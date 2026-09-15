/**
 * Temporary: every signed-in workspace user can see every current and future subaccount.
 * Saved selection/hide rows stay in the DB for admin tooling; they are not enforced on reads.
 * Return true when per-user location restrictions should come back.
 */
export function isWorkspaceLocationScopingEnabled(): boolean {
  return false;
}

/**
 * JWT allowlist used on reads.
 * `null` means no location filter (every current and future subaccount).
 * Stored picker rows are ignored while scoping is off, so newly ingested GHL
 * locations do not need a seed row to appear.
 */
export function jwtReadAllowlist(storedSelectionLocationIds: readonly string[]): string[] | null {
  if (!isWorkspaceLocationScopingEnabled()) {
    return null;
  }
  if (storedSelectionLocationIds.length === 0) {
    return null;
  }
  return [...storedSelectionLocationIds];
}

/** Legacy hide-list used on reads. Empty while scoping is off. */
export function legacyReadHiddenLocationIds(storedHiddenLocationIds: readonly string[]): string[] {
  if (!isWorkspaceLocationScopingEnabled()) {
    return [];
  }
  return [...storedHiddenLocationIds];
}

/** Whether a location UUID is readable for the current policy, including locations added later. */
export function canReadLocationUuid(
  locationId: string,
  jwtAllowlist: string[] | null,
  legacyHiddenIds: readonly string[] = []
): boolean {
  if (!isWorkspaceLocationScopingEnabled()) {
    return true;
  }
  if (jwtAllowlist !== null) {
    return jwtAllowlist.includes(locationId);
  }
  return !legacyHiddenIds.includes(locationId);
}

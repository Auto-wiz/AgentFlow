/**
 * Temporary: every signed-in workspace user can see every current and future subaccount.
 * Saved selection/hide rows stay in the DB for admin tooling; they are not enforced on reads.
 * Return true when per-user location restrictions should come back.
 */
export function isWorkspaceLocationScopingEnabled(): boolean {
  return false;
}

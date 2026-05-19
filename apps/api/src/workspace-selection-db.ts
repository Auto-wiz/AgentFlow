import { createDb, locations, workspaceUserLocationSelection } from "@agentflow/db";
import { eq, inArray } from "drizzle-orm";

export type DrizzleDb = ReturnType<typeof createDb>;

/** Empty rows means "everything selected" in UX. Otherwise only listed locations are toggled on. */
export async function fetchSelectionLocationRows(db: DrizzleDb, workspaceUserUuid: string) {
  return db
    .select({
      locationId: workspaceUserLocationSelection.locationId
    })
    .from(workspaceUserLocationSelection)
    .where(eq(workspaceUserLocationSelection.workspaceUserId, workspaceUserUuid));
}

export function rowsToNullableSelectionSet(rows: { locationId: string }[]): Set<string> | null {
  if (rows.length === 0) {
    return null;
  }
  return new Set(rows.map((r) => r.locationId));
}

export async function replaceWorkspaceSelections(
  db: DrizzleDb,
  workspaceUserUuid: string,
  locationIds: string[],
  now = new Date()
) {
  await db.transaction(async (tx) => {
    await tx
      .delete(workspaceUserLocationSelection)
      .where(eq(workspaceUserLocationSelection.workspaceUserId, workspaceUserUuid));
    if (locationIds.length === 0) {
      return;
    }
    await tx.insert(workspaceUserLocationSelection).values(
      locationIds.map((locationId) => ({
        workspaceUserId: workspaceUserUuid,
        locationId,
        createdAt: now
      }))
    );
  });
}

export async function assertAllLocationIdsExist(db: DrizzleDb, locationIds: string[]) {
  if (locationIds.length === 0) {
    return true;
  }
  const existing = await db
    .select({ id: locations.id })
    .from(locations)
    .where(inArray(locations.id, locationIds));
  return existing.length === locationIds.length;
}

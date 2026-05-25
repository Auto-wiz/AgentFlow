import { createDb, workspaceAuditLogs, workspaceUsers } from "@agentflow/db";
import { and, desc, eq, gte, lte, lt } from "drizzle-orm";

export const WORKSPACE_AUDIT_RETENTION_DAYS = 90;

export type DrizzleDb = ReturnType<typeof createDb>;

export type InsertWorkspaceAuditLogInput = {
  actorWorkspaceUserId: string | null;
  actionKind: string;
  entityType?: string | null;
  entityId?: string | null;
  locationId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
};

export async function insertWorkspaceAuditLog(db: DrizzleDb, row: InsertWorkspaceAuditLogInput) {
  await db.insert(workspaceAuditLogs).values({
    actorWorkspaceUserId: row.actorWorkspaceUserId,
    actionKind: row.actionKind,
    entityType: row.entityType ?? null,
    entityId: row.entityId ?? null,
    locationId: row.locationId ?? null,
    summary: row.summary,
    details: row.details ?? {}
  });
}

export async function pruneWorkspaceAuditLogs(db: DrizzleDb, retentionDays: number) {
  const safe = Number.isFinite(retentionDays)
    ? Math.max(30, Math.min(365, retentionDays))
    : WORKSPACE_AUDIT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - safe * 86400000);
  await db.delete(workspaceAuditLogs).where(lt(workspaceAuditLogs.createdAt, cutoff));
}

export async function listWorkspaceAuditLogsForAdmin(
  db: DrizzleDb,
  params: {
    from: Date;
    to: Date;
    actionKind?: string;
    locationId?: string;
    actorWorkspaceUserId?: string;
    limit: number;
  }
) {
  const filters = [
    gte(workspaceAuditLogs.createdAt, params.from),
    lte(workspaceAuditLogs.createdAt, params.to)
  ];
  const kind = params.actionKind?.trim();
  if (kind) {
    filters.push(eq(workspaceAuditLogs.actionKind, kind));
  }
  const loc = params.locationId?.trim();
  if (loc) {
    filters.push(eq(workspaceAuditLogs.locationId, loc));
  }
  const actor = params.actorWorkspaceUserId?.trim();
  if (actor) {
    filters.push(eq(workspaceAuditLogs.actorWorkspaceUserId, actor));
  }

  const safeLimit = Number.isFinite(params.limit) ? Math.min(500, Math.max(1, Math.floor(params.limit))) : 100;

  return db
    .select({
      id: workspaceAuditLogs.id,
      createdAt: workspaceAuditLogs.createdAt,
      actorWorkspaceUserId: workspaceAuditLogs.actorWorkspaceUserId,
      actionKind: workspaceAuditLogs.actionKind,
      entityType: workspaceAuditLogs.entityType,
      entityId: workspaceAuditLogs.entityId,
      locationId: workspaceAuditLogs.locationId,
      summary: workspaceAuditLogs.summary,
      details: workspaceAuditLogs.details,
      actorEmail: workspaceUsers.email,
      actorDisplayName: workspaceUsers.displayName
    })
    .from(workspaceAuditLogs)
    .leftJoin(workspaceUsers, eq(workspaceAuditLogs.actorWorkspaceUserId, workspaceUsers.id))
    .where(and(...filters))
    .orderBy(desc(workspaceAuditLogs.createdAt))
    .limit(safeLimit);
}

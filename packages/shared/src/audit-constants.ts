/** Central list for admin log filters; expand as new writers call `insertWorkspaceAuditLog`. */
export const AUDIT_ACTION_KINDS = {
  APPOINTMENT_MANUAL_OVERRIDE: "appointment.manual_override",
  WORKSPACE_USER_CREATED: "workspace.user_created",
  WORKSPACE_ADMIN_SUBACCOUNTS: "workspace.admin_subaccounts",
  WORKSPACE_SELF_SUBACCOUNT_SELECTION: "workspace.self_subaccount_selection",
  SUBACCOUNT_VISIBILITY_LEGACY: "subaccount.visibility_legacy",
  LOCATION_DASHBOARD_EXCLUSION: "location.dashboard_exclusion_updated"
} as const;

export const WORKSPACE_AUDIT_ACTION_OPTIONS = [
  AUDIT_ACTION_KINDS.APPOINTMENT_MANUAL_OVERRIDE,
  AUDIT_ACTION_KINDS.WORKSPACE_USER_CREATED,
  AUDIT_ACTION_KINDS.WORKSPACE_ADMIN_SUBACCOUNTS,
  AUDIT_ACTION_KINDS.WORKSPACE_SELF_SUBACCOUNT_SELECTION,
  AUDIT_ACTION_KINDS.SUBACCOUNT_VISIBILITY_LEGACY,
  AUDIT_ACTION_KINDS.LOCATION_DASHBOARD_EXCLUSION
] as const;

export type WorkspaceAuditActionKind = (typeof WORKSPACE_AUDIT_ACTION_OPTIONS)[number];

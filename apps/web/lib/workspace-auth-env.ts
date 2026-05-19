export function isForceWorkspaceLogin() {
  const raw = process.env.NEXT_PUBLIC_FORCE_WORKSPACE_LOGIN;
  return typeof raw === "string" && raw.trim().toLowerCase() === "true";
}

export function legacyViewerKey() {
  const raw = process.env.NEXT_PUBLIC_LEGACY_VIEWER_KEY;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "default";
}

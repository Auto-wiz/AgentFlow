import type { Context } from "hono";

/** @deprecated Prefer Authorization bearer when JWT_SECRET is configured. */
export function getViewerKey(c: Context<{ Bindings?: { DATABASE_URL?: string } }>) {
  const viewerHeader = c.req.header("x-viewer-key");
  const viewerQuery = c.req.query("viewerKey");
  return (viewerHeader ?? viewerQuery ?? "default").trim() || "default";
}

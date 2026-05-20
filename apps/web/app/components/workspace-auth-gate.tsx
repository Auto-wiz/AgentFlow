"use client";

import { useWorkspaceAuth } from "./workspace-auth-provider";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

export function WorkspaceAuthGate() {
  const pathname = usePathname();
  const router = useRouter();
  const { hydrated, token } = useWorkspaceAuth();

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (pathname === "/login") {
      return;
    }
    if (!token) {
      router.replace(`/login?next=${encodeURIComponent(pathname || "/appointments")}`);
    }
  }, [hydrated, pathname, router, token]);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (pathname !== "/login") {
      return;
    }
    if (token) {
      const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const next = params?.get("next");
      router.replace(next && next.startsWith("/") ? next : "/appointments");
    }
  }, [hydrated, pathname, router, token]);

  return null;
}

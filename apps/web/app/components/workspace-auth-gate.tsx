"use client";

import { isForceWorkspaceLogin } from "../../lib/workspace-auth-env";
import { useWorkspaceAuth } from "./workspace-auth-provider";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

export function WorkspaceAuthGate() {
  const pathname = usePathname();
  const router = useRouter();
  const { hydrated, token } = useWorkspaceAuth();

  useEffect(() => {
    if (!hydrated || !isForceWorkspaceLogin()) {
      return;
    }
    if (pathname === "/connect") {
      return;
    }
    if (!token) {
      router.replace(`/connect?next=${encodeURIComponent(pathname || "/appointments")}`);
    }
  }, [hydrated, pathname, router, token]);

  useEffect(() => {
    if (!hydrated || !isForceWorkspaceLogin()) {
      return;
    }
    if (pathname !== "/connect") {
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

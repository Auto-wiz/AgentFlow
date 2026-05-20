"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { useWorkspaceAuth } from "./workspace-auth-provider";

function initialsFromLabel(label: string) {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) {
    return "A";
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
}

export function AppUserMenu() {
  const router = useRouter();
  const { user, hydrated, token, signOut } = useWorkspaceAuth();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDoc(ev: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, []);

  const envLabel = process.env.NEXT_PUBLIC_APP_USER_DISPLAY_NAME;
  const fallbackName =
    typeof envLabel === "string" && envLabel.trim().length > 0 ? envLabel.trim() : null;

  const displayName =
    user?.displayName?.trim() ||
    user?.email?.trim() ||
    fallbackName ||
    "…";

  const showSignOut = hydrated && Boolean(token);

  function handleSignOut() {
    signOut();
    setOpen(false);
    router.replace("/login");
  }

  return (
    <div className="app-user-menu" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="app-user-menu-trigger"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span className="app-user-avatar" title={displayName}>
          {initialsFromLabel(displayName)}
        </span>
      </button>
      {open ? (
        <div className="app-user-menu-popover" role="dialog" aria-label="Account">
          <p className="app-user-menu-name">{displayName}</p>
          <p className="muted app-user-menu-note">
            {user ? `Signed in${user.role === "admin" ? " · admin" : ""}` : "Loading profile…"}
          </p>
          <Link className="app-user-menu-link" href="/settings" onClick={() => setOpen(false)}>
            Settings
          </Link>
          {showSignOut ? (
            <button
              className="app-user-menu-link"
              onClick={handleSignOut}
              style={{ border: "none", background: "none", cursor: "pointer", padding: 0, font: "inherit" }}
              type="button"
            >
              Sign out
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

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

  const raw = process.env.NEXT_PUBLIC_APP_USER_DISPLAY_NAME;
  const displayName =
    typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : "Agency";

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
            SSO or token-based identity will appear here once auth is wired to the UI.
          </p>
          <Link className="app-user-menu-link" href="/settings" onClick={() => setOpen(false)}>
            Settings
          </Link>
        </div>
      ) : null}
    </div>
  );
}

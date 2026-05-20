"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useWorkspaceAuth } from "../components/workspace-auth-provider";

export function SettingsSubnav() {
  const pathname = usePathname();
  const { user, hydrated } = useWorkspaceAuth();

  const isAdmin = hydrated && user?.role === "admin";

  const links = [
    { href: "/settings", active: pathname === "/settings", label: "General" },
    ...(isAdmin
      ? [
          {
            href: "/settings/admin",
            active: pathname === "/settings/admin" || pathname.startsWith("/settings/admin/"),
            label: "Workspace admin"
          }
        ]
      : []),
    {
      href: "/settings/team-selections",
      active: pathname === "/settings/team-selections",
      label: "Team selections"
    }
  ];

  return (
    <div className="toolbar" style={{ marginBottom: 16, gap: 8, flexWrap: "wrap" }}>
      {links.map((item) => (
        <Link
          className={`app-nav-pill ${item.active ? "active" : ""}`}
          href={item.href}
          key={item.href}
          style={{ padding: "8px 14px" }}
        >
          {item.label}
        </Link>
      ))}
    </div>
  );
}

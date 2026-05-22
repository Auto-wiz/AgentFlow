"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  {
    href: "/settings/admin",
    match: (path: string) => path === "/settings/admin",
    label: "Team access"
  },
  {
    href: "/settings/admin/create-users",
    match: (path: string) => path.startsWith("/settings/admin/create-users"),
    label: "Create users"
  }
] as const;

export function AdminSettingsSubnav() {
  const pathname = usePathname();

  return (
    <div className="toolbar" style={{ marginBottom: 16, gap: 8, flexWrap: "wrap" }}>
      {tabs.map((tab) => (
        <Link
          className={`app-nav-pill ${tab.match(pathname) ? "active" : ""}`}
          href={tab.href}
          key={tab.href}
          style={{ padding: "8px 14px" }}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}

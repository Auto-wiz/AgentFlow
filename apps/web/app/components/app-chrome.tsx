"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

const navItems = [
  { href: "/threads", label: "Inbox", icon: "✉" },
  { href: "/appointments", label: "Appointments", icon: "⌚" },
  { href: "/opportunities", label: "Opportunities", icon: "◈" },
  { href: "/settings", label: "Settings", icon: "⚙" }
];

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="app-shell">
      <aside className="app-sidebar">
        <div className="app-brand">A</div>
        <nav className="app-sidebar-nav">
          {navItems.map((item) => {
            const isActive =
              item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                aria-label={item.label}
                className={`app-sidebar-link ${isActive ? "active" : ""}`}
                href={item.href}
                key={item.href}
                title={item.label}
              >
                <span aria-hidden className="app-sidebar-icon">
                  {item.icon}
                </span>
                <span className="app-sidebar-label">{item.label}</span>
              </Link>
            );
          })}
        </nav>
        <div className="app-sidebar-footer">
          <ThemeToggle compact />
        </div>
      </aside>

      <main className="app-main">
        <header className="app-topbar panel">
          <div>
            <p className="eyebrow">GHL Agency Hub</p>
            <h1>Agency workspace</h1>
          </div>
        </header>
        <section className="app-page">{children}</section>
      </main>
    </div>
  );
}

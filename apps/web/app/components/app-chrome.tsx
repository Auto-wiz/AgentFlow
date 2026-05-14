"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

const navItems = [
  { href: "/", label: "Dashboard", short: "DB" },
  { href: "/threads", label: "Inbox", short: "IN" },
  { href: "/appointments", label: "Appointments", short: "AP" },
  { href: "/subaccounts", label: "Subaccounts", short: "SB" },
  { href: "/debug", label: "Debug", short: "DG" }
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
                {item.short}
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
            <h1>Fullscreen Dynamic</h1>
          </div>
          <div className="app-topbar-actions">
            <button className="button secondary" type="button">
              Advanced filters
            </button>
            <button className="button secondary" type="button">
              Subaccounts
            </button>
            <button className="button secondary" type="button">
              Save view
            </button>
            <button className="button" type="button">
              Apply changes
            </button>
            <ThemeToggle />
          </div>
        </header>
        <section className="app-page">{children}</section>
      </main>
    </div>
  );
}

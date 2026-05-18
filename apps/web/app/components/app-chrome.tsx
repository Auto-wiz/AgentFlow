"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  AppointmentsTopbarBridgeProvider,
  AppointmentsTopbarOutlet
} from "./appointments-topbar-bridge";
import { ThemeToggle } from "./theme-toggle";

const navItems = [
  { href: "/appointments", label: "Appointments", icon: "⌚" },
  { href: "/opportunities", label: "Opportunities", icon: "◈" },
  { href: "/settings", label: "Settings", icon: "⚙" }
];

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const appointmentsContext = pathname === "/appointments" || pathname.startsWith("/appointments/");

  return (
    <AppointmentsTopbarBridgeProvider>
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
          <header
            className={`app-topbar panel ${
              appointmentsContext ? "appointments-topbar-stack appointments-topbar-compact" : ""
            }`}
          >
            {appointmentsContext ? (
              <>
                <div className="appointments-topbar-primary">
                  <div className="app-topbar-agency-compact">
                    <p className="eyebrow">GHL Agency Hub</p>
                    <h1>Agency workspace</h1>
                  </div>
                  <div className="app-topbar-appointments-compact">
                    <p className="eyebrow">Calendar module</p>
                    <h2 style={{ margin: "4px 0 2px", fontSize: "1.02rem", fontWeight: 700 }}>Appointments</h2>
                    <p className="muted" style={{ fontSize: 11, lineHeight: 1.35, margin: 0 }}>
                      Unpaid appointments between booking creation and scheduled start time.
                    </p>
                  </div>
                </div>
                <div className="appointments-header-slot">
                  <AppointmentsTopbarOutlet />
                </div>
              </>
            ) : (
              <>
                <div>
                  <p className="eyebrow">GHL Agency Hub</p>
                  <h1>Agency workspace</h1>
                </div>
              </>
            )}
          </header>
          <section className="app-page">{children}</section>
        </main>
      </div>
    </AppointmentsTopbarBridgeProvider>
  );
}

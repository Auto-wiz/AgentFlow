"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  AppointmentsTopbarBridgeProvider,
  AppointmentsTopbarOutlet
} from "./appointments-topbar-bridge";
import { ThemeToggle } from "./theme-toggle";
import { AppUserMenu } from "./app-user-menu";
import { useWorkspaceAuth } from "./workspace-auth-provider";

const navItems = [
  { href: "/appointments", label: "Appointments", icon: "⌚" },
  { href: "/settings", label: "Settings", icon: "⚙" }
];

export function AppChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { hydrated, token } = useWorkspaceAuth();
  const appointmentsContext = pathname === "/appointments" || pathname.startsWith("/appointments/");

  if (pathname === "/login") {
    return (
      <AppointmentsTopbarBridgeProvider>
        <div className="app-shell app-shell-plain">
          <section className="app-page">{children}</section>
        </div>
      </AppointmentsTopbarBridgeProvider>
    );
  }

  if (pathname !== "/login" && (!hydrated || !token)) {
    return (
      <AppointmentsTopbarBridgeProvider>
        <div className="app-shell app-shell-plain">
          <section className="app-page" aria-busy aria-live="polite">
            <div className="panel" style={{ padding: 22 }}>
              <p className="muted">{!hydrated ? "Loading…" : "Signing in…"}</p>
            </div>
          </section>
        </div>
      </AppointmentsTopbarBridgeProvider>
    );
  }

  return (
    <AppointmentsTopbarBridgeProvider>
      <div className="app-shell">
        <main className="app-main">
          <header
            className={`app-topbar panel app-topbar-unified ${
              appointmentsContext ? "appointments-topbar-stack" : ""
            }`}
          >
            <div className="app-topbar-row">
              <nav aria-label="Primary navigation" className="app-topbar-nav">
                {navItems.map((item) => {
                  const isActive =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <Link
                      className={`app-nav-pill ${isActive ? "active" : ""}`}
                      href={item.href}
                      key={item.href}
                    >
                      <span aria-hidden className="app-nav-pill-icon">
                        {item.icon}
                      </span>
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
              <div className="app-topbar-actions-rail">
                <ThemeToggle compact />
                <AppUserMenu />
              </div>
            </div>
            {appointmentsContext ? (
              <div className="appointments-header-slot">
                <AppointmentsTopbarOutlet />
              </div>
            ) : null}
          </header>
          <section className="app-page">{children}</section>
        </main>
      </div>
    </AppointmentsTopbarBridgeProvider>
  );
}

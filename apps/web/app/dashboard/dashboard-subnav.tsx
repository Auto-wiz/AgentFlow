"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { useWorkspaceAuth } from "../components/workspace-auth-provider";

export function DashboardSubnav({ locationTail }: { locationTail?: ReactNode }) {
  const pathname = usePathname();
  const { user, hydrated } = useWorkspaceAuth();

  const onOverview = pathname === "/dashboard";
  const onPortfolioAdmin = pathname.startsWith("/dashboard/portfolio-admin");
  const showAdminTab = hydrated && user?.role === "admin";

  return (
    <div className="dashboard-subnav-toolbar">
      <Link className={`app-nav-pill ${onOverview ? "active" : ""}`} href="/dashboard" style={{ padding: "8px 14px" }}>
        Overview
      </Link>
      {showAdminTab ? (
        <Link
          className={`app-nav-pill ${onPortfolioAdmin ? "active" : ""}`}
          href="/dashboard/portfolio-admin"
          style={{ padding: "8px 14px" }}
        >
          Portfolio admin
        </Link>
      ) : null}
      {locationTail}
    </div>
  );
}

"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { canAccessClientCharges } from "@agentflow/shared";

import { useWorkspaceAuth } from "../components/workspace-auth-provider";

export function DashboardSubnav({ locationTail }: { locationTail?: ReactNode }) {
  const pathname = usePathname();
  const { user, hydrated } = useWorkspaceAuth();

  const onOverview = pathname === "/dashboard";
  const onClientCharges = pathname.startsWith("/dashboard/client-charges");
  const onPortfolioAdmin = pathname.startsWith("/dashboard/portfolio-admin");
  const showAdminTab = hydrated && user?.role === "admin";
  const showClientChargesTab = hydrated && canAccessClientCharges(user?.email);

  return (
    <div className="dashboard-subnav-toolbar">
      <Link className={`app-nav-pill ${onOverview ? "active" : ""}`} href="/dashboard" style={{ padding: "8px 14px" }}>
        Overview
      </Link>
      {showClientChargesTab ? (
        <Link
          className={`app-nav-pill ${onClientCharges ? "active" : ""}`}
          href="/dashboard/client-charges"
          style={{ padding: "8px 14px" }}
        >
          Client Charges
        </Link>
      ) : null}
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

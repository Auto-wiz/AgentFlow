import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

export function DashboardSubnav({ locationTail }: { locationTail?: ReactNode }) {
  const pathname = usePathname();
  const onOverview = pathname === "/dashboard";
  const onSubaccount = pathname.startsWith("/dashboard/subaccount");

  return (
    <div className="dashboard-subnav-toolbar">
      <Link className={`app-nav-pill ${onOverview ? "active" : ""}`} href="/dashboard" style={{ padding: "8px 14px" }}>
        Overview
      </Link>
      <Link
        className={`app-nav-pill ${onSubaccount ? "active" : ""}`}
        href="/dashboard/subaccount"
        style={{ padding: "8px 14px" }}
      >
        Subaccount
      </Link>
      {locationTail}
    </div>
  );
}

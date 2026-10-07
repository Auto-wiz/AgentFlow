"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { isPortfolioDashboardEnabled } from "@agentflow/shared";

export default function DashboardSubaccountLegacyRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace(isPortfolioDashboardEnabled() ? "/dashboard" : "/dashboard/client-charges");
  }, [router]);

  return (
    <p className="muted" style={{ paddingTop: 8 }}>
      Redirecting…
    </p>
  );
}

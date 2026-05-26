"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DashboardSubaccountLegacyRedirectPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard");
  }, [router]);

  return (
    <p className="muted" style={{ paddingTop: 8 }}>
      Redirecting…
    </p>
  );
}

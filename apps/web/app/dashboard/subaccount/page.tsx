import { Suspense } from "react";

import DashboardSubaccountClient from "./dashboard-subaccount-client";

export default function DashboardSubaccountRoutePage() {
  return (
    <Suspense
      fallback={
        <div className="muted" style={{ paddingTop: 8 }}>
          Loading…
        </div>
      }
    >
      <DashboardSubaccountClient />
    </Suspense>
  );
}

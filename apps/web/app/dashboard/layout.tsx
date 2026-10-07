import type { ReactNode } from "react";

import { isPortfolioDashboardEnabled } from "@agentflow/shared";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const portfolioOn = isPortfolioDashboardEnabled();
  return (
    <section className="module-shell dashboard-module-page">
      <div className="dashboard-module-head">
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Dashboard</h1>
        {portfolioOn ? (
          <p className="muted dashboard-lede">
            Booked appointments vs collected payments synced from invoices and orders. Counts use the booking capture time in
            HighLevel (<code className="muted">date_added</code>, else sync <code className="muted">created_at</code>, UTC range).
            The subaccount chart groups by that same booking date. Deposit totals use invoice/order activity in-range.
          </p>
        ) : (
          <p className="muted dashboard-lede">Client Charges for eligible HighLevel subaccounts.</p>
        )}
      </div>
      {children}
    </section>
  );
}

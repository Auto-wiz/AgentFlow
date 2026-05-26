import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <section className="module-shell dashboard-module-page">
      <div className="dashboard-module-head">
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Dashboard</h1>
        <p className="muted dashboard-lede">
          Booked appointments vs collected payments synced from invoices and orders. Counts use the booking capture time in
          HighLevel (<code className="muted">date_added</code>, else sync <code className="muted">created_at</code>, UTC range).
          The subaccount chart groups by that same booking date. Deposit totals use invoice/order activity in-range.
        </p>
      </div>
      {children}
    </section>
  );
}

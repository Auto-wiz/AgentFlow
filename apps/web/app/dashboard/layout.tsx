import type { ReactNode } from "react";

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <section className="module-shell dashboard-module-page">
      <div className="dashboard-module-head">
        <h1 style={{ margin: "0 0 8px", fontSize: 22 }}>Dashboard</h1>
        <p className="muted dashboard-lede">
          Booked appointments vs collected payments synced from invoices and orders. Range filters by appointment start date (UTC).
          Deposit amounts sum paid invoices and paid orders dated in-range.
        </p>
      </div>
      {children}
    </section>
  );
}

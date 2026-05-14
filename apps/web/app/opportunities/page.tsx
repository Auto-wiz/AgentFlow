"use client";

export default function OpportunitiesPage() {
  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Pipeline module</p>
        <h2 style={{ marginTop: 8 }}>Opportunities</h2>
        <p className="muted">
          Opportunities workspace is ready. We can plug pipeline stages, values, and owner filters next.
        </p>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        <div className="placeholder-grid">
          <article className="placeholder-card">
            <strong>Stage board</strong>
            <span className="muted">Kanban style pipeline overview</span>
          </article>
          <article className="placeholder-card">
            <strong>Opportunity list</strong>
            <span className="muted">Sortable list with subaccount filters</span>
          </article>
          <article className="placeholder-card">
            <strong>Deal insights</strong>
            <span className="muted">Projected value, close rates, and trends</span>
          </article>
        </div>
      </div>
    </section>
  );
}

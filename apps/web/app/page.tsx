import { getGhlInstallUrl } from "../lib/ghl-install-url";

export default function HomePage() {
  const goHighLevelConnectUrl = getGhlInstallUrl();

  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 22 }}>
        <p className="eyebrow">Overview</p>
        <h2 style={{ marginTop: 8 }}>Agency workspace shell</h2>
        <p className="muted">
          This layout mirrors the main dashboard shell (filters and modules). The primary module shipped today is
          Appointments.
        </p>
        <div className="badge-row" style={{ marginTop: 14 }}>
          <span className="badge">Appointments ready</span>
          <span className="badge">Subaccounts ready</span>
          <span className="badge">More modules in progress</span>
        </div>
      </div>

      <div className="placeholder-grid">
        <article className="placeholder-card">
          <p className="eyebrow">Calendar</p>
          <strong>Appointments module</strong>
          <p className="muted">Main view for appointments that remain unpaid ahead of their scheduled start.</p>
        </article>
        <article className="placeholder-card">
          <p className="eyebrow">Revenue</p>
          <strong>Pipeline metrics</strong>
          <p className="muted">Placeholder for pipeline and revenue cards.</p>
        </article>
        <article className="placeholder-card">
          <p className="eyebrow">Automation</p>
          <strong>Workflow snapshots</strong>
          <p className="muted">Placeholder for workflows and automations wired in later.</p>
        </article>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Connections</p>
        <h3 style={{ marginTop: 8 }}>GoHighLevel install</h3>
        <p className="muted">Connect additional subaccounts via the marketplace.</p>
        <div className="badge-row" style={{ marginTop: 10 }}>
          <a className="button secondary" href={goHighLevelConnectUrl}>
            Connect GoHighLevel
          </a>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";
import { getGhlInstallUrl } from "../../lib/ghl-install-url";

export default function SettingsPage() {
  const goHighLevelConnectUrl = getGhlInstallUrl();

  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Configuration module</p>
        <h2 style={{ marginTop: 8 }}>Settings</h2>
        <p className="muted">
          Central place for GoHighLevel connection setup and internal workspace configuration.
        </p>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        <div className="placeholder-grid">
          <article className="placeholder-card">
            <strong>GoHighLevel setup</strong>
            <span className="muted">OAuth, connected locations, and token diagnostics</span>
            <a className="button" href={goHighLevelConnectUrl}>
              Connect GoHighLevel
            </a>
            <Link className="button secondary" href="/debug">
              Open debug tools
            </Link>
          </article>
          <article className="placeholder-card">
            <strong>Subaccount visibility</strong>
            <span className="muted">Choose which subaccounts are shown in Inbox and Appointments</span>
            <Link className="button secondary" href="/subaccounts">
              Manage subaccounts
            </Link>
          </article>
          <article className="placeholder-card">
            <strong>Internal usage</strong>
            <span className="muted">Reserved for internal rules, access controls, and defaults</span>
          </article>
        </div>
      </div>
    </section>
  );
}

import Link from "next/link";

export default function SettingsPage() {
  const goHighLevelClientId =
    process.env.NEXT_PUBLIC_GHL_CLIENT_ID ?? "6a035ee24b80374d79d8c5c0-mp2xo4p3";
  const goHighLevelVersionId = process.env.NEXT_PUBLIC_GHL_VERSION_ID ?? "6a035ee24b80374d79d8c5c0";
  const goHighLevelConnectUrl =
    process.env.NEXT_PUBLIC_GHL_INSTALL_URL ??
    `https://marketplace.gohighlevel.com/v2/oauth/chooselocation?response_type=code&redirect_uri=${encodeURIComponent(
      "https://api.agentflow.autowiz.net/oauth/gohighlevel/callback"
    )}&client_id=${encodeURIComponent(
      goHighLevelClientId
    )}&scope=contacts.readonly+conversations.readonly+conversations.write+conversations%2Fmessage.readonly+conversations%2Fmessage.write+conversations%2Freports.readonly+conversations%2Flivechat.write+locations.readonly+locations%2Ftags.readonly+locations%2Ftags.write+locations%2FcustomValues.readonly+oauth.write+oauth.readonly+calendars%2Fevents.readonly+invoices.readonly+invoices%2Fschedule.readonly&version_id=${encodeURIComponent(
      goHighLevelVersionId
    )}`;

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

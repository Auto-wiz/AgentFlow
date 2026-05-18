import Link from "next/link";

export default function HomePage() {
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
    <section className="panel" style={{ padding: 32 }}>
      <p className="eyebrow">MVP foundation</p>
      <h2>Track future appointments that are still unpaid.</h2>
      <p className="muted">
        AgentFlow now prioritizes payment follow-up: filter appointments by
        subaccount and timeframe, and only show those without a full payment
        between appointment creation and scheduled date.
      </p>
      <div className="badge-row" style={{ margin: "20px 0" }}>
        <span className="badge">Unpaid appointments only</span>
        <span className="badge">Future/Past filter</span>
        <span className="badge">Subaccount filter</span>
      </div>
      <div className="badge-row">
        <Link className="button" href="/appointments">
          Open appointments
        </Link>
        <a className="button secondary" href={goHighLevelConnectUrl}>
          Connect GoHighLevel
        </a>
      </div>
    </section>
  );
}

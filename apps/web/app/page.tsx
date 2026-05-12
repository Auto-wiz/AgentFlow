import Link from "next/link";

export default function HomePage() {
  return (
    <section className="panel" style={{ padding: 32 }}>
      <p className="eyebrow">MVP foundation</p>
      <h2>One pending-replies queue for every GoHighLevel subaccount.</h2>
      <p className="muted">
        AgentFlow mirrors SMS and email webhooks into channel-agnostic contact
        threads. Any outbound reply clears the pending state, so an SMS can
        resolve a pending email and an email can resolve a pending SMS.
      </p>
      <div className="badge-row" style={{ margin: "20px 0" }}>
        <span className="badge">SMS</span>
        <span className="badge">Email</span>
        <span className="badge">Calls excluded</span>
        <span className="badge">No stored tags/custom fields</span>
      </div>
      <Link className="button" href="/threads">
        Open pending replies
      </Link>
    </section>
  );
}

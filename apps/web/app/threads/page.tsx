import Link from "next/link";

export default function ThreadsPage() {
  return (
    <section className="panel" style={{ padding: 18 }}>
      <p className="eyebrow">Inbox paused</p>
      <h2>Message inbox is temporarily disabled.</h2>
      <p className="muted">
        For now we are not listening to inbound/outbound message webhooks to reduce database load.
      </p>
      <div className="badge-row" style={{ marginTop: 12 }}>
        <Link className="button" href="/appointments">
          Go to appointments
        </Link>
      </div>
    </section>
  );
}

import Link from "next/link";

export const runtime = "edge";

export default function ThreadMessagesPage() {
  return (
    <section className="panel" style={{ padding: 18 }}>
      <p className="eyebrow">Inbox paused</p>
      <h2>Thread detail is disabled for now.</h2>
      <p className="muted">
        Message read/reply workflows are temporarily hidden while we focus on unpaid appointments.
      </p>
      <div className="badge-row" style={{ marginTop: 12 }}>
        <Link className="button secondary" href="/appointments">
          Back to appointments
        </Link>
      </div>
    </section>
  );
}

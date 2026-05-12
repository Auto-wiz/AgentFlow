"use client";

import type { ThreadMessagesResponse } from "@agentflow/shared";
import Link from "next/link";
import { useEffect, useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export const runtime = "edge";

export default function ThreadMessagesPage({ params }: { params: { id: string } }) {
  const [data, setData] = useState<ThreadMessagesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadMessages() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${apiBaseUrl}/threads/${params.id}/messages`, {
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error("Failed to load thread");
        }
        setData((await response.json()) as ThreadMessagesResponse);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Failed to load thread");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    loadMessages();
    return () => controller.abort();
  }, [params.id]);

  async function markRead() {
    const response = await fetch(`${apiBaseUrl}/threads/${params.id}/read`, {
      method: "POST"
    });
    if (response.ok && data) {
      setData({
        ...data,
        thread: { ...data.thread, pendingReply: false, unreadCount: 0 }
      });
    }
  }

  if (loading) {
    return <div className="panel empty muted">Loading thread...</div>;
  }

  if (error || !data) {
    return <div className="panel empty">{error ?? "Thread unavailable"}</div>;
  }

  return (
    <section>
      <div className="toolbar">
        <Link className="button secondary" href="/threads">
          Back to threads
        </Link>
        <button className="button" onClick={markRead}>
          Mark read
        </button>
      </div>

      <div className="panel" style={{ padding: 22, marginBottom: 18 }}>
        <p className="eyebrow">{data.thread.locationName ?? data.thread.ghlLocationId}</p>
        <h2>{data.thread.contactName}</h2>
        <div className="badge-row">
          {data.thread.pendingReply ? <span className="badge">Pending reply</span> : null}
          {data.thread.contactEmail ? <span className="badge">{data.thread.contactEmail}</span> : null}
          {data.thread.contactPhone ? <span className="badge">{data.thread.contactPhone}</span> : null}
        </div>
        <div className="details-grid">
          <div>
            <strong>Tags from GHL</strong>
            <p className="muted">
              {data.contactDetails?.tags.length
                ? data.contactDetails.tags.join(", ")
                : "Not available or no API token configured"}
            </p>
          </div>
          <div>
            <strong>Custom fields from GHL</strong>
            <p className="muted">
              {data.contactDetails?.customFields.length
                ? `${data.contactDetails.customFields.length} fields loaded on demand`
                : "Not stored locally"}
            </p>
          </div>
        </div>
      </div>

      <div className="messages">
        {data.messages.map((message) => (
          <article className={`message ${message.direction}`} key={message.id}>
            <div className="badge-row" style={{ marginBottom: 8 }}>
              <span className="badge">{message.channel}</span>
              <span className="badge">{message.direction}</span>
              <span className="badge">{new Date(message.sentAt).toLocaleString()}</span>
            </div>
            {message.subject ? <strong>{message.subject}</strong> : null}
            <p>{message.body ?? "(No body)"}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

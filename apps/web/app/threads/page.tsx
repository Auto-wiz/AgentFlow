"use client";

import type { ThreadSummary } from "@agentflow/shared";
import Link from "next/link";
import { useEffect, useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://api.agentflow.autowiz.net";

function formatLocationName(locationName: string | null, ghlLocationId: string) {
  return locationName ? `${locationName} (${ghlLocationId})` : ghlLocationId;
}

export default function ThreadsPage() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [locationId, setLocationId] = useState("");
  const [pendingOnly, setPendingOnly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadThreads() {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (pendingOnly) {
        params.set("pendingReply", "true");
      }
      if (locationId.trim()) {
        params.set("locationId", locationId.trim());
      }

      try {
        const response = await fetch(`${apiBaseUrl}/threads?${params.toString()}`, {
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error("Failed to load threads");
        }
        const data = (await response.json()) as { threads: ThreadSummary[] };
        setThreads(data.threads);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Failed to load threads");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    loadThreads();
    return () => controller.abort();
  }, [locationId, pendingOnly]);

  return (
    <section>
      <div className="toolbar">
        <input
          aria-label="GoHighLevel location ID"
          placeholder="Filter by locationId"
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
        />
        <button className="button secondary" onClick={() => setPendingOnly((value) => !value)}>
          {pendingOnly ? "Showing pending" : "Showing all"}
        </button>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        {loading ? <div className="empty muted">Loading threads...</div> : null}
        {error ? <div className="empty">{error}</div> : null}
        {!loading && !error && threads.length === 0 ? (
          <div className="empty muted">No threads found.</div>
        ) : null}
        <div className="thread-list">
          {threads.map((thread) => (
            <Link
              className={`thread-card ${thread.pendingReply ? "pending" : ""}`}
              href={`/threads/${thread.id}`}
              key={thread.id}
            >
              <strong>{thread.contactName}</strong>
              <span className="muted">
                {formatLocationName(thread.locationName, thread.ghlLocationId)} -{" "}
                {thread.lastMessageAt
                  ? new Date(thread.lastMessageAt).toLocaleString()
                  : "No messages yet"}
              </span>
              <div className="badge-row">
                {thread.pendingReply ? <span className="badge">Pending reply</span> : null}
                <span className="badge">{thread.unreadCount} unread</span>
                {thread.contactEmail ? <span className="badge">{thread.contactEmail}</span> : null}
                {thread.contactPhone ? <span className="badge">{thread.contactPhone}</span> : null}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

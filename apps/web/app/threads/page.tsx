"use client";

import type { SubaccountOverview, ThreadSummary } from "@agentflow/shared";
import Link from "next/link";
import { useEffect, useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://api.agentflow.autowiz.net";
const viewerKey = "default";

function formatLocationName(locationName: string | null, ghlLocationId: string) {
  return locationName ? `${locationName} (${ghlLocationId})` : ghlLocationId;
}

export default function ThreadsPage() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [subaccounts, setSubaccounts] = useState<SubaccountOverview[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [pendingOnly, setPendingOnly] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadThreads() {
      setLoading(true);
      setError(null);

      try {
        const subaccountsResponse = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=threads`, {
          signal: controller.signal,
          headers: {
            "x-viewer-key": viewerKey
          }
        });
        if (!subaccountsResponse.ok) {
          throw new Error("Failed to load subaccounts");
        }
        const subaccountsData = (await subaccountsResponse.json()) as {
          subaccounts: SubaccountOverview[];
        };
        setSubaccounts(subaccountsData.subaccounts);

        let nextSelectedLocationId = selectedLocationId;
        if (
          nextSelectedLocationId &&
          !subaccountsData.subaccounts.some(
            (subaccount) => subaccount.locationId === nextSelectedLocationId
          )
        ) {
          nextSelectedLocationId = "";
          setSelectedLocationId("");
        }

        const params = new URLSearchParams();
        if (pendingOnly) {
          params.set("pendingReply", "true");
        }
        if (nextSelectedLocationId) {
          params.set("locationId", nextSelectedLocationId);
        }

        const response = await fetch(`${apiBaseUrl}/threads?${params.toString()}`, {
          signal: controller.signal,
          headers: {
            "x-viewer-key": viewerKey
          }
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
  }, [selectedLocationId, pendingOnly]);

  const totalPending = subaccounts.reduce((sum, subaccount) => sum + subaccount.pendingCount, 0);

  return (
    <section className="split-layout">
      <aside className="panel subaccount-sidebar">
        <p className="eyebrow">Subaccounts</p>
        <h3 style={{ marginTop: 8 }}>Pending replies</h3>
        <div className="subaccount-list">
          <button
            className={`subaccount-item ${selectedLocationId ? "" : "active"}`}
            onClick={() => setSelectedLocationId("")}
            type="button"
          >
            <strong>All tracked subaccounts</strong>
            <span className="muted">{totalPending} pending</span>
          </button>
          {subaccounts.map((subaccount) => (
            <button
              className={`subaccount-item ${
                selectedLocationId === subaccount.locationId ? "active" : ""
              }`}
              key={subaccount.locationId}
              onClick={() => setSelectedLocationId(subaccount.locationId)}
              type="button"
            >
              <strong>{formatLocationName(subaccount.locationName, subaccount.ghlLocationId)}</strong>
              <span className="muted">{subaccount.pendingCount} pending</span>
            </button>
          ))}
        </div>
      </aside>

      <div>
        <div className="toolbar">
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
      </div>
    </section>
  );
}

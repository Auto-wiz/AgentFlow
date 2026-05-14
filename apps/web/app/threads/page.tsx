"use client";

import type { SubaccountOverview, ThreadMessagesResponse, ThreadSummary } from "@agentflow/shared";
import { getApiBaseUrl } from "../../lib/api-base-url";
import { useEffect, useState } from "react";

const viewerKey = "default";

function formatLocationName(locationName: string | null, ghlLocationId: string) {
  return locationName ? `${locationName} (${ghlLocationId})` : ghlLocationId;
}

export default function ThreadsPage() {
  const apiBaseUrl = getApiBaseUrl();
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [subaccounts, setSubaccounts] = useState<SubaccountOverview[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [threadData, setThreadData] = useState<ThreadMessagesResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
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

        const listUrl = params.toString() ? `${apiBaseUrl}/threads?${params.toString()}` : `${apiBaseUrl}/threads`;
        const response = await fetch(listUrl, {
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
        setSelectedThreadId((current) => {
          if (current && data.threads.some((thread) => thread.id === current)) {
            return current;
          }
          return data.threads[0]?.id ?? "";
        });
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

  useEffect(() => {
    const controller = new AbortController();
    if (!selectedThreadId) {
      setThreadData(null);
      setDetailError(null);
      setDetailLoading(false);
      return () => controller.abort();
    }

    async function loadThreadDetails() {
      setDetailLoading(true);
      setDetailError(null);
      try {
        const response = await fetch(`${apiBaseUrl}/threads/${selectedThreadId}/messages`, {
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error("Failed to load selected conversation");
        }
        const data = (await response.json()) as ThreadMessagesResponse;
        setThreadData(data);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setDetailError(
            caught instanceof Error ? caught.message : "Failed to load selected conversation"
          );
        }
      } finally {
        if (!controller.signal.aborted) {
          setDetailLoading(false);
        }
      }
    }

    loadThreadDetails();
    return () => controller.abort();
  }, [apiBaseUrl, selectedThreadId]);

  const totalPending = subaccounts.reduce((sum, subaccount) => sum + subaccount.pendingCount, 0);
  const selectedThreadSummary = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const selectedLocationLabel = selectedThreadSummary
    ? formatLocationName(selectedThreadSummary.locationName, selectedThreadSummary.ghlLocationId)
    : "No conversation selected";

  async function markSelectedRead() {
    if (!selectedThreadId) {
      return;
    }
    const response = await fetch(`${apiBaseUrl}/threads/${selectedThreadId}/read`, {
      method: "POST"
    });
    if (!response.ok) {
      return;
    }
    setThreads((current) =>
      current.map((thread) =>
        thread.id === selectedThreadId ? { ...thread, pendingReply: false, unreadCount: 0 } : thread
      )
    );
    setThreadData((current) =>
      current
        ? {
            ...current,
            thread: {
              ...current.thread,
              pendingReply: false,
              unreadCount: 0
            }
          }
        : current
    );
  }

  return (
    <section className="ghl-inbox-shell">
      <aside className="panel inbox-subaccounts">
        <p className="eyebrow">Advanced filters</p>
        <h3 style={{ marginTop: 8 }}>Subaccounts</h3>
        <div className="subaccount-list">
          <button
            className={`subaccount-item ${selectedLocationId ? "" : "active"}`}
            onClick={() => setSelectedLocationId("")}
            type="button"
          >
            <strong>All tracked subaccounts</strong>
            <span className="muted">{totalPending} pending replies</span>
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

      <div className="panel inbox-conversation-list">
        <div className="inbox-panel-header">
          <div>
            <p className="eyebrow">Inbox</p>
            <h3 style={{ marginTop: 8 }}>Pending replies</h3>
          </div>
          <button className="button secondary" onClick={() => setPendingOnly((value) => !value)}>
            {pendingOnly ? "Pending only" : "All conversations"}
          </button>
        </div>

        {loading ? <div className="empty muted">Loading conversations...</div> : null}
        {error ? <div className="empty">{error}</div> : null}
        {!loading && !error && threads.length === 0 ? (
          <div className="empty muted">No conversations found.</div>
        ) : null}

        <div className="inbox-conversation-items">
          {threads.map((thread) => (
            <button
              className={`inbox-conversation-item ${thread.id === selectedThreadId ? "active" : ""}`}
              key={thread.id}
              onClick={() => setSelectedThreadId(thread.id)}
              type="button"
            >
              <div className="inbox-conversation-row">
                <strong>{thread.contactName}</strong>
                <span className="muted">
                  {thread.lastMessageAt ? new Date(thread.lastMessageAt).toLocaleTimeString() : "No time"}
                </span>
              </div>
              <span className="muted">{formatLocationName(thread.locationName, thread.ghlLocationId)}</span>
              <div className="badge-row">
                {thread.pendingReply ? <span className="badge">Pending</span> : null}
                <span className="badge">{thread.unreadCount} unread</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="panel inbox-thread-view">
        <div className="inbox-thread-header">
          <div>
            <p className="eyebrow">{selectedLocationLabel}</p>
            <h3 style={{ marginTop: 8 }}>
              {threadData?.thread.contactName ?? selectedThreadSummary?.contactName ?? "Select a conversation"}
            </h3>
            <p className="muted">
              {threadData?.thread.contactEmail ??
                selectedThreadSummary?.contactEmail ??
                threadData?.thread.contactPhone ??
                selectedThreadSummary?.contactPhone ??
                "No contact details available yet"}
            </p>
          </div>
          <button className="button secondary" disabled={!threadData} onClick={markSelectedRead}>
            Mark read
          </button>
        </div>

        {detailLoading ? <div className="empty muted">Loading thread...</div> : null}
        {detailError ? <div className="empty">{detailError}</div> : null}
        {!detailLoading && !detailError && !threadData ? (
          <div className="empty muted">Select a conversation to view messages.</div>
        ) : null}

        {!detailLoading && !detailError && threadData ? (
          <>
            <div className="inbox-message-list">
              {threadData.messages.map((message) => (
                <article className={`inbox-message-bubble ${message.direction}`} key={message.id}>
                  {message.subject ? <strong>{message.subject}</strong> : null}
                  <p>{message.body ?? "(No body)"}</p>
                  <span className="muted">{new Date(message.sentAt).toLocaleString()}</span>
                </article>
              ))}
            </div>
            <div className="inbox-composer">
              <input disabled placeholder="Type a response... (messaging composer coming next)" />
              <button className="button" disabled type="button">
                Send
              </button>
            </div>
          </>
        ) : null}
      </div>

      <aside className="panel inbox-contact-panel">
        <p className="eyebrow">Contact details</p>
        <h3 style={{ marginTop: 8 }}>
          {threadData?.thread.contactName ?? selectedThreadSummary?.contactName ?? "No contact selected"}
        </h3>
        <div className="inbox-contact-metric">
          <span className="muted">Unread messages</span>
          <strong>{threadData?.thread.unreadCount ?? selectedThreadSummary?.unreadCount ?? 0}</strong>
        </div>
        <div className="inbox-contact-section">
          <strong>Tags</strong>
          <div className="badge-row">
            {threadData?.contactDetails?.tags?.length ? (
              threadData.contactDetails.tags.map((tag) => (
                <span className="badge" key={tag}>
                  {tag}
                </span>
              ))
            ) : (
              <span className="muted">No tags available yet.</span>
            )}
          </div>
        </div>
        <div className="inbox-contact-section">
          <strong>Email</strong>
          <p className="muted">
            {threadData?.thread.contactEmail ??
              selectedThreadSummary?.contactEmail ??
              "Email will appear after contact sync"}
          </p>
        </div>
        <div className="inbox-contact-section">
          <strong>Phone</strong>
          <p className="muted">
            {threadData?.thread.contactPhone ??
              selectedThreadSummary?.contactPhone ??
              "Phone will appear after contact sync"}
          </p>
        </div>
      </aside>
    </section>
  );
}

"use client";

import type {
  OpportunityStageOption,
  SubaccountOverview,
  ThreadMessagesResponse,
  ThreadOpportunitiesResponse,
  ThreadOpportunity,
  ThreadSummary
} from "@agentflow/shared";
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
  const [subaccountSearch, setSubaccountSearch] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [selectedUserFilter, setSelectedUserFilter] = useState("all");
  const [conversationFilter, setConversationFilter] = useState<"all" | "pending">("all");
  const [selectedThreadId, setSelectedThreadId] = useState("");
  const [threadData, setThreadData] = useState<ThreadMessagesResponse | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [opportunities, setOpportunities] = useState<ThreadOpportunity[]>([]);
  const [stageOptions, setStageOptions] = useState<OpportunityStageOption[]>([]);
  const [opportunityDrafts, setOpportunityDrafts] = useState<Record<string, { stageId: string; status: string }>>(
    {}
  );
  const [opportunitiesLoading, setOpportunitiesLoading] = useState(false);
  const [opportunitiesError, setOpportunitiesError] = useState<string | null>(null);
  const [savingOpportunityId, setSavingOpportunityId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
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
        if (conversationFilter === "pending") {
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
  }, [apiBaseUrl, selectedLocationId, conversationFilter, reloadKey]);

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
  }, [apiBaseUrl, selectedThreadId, reloadKey]);

  useEffect(() => {
    const controller = new AbortController();
    if (!selectedThreadId) {
      setOpportunities([]);
      setStageOptions([]);
      setOpportunityDrafts({});
      setOpportunitiesError(null);
      setOpportunitiesLoading(false);
      return () => controller.abort();
    }

    async function loadOpportunities() {
      setOpportunitiesLoading(true);
      setOpportunitiesError(null);
      try {
        const response = await fetch(`${apiBaseUrl}/threads/${selectedThreadId}/opportunities`, {
          signal: controller.signal
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? "Failed to load opportunities");
        }
        const data = (await response.json()) as ThreadOpportunitiesResponse;
        if (controller.signal.aborted) {
          return;
        }
        setOpportunities(data.opportunities);
        setStageOptions(data.stageOptions);
        setOpportunityDrafts(buildOpportunityDraftMap(data.opportunities));
      } catch (caught) {
        if (!controller.signal.aborted) {
          setOpportunitiesError(caught instanceof Error ? caught.message : "Failed to load opportunities");
        }
      } finally {
        if (!controller.signal.aborted) {
          setOpportunitiesLoading(false);
        }
      }
    }

    loadOpportunities();
    return () => controller.abort();
  }, [apiBaseUrl, selectedThreadId, reloadKey]);

  const totalPending = subaccounts.reduce((sum, subaccount) => sum + subaccount.pendingCount, 0);
  const totalConversations = subaccounts.reduce(
    (sum, subaccount) => sum + subaccount.conversationCount,
    0
  );
  const filteredSubaccounts = subaccounts.filter((subaccount) => {
    const query = subaccountSearch.trim().toLowerCase();
    if (!query) {
      return true;
    }
    return (
      subaccount.ghlLocationId.toLowerCase().includes(query) ||
      (subaccount.locationName ?? "").toLowerCase().includes(query)
    );
  });
  const selectedThreadSummary = threads.find((thread) => thread.id === selectedThreadId) ?? null;
  const selectedLocationLabel = selectedThreadSummary
    ? formatLocationName(selectedThreadSummary.locationName, selectedThreadSummary.ghlLocationId)
    : "No conversation selected";
  const selectedContact = threadData?.contactDetails;
  const selectedContactName = resolveContactDisplayName({
    preferredName: selectedContact?.fullName ?? null,
    fallbackName: threadData?.thread.contactName ?? selectedThreadSummary?.contactName ?? null,
    email: selectedContact?.email ?? threadData?.thread.contactEmail ?? selectedThreadSummary?.contactEmail ?? null,
    phone: selectedContact?.phone ?? threadData?.thread.contactPhone ?? selectedThreadSummary?.contactPhone ?? null
  });
  const selectedContactInitial = selectedContactName.slice(0, 1).toUpperCase() || "?";

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

  async function sendReply() {
    const message = replyDraft.trim();
    if (!selectedThreadId || !message || replySending) {
      return;
    }

    setReplySending(true);
    setReplyError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/threads/${selectedThreadId}/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          channel: "sms",
          message
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Failed to send reply");
      }

      setReplyDraft("");
      setThreads((current) =>
        current.map((thread) =>
          thread.id === selectedThreadId
            ? {
                ...thread,
                pendingReply: false,
                unreadCount: 0,
                lastMessageAt: new Date().toISOString()
              }
            : thread
        )
      );
      setReloadKey((value) => value + 1);
    } catch (caught) {
      setReplyError(caught instanceof Error ? caught.message : "Failed to send reply");
    } finally {
      setReplySending(false);
    }
  }

  function renderContactValue(value: string | null | undefined, fallback: string) {
    if (!value || !value.trim()) {
      return <span className="muted">{fallback}</span>;
    }
    return value;
  }

  async function saveOpportunity(opportunityId: string) {
    if (!selectedThreadId || savingOpportunityId) {
      return;
    }
    const draft = opportunityDrafts[opportunityId];
    if (!draft) {
      return;
    }

    setSavingOpportunityId(opportunityId);
    setOpportunitiesError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/threads/${selectedThreadId}/opportunities/${opportunityId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          stageId: draft.stageId || null,
          status: draft.status || null
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Failed to update opportunity");
      }
      const data = (await response.json()) as ThreadOpportunitiesResponse;
      setOpportunities(data.opportunities);
      setStageOptions(data.stageOptions);
      setOpportunityDrafts(buildOpportunityDraftMap(data.opportunities));
    } catch (caught) {
      setOpportunitiesError(caught instanceof Error ? caught.message : "Failed to update opportunity");
    } finally {
      setSavingOpportunityId(null);
    }
  }

  return (
    <section className="ghl-inbox-shell">
      <aside className="panel inbox-subaccounts">
        <p className="eyebrow">Filters</p>
        <h3 style={{ marginTop: 8 }}>Subaccounts</h3>
        <div className="toolbar inbox-subaccount-search">
          <input
            aria-label="Search subaccounts"
            placeholder="Search subaccount"
            value={subaccountSearch}
            onChange={(event) => setSubaccountSearch(event.target.value)}
          />
        </div>
        <div className="inbox-filter-block">
          <label className="inbox-field-label" htmlFor="inbox-user-filter">
            User
          </label>
          <select
            id="inbox-user-filter"
            value={selectedUserFilter}
            onChange={(event) => setSelectedUserFilter(event.target.value)}
          >
            <option value="all">All users</option>
            <option value="coming-soon" disabled>
              User groups (coming soon)
            </option>
          </select>
        </div>
        <div className="subaccount-list">
          <button
            className={`subaccount-item subaccount-item-compact ${selectedLocationId ? "" : "active"}`}
            onClick={() => setSelectedLocationId("")}
            type="button"
          >
            <strong>All tracked subaccounts</strong>
            <span className="muted">
              {totalConversations} conversations · {totalPending} pending
            </span>
          </button>
          {filteredSubaccounts.map((subaccount) => (
            <button
              className={`subaccount-item subaccount-item-compact ${
                selectedLocationId === subaccount.locationId ? "active" : ""
              }`}
              key={subaccount.locationId}
              onClick={() => setSelectedLocationId(subaccount.locationId)}
              type="button"
            >
              <strong>{formatLocationName(subaccount.locationName, subaccount.ghlLocationId)}</strong>
              <span className="muted">
                {subaccount.conversationCount} conv · {subaccount.pendingCount} pending
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="panel inbox-conversation-list">
        <div className="inbox-panel-header">
          <div>
            <p className="eyebrow">Inbox</p>
            <h3 style={{ marginTop: 8 }}>All conversations</h3>
          </div>
          <div className="inbox-tabs" role="tablist" aria-label="Conversation filters">
            <button
              className={`inbox-tab ${conversationFilter === "all" ? "active" : ""}`}
              onClick={() => setConversationFilter("all")}
              type="button"
            >
              All conversations
            </button>
            <button
              className={`inbox-tab ${conversationFilter === "pending" ? "active" : ""}`}
              onClick={() => setConversationFilter("pending")}
              type="button"
            >
              Pending replies
            </button>
          </div>
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
                <strong>
                  {resolveContactDisplayName({
                    preferredName: null,
                    fallbackName: thread.contactName,
                    email: thread.contactEmail,
                    phone: thread.contactPhone
                  })}
                </strong>
                <span className="muted">
                  {thread.lastMessageAt ? new Date(thread.lastMessageAt).toLocaleTimeString() : "--:--"}
                </span>
              </div>
              <span className="muted">{formatLocationName(thread.locationName, thread.ghlLocationId)}</span>
              <div className="inbox-status-row">
                {thread.pendingReply ? <span className="inbox-status-chip">Pending</span> : null}
                <span className="inbox-status-chip">{thread.unreadCount} unread</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="panel inbox-thread-view">
        <div className="inbox-thread-header">
          <div>
            <p className="eyebrow">{selectedLocationLabel}</p>
            <h3 style={{ marginTop: 8 }}>{selectedContactName || "Select a conversation"}</h3>
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
              <input
                placeholder={
                  selectedThreadId
                    ? `Type a response to ${selectedThreadSummary?.contactName ?? "contact"}...`
                    : "Select a conversation to reply"
                }
                value={replyDraft}
                onChange={(event) => setReplyDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendReply();
                  }
                }}
              />
              <button
                className="button"
                disabled={!selectedThreadId || !replyDraft.trim() || replySending}
                onClick={sendReply}
                type="button"
              >
                {replySending ? "Sending..." : "Send"}
              </button>
            </div>
            {replyError ? <p className="inbox-reply-error">{replyError}</p> : null}
          </>
        ) : null}
      </div>

      <aside className="panel inbox-contact-panel">
        <div className="inbox-contact-header">
          <div className="inbox-contact-avatar">{selectedContactInitial}</div>
          <div>
            <p className="eyebrow">Contact details</p>
            <h3 style={{ marginTop: 8 }}>{selectedContactName}</h3>
            <p className="muted">{selectedLocationLabel}</p>
          </div>
        </div>
        <div className="inbox-contact-metric">
          <span className="muted">Unread messages</span>
          <strong>{threadData?.thread.unreadCount ?? selectedThreadSummary?.unreadCount ?? 0}</strong>
        </div>
        <section className="inbox-opportunity-card panel">
          <div className="inbox-opportunity-header">
            <strong>Opportunity pipeline</strong>
            <span className="muted">{opportunities.length} records</span>
          </div>
          {opportunitiesLoading ? <p className="muted">Loading opportunities...</p> : null}
          {opportunitiesError ? <p className="inbox-reply-error">{opportunitiesError}</p> : null}
          {!opportunitiesLoading && !opportunitiesError && opportunities.length === 0 ? (
            <p className="muted">No opportunities linked to this contact yet.</p>
          ) : null}
          <div className="inbox-opportunity-list">
            {opportunities.map((opportunity) => {
              const draft = opportunityDrafts[opportunity.id] ?? {
                stageId: opportunity.stageId ?? "",
                status: opportunity.status ?? "open"
              };
              const stagesForOpportunity =
                opportunity.pipelineId != null
                  ? stageOptions.filter((stage) => stage.pipelineId === opportunity.pipelineId)
                  : stageOptions;
              return (
                <article className="inbox-opportunity-item" key={opportunity.id}>
                  <div className="inbox-opportunity-row">
                    <strong>{opportunity.name ?? `Opportunity ${opportunity.id.slice(0, 8)}`}</strong>
                    <span className="muted">
                      {formatOpportunityValue(opportunity.monetaryValue, opportunity.currency)}
                    </span>
                  </div>
                  <div className="inbox-opportunity-row">
                    <span className="muted">Stage: {opportunity.stageName ?? "Not set"}</span>
                    <span className="muted">Status: {opportunity.status ?? "open"}</span>
                  </div>
                  <div className="inbox-opportunity-controls">
                    <select
                      aria-label={`Stage for ${opportunity.name ?? opportunity.id}`}
                      value={draft.stageId}
                      onChange={(event) =>
                        setOpportunityDrafts((current) => ({
                          ...current,
                          [opportunity.id]: {
                            ...draft,
                            stageId: event.target.value
                          }
                        }))
                      }
                    >
                      <option value="">Keep stage</option>
                      {stagesForOpportunity.map((stage) => (
                        <option key={stage.id} value={stage.id}>
                          {stage.pipelineName ? `${stage.pipelineName} · ` : ""}
                          {stage.name}
                        </option>
                      ))}
                    </select>
                    <select
                      aria-label={`Status for ${opportunity.name ?? opportunity.id}`}
                      value={draft.status}
                      onChange={(event) =>
                        setOpportunityDrafts((current) => ({
                          ...current,
                          [opportunity.id]: {
                            ...draft,
                            status: event.target.value
                          }
                        }))
                      }
                    >
                      {["open", "won", "lost", "abandoned"].map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                    <button
                      className="button secondary"
                      disabled={savingOpportunityId === opportunity.id}
                      onClick={() => saveOpportunity(opportunity.id)}
                      type="button"
                    >
                      {savingOpportunityId === opportunity.id ? "Updating..." : "Update"}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
        <div className="inbox-contact-section">
          <strong>Email</strong>
          <p>
            {renderContactValue(
              selectedContact?.email ?? threadData?.thread.contactEmail ?? selectedThreadSummary?.contactEmail,
              "Email unavailable"
            )}
          </p>
        </div>
        <div className="inbox-contact-section">
          <strong>Phone</strong>
          <p>
            {renderContactValue(
              selectedContact?.phone ?? threadData?.thread.contactPhone ?? selectedThreadSummary?.contactPhone,
              "Phone unavailable"
            )}
          </p>
        </div>
        <div className="inbox-contact-section">
          <strong>Company</strong>
          <p>{renderContactValue(selectedContact?.companyName, "Company unavailable")}</p>
        </div>
        <div className="inbox-contact-section">
          <strong>Address</strong>
          <p>
            {renderContactValue(
              [selectedContact?.address1, selectedContact?.city, selectedContact?.state, selectedContact?.country]
                .filter(Boolean)
                .join(", "),
              "Address unavailable"
            )}
          </p>
        </div>
        <div className="inbox-contact-section">
          <strong>Source</strong>
          <p>{renderContactValue(selectedContact?.source, "Source unavailable")}</p>
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
          <strong>Custom fields</strong>
          <div className="inbox-contact-field-list">
            {selectedContact?.customFields?.length ? (
              selectedContact.customFields.slice(0, 8).map((field, index) => (
                <div className="inbox-contact-field-row" key={`${field.id ?? field.name ?? "field"}-${index}`}>
                  <span className="muted">{field.name ?? field.id ?? "Field"}</span>
                  <span>{stringifyFieldValue(field.value)}</span>
                </div>
              ))
            ) : (
              <span className="muted">No custom fields returned by GHL.</span>
            )}
          </div>
        </div>
        <div className="inbox-contact-section">
          <strong>Activity</strong>
          <p>{renderContactValue(selectedContact?.lastActivityDate, "No activity date from GHL")}</p>
        </div>
      </aside>
    </section>
  );
}

function stringifyFieldValue(value: unknown) {
  if (value == null) {
    return "—";
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function resolveContactDisplayName(params: {
  preferredName: string | null;
  fallbackName: string | null;
  email: string | null;
  phone: string | null;
}) {
  const normalizedPreferred = params.preferredName?.trim() || null;
  if (normalizedPreferred) {
    return normalizedPreferred;
  }
  const normalizedFallback = params.fallbackName?.trim() || null;
  if (normalizedFallback && normalizedFallback.toLowerCase() !== "unknown contact") {
    return normalizedFallback;
  }
  return params.email ?? params.phone ?? "Unknown contact";
}

function buildOpportunityDraftMap(opportunities: ThreadOpportunity[]) {
  return opportunities.reduce<Record<string, { stageId: string; status: string }>>((acc, opportunity) => {
    acc[opportunity.id] = {
      stageId: opportunity.stageId ?? "",
      status: opportunity.status ?? "open"
    };
    return acc;
  }, {});
}

function formatOpportunityValue(value: number | null, currency: string | null) {
  if (value == null) {
    return "No value";
  }
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: (currency ?? "USD").toUpperCase(),
      maximumFractionDigits: 0
    }).format(value);
  } catch {
    return `${currency ?? "$"} ${value}`;
  }
}

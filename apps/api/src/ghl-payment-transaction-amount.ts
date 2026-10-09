/** Statuses that mean money was collected. Matched case-insensitively. */
export const COLLECTED_TRANSACTION_STATUSES = [
  "succeeded",
  "paid",
  "successful",
  "completed",
  "complete"
] as const;

export type ParsedGhlTransaction = {
  ghlTransactionId: string;
  status: string | null;
  amount: number | null;
  amountRefunded: number | null;
  currency: string | null;
  entityId: string | null;
  entityType: string | null;
  ghlCreatedAt: string | null;
  ghlUpdatedAt: string | null;
  raw: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function roundMajorUnits(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric);
}

export function transactionStatusLabel(status: unknown): string | null {
  const direct = stringOrNull(status);
  if (direct) return direct;
  const record = asRecord(status);
  if (!record) return null;
  return stringOrNull(record.status ?? record.value ?? record.name);
}

export function isCollectedTransactionStatus(status: string | null | undefined): boolean {
  const normalized = (status ?? "").trim().toLowerCase();
  return (COLLECTED_TRANSACTION_STATUSES as readonly string[]).includes(normalized);
}

export function parseGhlTransactionsPayload(payload: unknown): ParsedGhlTransaction[] {
  const root = asRecord(payload);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.transactions)
        ? root.transactions
        : [];
  const parsed: ParsedGhlTransaction[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    const ghlTransactionId = stringOrNull(record._id ?? record.id ?? record.transactionId);
    if (!ghlTransactionId) continue;
    parsed.push({
      ghlTransactionId,
      status: transactionStatusLabel(record.status),
      amount: roundMajorUnits(record.amount),
      amountRefunded: roundMajorUnits(record.amountRefunded ?? record.amount_refunded),
      currency: stringOrNull(record.currency),
      entityId: stringOrNull(record.entityId ?? record.entity_id),
      entityType: stringOrNull(record.entityType ?? record.entity_type),
      ghlCreatedAt: stringOrNull(record.createdAt ?? record.created_at),
      ghlUpdatedAt: stringOrNull(record.updatedAt ?? record.updated_at),
      raw: record
    });
  }
  return parsed;
}

export function netCollectedMajorUnits(transactions: ParsedGhlTransaction[]): number {
  let total = 0;
  for (const transaction of transactions) {
    if (!isCollectedTransactionStatus(transaction.status)) continue;
    const net = Math.max(0, (transaction.amount ?? 0) - (transaction.amountRefunded ?? 0));
    total += net;
  }
  return total;
}

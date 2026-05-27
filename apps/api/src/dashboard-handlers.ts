import {
  createDb,
  appointments,
  ghlPaymentOrders,
  invoices,
  locationCalendars,
  locations,
  paymentSources
} from "@agentflow/db";
import { and, asc, eq, inArray, not, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { Context } from "hono";

import {
  appointmentCancelledOnlySql,
  buildAppointmentEffectivePaidSql,
  invoicePaidSignalSql,
  orderCountsAsPaidInSql
} from "./appointment-payment-sql.js";
import {
  canWorkspaceAccessLocationUuid,
  getHiddenLocationIdsForPolicy,
  jwtWorkspaceAllowedLocationUuidList,
  resolveAccessPolicy,
  type AccessPolicy,
  type WorkspaceJwtEnv
} from "./workspace-access.js";

import type { GhlOAuthTokenEnv } from "./ghl-oauth-location-token.js";
import {
  reconcileCalendarBucketsWithStoredLocationCalendarNames
} from "./dashboard-calendar-ghl-names.js";

type Env = WorkspaceJwtEnv & GhlOAuthTokenEnv;

function formatDashboardHandlerError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const parts: string[] = [error.message];
  let cursor: unknown = error.cause;
  for (let i = 0; i < 4 && cursor instanceof Error; i++) {
    parts.push(`cause: ${cursor.message}`);
    cursor = cursor.cause;
  }
  return parts.join(" | ");
}

/**
 * Dashboard deposit sums use the same integer storage as webhooks (`normalizeMoneyAmount` → rounded major
 * currency units from GoHighLevel, typically whole USD — not cents). Formatting must not divide by 100.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string) {
  return UUID_RE.test(value.trim());
}

function appendJwtWorkspaceLocationConstraint(
  filters: SQL[],
  allowed: string[] | null,
  locationIdColumn: typeof appointments.locationId
) {
  if (allowed === null) {
    return;
  }
  filters.push(allowed.length === 0 ? sql`false` : inArray(locationIdColumn, allowed));
}

function parseUtcMidnightBoundary(isoDay: string, endInclusive: boolean): Date | null {
  const trimmed = isoDay.trim();
  const dm = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dm) {
    const y = Number(dm[1]);
    const m = Number(dm[2]) - 1;
    const d = Number(dm[3]);
    const dt = new Date(Date.UTC(y, m, d, 0, 0, 0, 0));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m || dt.getUTCDate() !== d) {
      return null;
    }
    if (endInclusive) {
      return new Date(Date.UTC(y, m, d + 1, 0, 0, 0, 0));
    }
    return dt;
  }
  const t = Date.parse(trimmed);
  if (!Number.isFinite(t)) {
    return null;
  }
  const dt = new Date(t);
  if (endInclusive) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    dt.setUTCHours(0, 0, 0, 0);
    return dt;
  }
  dt.setUTCHours(0, 0, 0, 0);
  return dt;
}

export function resolveDashboardBounds(
  fromRaw: string | undefined,
  toRaw: string | undefined
): { from: Date; toExclusive: Date } | { error: string } {
  const now = new Date();
  const defaultToExclusive = parseUtcMidnightBoundary(now.toISOString().slice(0, 10), true);
  if (!defaultToExclusive) {
    return { error: "invalid_default_to" };
  }
  /** Default inclusive window: roughly last 30 local-midnight slices ending today UTC. */
  const defaultFrom = new Date(defaultToExclusive.getTime());
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);

  const fromProvided = typeof fromRaw === "string" && fromRaw.trim() !== "";
  const toInclusiveProvided = typeof toRaw === "string" && toRaw.trim() !== "";

  if (fromProvided !== toInclusiveProvided) {
    return { error: "from_and_to_both_required" };
  }

  if (fromProvided && toInclusiveProvided && fromRaw && toRaw) {
    const f = parseUtcMidnightBoundary(fromRaw, false);
    const tExclusive = parseUtcMidnightBoundary(toRaw, true);
    if (!f || !tExclusive || tExclusive <= f) {
      return { error: "invalid_date_range" };
    }
    const maxMs = 400 * 86400000;
    if (tExclusive.getTime() - f.getTime() > maxMs) {
      return { error: "range_too_long" };
    }
    return { from: f, toExclusive: tExclusive };
  }

  return { from: defaultFrom, toExclusive: defaultToExclusive };
}

async function scopedAppointmentPredicates(db: ReturnType<typeof createDb>, policy: AccessPolicy) {
  const filters: SQL[] = [];

  if (policy.kind === "legacy") {
    const hiddenLocationIds = await getHiddenLocationIdsForPolicy(db, policy);
    if (hiddenLocationIds.length > 0) {
      filters.push(notInArray(appointments.locationId, hiddenLocationIds));
    }
  }

  appendJwtWorkspaceLocationConstraint(filters, await jwtWorkspaceAllowedLocationUuidList(db, policy), appointments.locationId);

  return filters;
}

async function scopedPaymentOrdersWhere(
  db: ReturnType<typeof createDb>,
  policy: AccessPolicy,
  timestampExpr: SQL,
  from: Date,
  toExclusive: Date
): Promise<SQL | undefined> {
  const preds: SQL[] = [
    eq(ghlPaymentOrders.isDeleted, false),
    orderCountsAsPaidInSql(),
    sql`${timestampExpr} >= ${from}`,
    sql`${timestampExpr} < ${toExclusive}`
  ];

  if (policy.kind === "legacy") {
    const hiddenLocationIds = await getHiddenLocationIdsForPolicy(db, policy);
    if (hiddenLocationIds.length > 0) {
      preds.push(notInArray(ghlPaymentOrders.locationId, hiddenLocationIds));
    }
  }

  const jwtAllowed = await jwtWorkspaceAllowedLocationUuidList(db, policy);
  if (jwtAllowed !== null) {
    preds.push(jwtAllowed.length === 0 ? sql`false` : inArray(ghlPaymentOrders.locationId, jwtAllowed));
  }

  return and(...preds);
}

async function scopedInvoicesWhere(
  db: ReturnType<typeof createDb>,
  policy: AccessPolicy,
  invoiceTs: SQL,
  from: Date,
  toExclusive: Date
): Promise<SQL | undefined> {
  const preds: SQL[] = [
    eq(invoices.isDeleted, false),
    invoicePaidSignalSql() as SQL,
    sql`${invoiceTs} >= ${from}`,
    sql`${invoiceTs} < ${toExclusive}`
  ];

  if (policy.kind === "legacy") {
    const hiddenLocationIds = await getHiddenLocationIdsForPolicy(db, policy);
    if (hiddenLocationIds.length > 0) {
      preds.push(notInArray(invoices.locationId, hiddenLocationIds));
    }
  }

  const jwtAllowed = await jwtWorkspaceAllowedLocationUuidList(db, policy);
  if (jwtAllowed !== null) {
    preds.push(jwtAllowed.length === 0 ? sql`false` : inArray(invoices.locationId, jwtAllowed));
  }

  return and(...preds);
}

/**
 * Appointments in the dashboard window by **when they were booked** in HighLevel/GHL ingestion:
 * `date_added`, else webhook `created_at` — **not** by scheduled visit (`start_time`).
 */
function appointmentsBookedDuringRange(from: Date, toExclusive: Date) {
  const cancelledBookingPredicate = appointmentCancelledOnlySql();
  const bookingCapturedAt = sql`coalesce(${appointments.dateAdded}, ${appointments.createdAt})`;
  return and(
    not(cancelledBookingPredicate),
    sql`${bookingCapturedAt} >= ${from}`,
    sql`${bookingCapturedAt} < ${toExclusive}`
  );
}

function pct(n: number, d: number): number | null {
  if (d <= 0) {
    return null;
  }
  return Math.round((n / d) * 10000) / 100;
}

type OverviewSubaccountRow = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  bookedAppointments: number;
  appointmentsWithCollectedPayment: number;
  depositsCollectedPercentage: number | null;
  depositsCollectedAmount: number;
  depositsCollectedFormatted: string;
};

function overviewSubaccountDisplayLabel(row: Pick<OverviewSubaccountRow, "locationName" | "ghlLocationId">) {
  const t = (row.locationName ?? "").trim();
  return t.length > 0 ? t : row.ghlLocationId;
}

function overviewPaidBookedRatio(booked: number, collected: number): number | null {
  if (booked <= 0) {
    return null;
  }
  return collected / booked;
}

type OverviewSortColumn = "subaccount" | "booked" | "paid" | "conversion" | "deposits";

function parseOverviewSortColumn(raw: string | undefined): OverviewSortColumn {
  const s = (raw ?? "").trim().toLowerCase();
  if (s === "subaccount" || s === "paid" || s === "conversion" || s === "deposits") {
    return s;
  }
  return "booked";
}

function parseOverviewSortOrder(raw: string | undefined): "asc" | "desc" {
  return (raw ?? "").trim().toLowerCase() === "asc" ? "asc" : "desc";
}

function filterOverviewSubaccountsByQuery(rows: OverviewSubaccountRow[], q: string): OverviewSubaccountRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return rows;
  }
  return rows.filter((row) => {
    const label = overviewSubaccountDisplayLabel(row).toLowerCase();
    return (
      label.includes(needle) ||
      row.ghlLocationId.toLowerCase().includes(needle) ||
      row.locationId.toLowerCase().includes(needle)
    );
  });
}

function meanConversionAcrossOverviewRows(rows: OverviewSubaccountRow[]): number | null {
  const ratios: number[] = [];
  for (const r of rows) {
    if (r.bookedAppointments > 0) {
      ratios.push(r.appointmentsWithCollectedPayment / r.bookedAppointments);
    }
  }
  if (ratios.length === 0) {
    return null;
  }
  const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
  return mean * 100;
}

function sortOverviewSubaccounts(
  rows: OverviewSubaccountRow[],
  column: OverviewSortColumn,
  order: "asc" | "desc"
): OverviewSubaccountRow[] {
  const dir = order === "asc" ? 1 : -1;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "subaccount": {
        cmp = overviewSubaccountDisplayLabel(a).localeCompare(
          overviewSubaccountDisplayLabel(b),
          undefined,
          { sensitivity: "base" }
        );
        break;
      }
      case "booked":
        cmp = a.bookedAppointments - b.bookedAppointments;
        break;
      case "paid":
        cmp = a.appointmentsWithCollectedPayment - b.appointmentsWithCollectedPayment;
        break;
      case "deposits":
        cmp = a.depositsCollectedAmount - b.depositsCollectedAmount;
        break;
      case "conversion": {
        const ra = overviewPaidBookedRatio(a.bookedAppointments, a.appointmentsWithCollectedPayment);
        const rb = overviewPaidBookedRatio(b.bookedAppointments, b.appointmentsWithCollectedPayment);
        if (ra === null && rb === null) {
          cmp = 0;
        } else if (ra === null) {
          cmp = 1;
        } else if (rb === null) {
          cmp = -1;
        } else {
          cmp = ra - rb;
        }
        break;
      }
      default:
        cmp = 0;
    }
    if (cmp !== 0) {
      return dir * cmp;
    }
    return a.locationId.localeCompare(b.locationId);
  });
  return sorted;
}

export async function getWorkspaceDashboardOverviewHandler(c: Context<{ Bindings: Env }>) {
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const bounds = resolveDashboardBounds(c.req.query("from"), c.req.query("to"));
  if ("error" in bounds) {
    return c.json({ error: bounds.error }, 400);
  }
  const { from, toExclusive } = bounds;
  const db = createDb(c.env.DATABASE_URL);

  const scope = await scopedAppointmentPredicates(db, policy);
  const bookedDuring = appointmentsBookedDuringRange(from, toExclusive);

  let appointmentWhere: SQL | undefined;
  if (!bookedDuring) {
    appointmentWhere = undefined;
  } else if (scope.length === 0) {
    appointmentWhere = bookedDuring;
  } else {
    appointmentWhere = and(bookedDuring, ...scope);
  }

  const effectivePaid = buildAppointmentEffectivePaidSql(db);

  const rollup =
    appointmentWhere ?
      await db
        .select({
          locationId: appointments.locationId,
          ghlLocationId: locations.ghlLocationId,
          locationName: locations.name,
          bookedAppointments: sql<number>`cast(count(*) as int)`.as("bookedAppointments"),
          appointmentsWithCollectedPayment: sql<number>`
            cast(sum(case when (${effectivePaid}) then 1 else 0 end) as int)
          `.as("appointmentsWithCollectedPayment")
        })
        .from(appointments)
        .innerJoin(locations, eq(appointments.locationId, locations.id))
        .where(and(appointmentWhere, eq(locations.excludeFromDashboard, false)))
        .groupBy(appointments.locationId, locations.ghlLocationId, locations.name)
    : [];

  /** Locations with deposits but zero booked appointments in window still appear via union (optional UX). Omit for MVP to keep simpler. */

  const orderTs = sql`coalesce(${ghlPaymentOrders.ghlUpdatedAt}, ${ghlPaymentOrders.ghlCreatedAt}, ${ghlPaymentOrders.updatedAt}, ${ghlPaymentOrders.createdAt})`;
  const orderWhereCombined = await scopedPaymentOrdersWhere(db, policy, orderTs, from, toExclusive);
  const invoiceTs = sql`coalesce(${invoices.ghlUpdatedAt}, ${invoices.issueDate}, ${invoices.dueDate}, ${invoices.updatedAt}, ${invoices.createdAt})`;
  const invoiceWhereCombined = await scopedInvoicesWhere(db, policy, invoiceTs, from, toExclusive);

  const ordersByLoc = orderWhereCombined
    ? await db
        .select({
          locationId: ghlPaymentOrders.locationId,
          depositSum: sql<number>`coalesce(sum(cast(${ghlPaymentOrders.amount} as bigint)), 0)::bigint`.as("depositSum")
        })
        .from(ghlPaymentOrders)
        .innerJoin(locations, eq(ghlPaymentOrders.locationId, locations.id))
        .where(and(orderWhereCombined, eq(locations.excludeFromDashboard, false)))
        .groupBy(ghlPaymentOrders.locationId)
    : [];

  const invByLoc = invoiceWhereCombined
    ? await db
        .select({
          locationId: invoices.locationId,
          depositSum: sql<number>`coalesce(sum(cast(${invoices.amountPaid} as bigint)), 0)::bigint`.as("depositSum")
        })
        .from(invoices)
        .innerJoin(locations, eq(invoices.locationId, locations.id))
        .where(and(invoiceWhereCombined, eq(locations.excludeFromDashboard, false)))
        .groupBy(invoices.locationId)
    : [];

  const amountByLocation = new Map<string, bigint>();
  for (const row of ordersByLoc) {
    amountByLocation.set(row.locationId, BigInt(Number(row.depositSum ?? 0)));
  }
  for (const row of invByLoc) {
    const cur = amountByLocation.get(row.locationId) ?? 0n;
    amountByLocation.set(row.locationId, cur + BigInt(Number(row.depositSum ?? 0)));
  }

  const allSubaccounts = rollup.map((row) => {
    const booked = Number(row.bookedAppointments ?? 0);
    const collectedCount = Number(row.appointmentsWithCollectedPayment ?? 0);
    const amount = amountByLocation.get(row.locationId) ?? 0n;
    const numAmount = Number(amount);
    return {
      locationId: row.locationId,
      ghlLocationId: row.ghlLocationId,
      locationName: row.locationName,
      bookedAppointments: booked,
      appointmentsWithCollectedPayment: collectedCount,
      depositsCollectedPercentage: pct(collectedCount, booked),
      depositsCollectedAmount: numAmount,
      depositsCollectedFormatted: formatDashboardDeposits(numAmount, null)
    };
  });

  let sumBooked = 0;
  let sumCollected = 0;
  for (const s of allSubaccounts) {
    sumBooked += s.bookedAppointments;
    sumCollected += s.appointmentsWithCollectedPayment;
  }

  /** Match portfolio KPI to the overview table: sum per-row DEPOSITS (locations with bookings in window only). */
  const totalsDepositAmount = allSubaccounts.reduce(
    (sum, row) => sum + (Number.isFinite(row.depositsCollectedAmount) ? row.depositsCollectedAmount : 0),
    0
  );

  const qRaw = c.req.query("q");
  const searchQuery = typeof qRaw === "string" ? qRaw : "";
  const filteredSubaccounts = filterOverviewSubaccountsByQuery(allSubaccounts, searchQuery);
  const sortColumn = parseOverviewSortColumn(c.req.query("sort"));
  const sortOrder = parseOverviewSortOrder(c.req.query("order"));
  const sortedForPaging = sortOverviewSubaccounts(filteredSubaccounts, sortColumn, sortOrder);

  const pageRaw = Number(c.req.query("page"));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;
  const limitRaw = Number(c.req.query("limit"));
  const pageSize = Math.min(50, Math.max(1, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50));
  const totalSubaccounts = sortedForPaging.length;
  const totalPages = Math.max(1, Math.ceil(totalSubaccounts / pageSize) || 1);
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * pageSize;
  const subaccounts = sortedForPaging.slice(offset, offset + pageSize);

  const meanConversionAcrossAccountsPct = meanConversionAcrossOverviewRows(filteredSubaccounts);

  return c.json({
    fromInclusive: from.toISOString(),
    toExclusive: toExclusive.toISOString(),
    totals: {
      bookedAppointments: sumBooked,
      appointmentsWithCollectedPayment: sumCollected,
      depositsCollectedPercentage: pct(sumCollected, sumBooked),
      depositsCollectedAmount: totalsDepositAmount,
      depositsCollectedFormatted: formatDashboardDeposits(totalsDepositAmount, null)
    },
    stats: {
      meanConversionAcrossAccountsPct
    },
    pagination: {
      page: safePage,
      pageSize,
      totalSubaccounts,
      totalPages,
      query: searchQuery.trim()
    },
    subaccounts
  });
}

function formatDashboardDeposits(amountMajor: number, currency: string | null) {
  if (!Number.isFinite(amountMajor)) {
    return "—";
  }
  const nf = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const num = nf.format(amountMajor);
  const cur = currency?.trim()?.toUpperCase();
  return cur ? `${num} ${cur}` : `$${num}`;
}

export async function getWorkspaceDashboardSubaccountSeriesHandler(c: Context<{ Bindings: Env }>) {
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const rawId = (c.req.param("locationId") ?? "").trim();
  if (!isUuid(rawId)) {
    return c.json({ error: "invalid_location_id" }, 400);
  }

  const dbProbe = createDb(c.env.DATABASE_URL);
  const ok = await canWorkspaceAccessLocationUuid(dbProbe, policy, rawId);
  if (!ok) {
    return c.json({ error: "forbidden_location" }, 403);
  }

  const [dashboardLoc] = await dbProbe
    .select({
      locationName: locations.name,
      ghlLocationId: locations.ghlLocationId,
      excludeFromDashboard: locations.excludeFromDashboard
    })
    .from(locations)
    .where(eq(locations.id, rawId))
    .limit(1);

  if (!dashboardLoc) {
    return c.json({ error: "forbidden_location" }, 403);
  }
  if (dashboardLoc.excludeFromDashboard) {
    return c.json({ error: "location_excluded_from_dashboard" }, 403);
  }

  const granularityRaw = (c.req.query("granularity") ?? "day").trim().toLowerCase();
  const truncation = granularityRaw === "week" ? "week" : "day";

  const bounds = resolveDashboardBounds(c.req.query("from"), c.req.query("to"));
  if ("error" in bounds) {
    return c.json({ error: bounds.error }, 400);
  }
  const { from, toExclusive } = bounds;
  const db = dbProbe;

  const bookedDuring = appointmentsBookedDuringRange(from, toExclusive);
  const appointmentWhereSingle =
    bookedDuring ? and(bookedDuring, eq(appointments.locationId, rawId)) : undefined;

  const effectivePaid = buildAppointmentEffectivePaidSql(db);

  /** Align chart buckets with overview: day/week of GHL booking capture (`date_added`, else webhook `created_at`). */
  const bookingCapturedAt = sql`coalesce(${appointments.dateAdded}, ${appointments.createdAt})`;
  const bucketExpr = sql`date_trunc(${sql.raw(`'${truncation}'`)}, (${bookingCapturedAt}) AT TIME ZONE 'UTC')`;

  const seriesRows = appointmentWhereSingle
    ? await db
        .select({
          bucket: bucketExpr.as("bucket"),
          bookedAppointments: sql<number>`cast(count(*) as int)`.as("bookedAppointments"),
          appointmentsWithCollectedPayment: sql<number>`
            cast(sum(case when (${effectivePaid}) then 1 else 0 end) as int)
          `.as("appointmentsWithCollectedPayment")
        })
        .from(appointments)
        .where(appointmentWhereSingle)
        .groupBy(bucketExpr)
        .orderBy(asc(bucketExpr))
    : [];

  const orderTs = sql`coalesce(${ghlPaymentOrders.ghlUpdatedAt}, ${ghlPaymentOrders.ghlCreatedAt}, ${ghlPaymentOrders.updatedAt}, ${ghlPaymentOrders.createdAt})`;
  const orderWhereBase = await scopedPaymentOrdersWhere(db, policy, orderTs, from, toExclusive);
  const orderWhere =
    orderWhereBase ? and(orderWhereBase, eq(ghlPaymentOrders.locationId, rawId)) : undefined;

  const invoiceTs = sql`coalesce(${invoices.ghlUpdatedAt}, ${invoices.issueDate}, ${invoices.dueDate}, ${invoices.updatedAt}, ${invoices.createdAt})`;
  const invWhereBase = await scopedInvoicesWhere(db, policy, invoiceTs, from, toExclusive);
  const invoiceWhere =
    invWhereBase ? and(invWhereBase, eq(invoices.locationId, rawId)) : undefined;

  const [orderTotals] = orderWhere
    ? await db
        .select({
          depositSum: sql<number>`coalesce(sum(cast(${ghlPaymentOrders.amount} as bigint)), 0)::bigint`.as("depositSum")
        })
        .from(ghlPaymentOrders)
        .where(orderWhere)
    : [];

  const [invTotals] = invoiceWhere
    ? await db
        .select({
          depositSum: sql<number>`coalesce(sum(cast(${invoices.amountPaid} as bigint)), 0)::bigint`.as("depositSum")
        })
        .from(invoices)
        .where(invoiceWhere)
    : [];

  const totalDepositsAmount =
    BigInt(Number(orderTotals?.depositSum ?? 0)) + BigInt(Number(invTotals?.depositSum ?? 0));

  const [sums] = appointmentWhereSingle
    ? await db
        .select({
          bookedAppointments: sql<number>`cast(count(*) as int)`,
          appointmentsWithCollectedPayment: sql<number>`cast(sum(case when (${effectivePaid}) then 1 else 0 end) as int)`
        })
        .from(appointments)
        .where(appointmentWhereSingle)
    : [];

  const booked = Number(sums?.bookedAppointments ?? 0);
  const collected = Number(sums?.appointmentsWithCollectedPayment ?? 0);

  const [currRow] =
    orderWhere ?
      await db
        .select({ currency: sql<string>`max(${ghlPaymentOrders.currency})`.as("currency") })
        .from(ghlPaymentOrders)
        .where(and(orderWhere, sql`${ghlPaymentOrders.currency} is not null`))
        .limit(1)
    : [];

  const series = seriesRows.map((row) => {
    const b = row.bucket;
    let bucketStart = "";
    if (b instanceof Date) {
      bucketStart = b.toISOString();
    } else if (typeof b === "string") {
      bucketStart = new Date(b).toISOString();
    }
    const bc = Number(row.bookedAppointments ?? 0);
    const cc = Number(row.appointmentsWithCollectedPayment ?? 0);
    return {
      bucketStart,
      bookedAppointments: bc,
      appointmentsWithCollectedPayment: cc,
      depositsCollectedPercentage: pct(cc, bc),
      granularity: truncation
    };
  });

  return c.json({
    fromInclusive: from.toISOString(),
    toExclusive: toExclusive.toISOString(),
    granularity: truncation,
    locationId: rawId,
    ghlLocationId: dashboardLoc.ghlLocationId ?? null,
    locationName: dashboardLoc.locationName ?? null,
    summary: {
      bookedAppointments: booked,
      appointmentsWithCollectedPayment: collected,
      depositsCollectedPercentage: pct(collected, booked),
      depositsCollectedAmount: Number(totalDepositsAmount),
      depositsCollectedFormatted: formatDashboardDeposits(Number(totalDepositsAmount), currRow?.currency ?? null)
    },
    series
  });
}

/**
 * Drill-down for a location: calendars booked-in-window breakdown and paid-order deposits grouped by webhook `source`.
 */
export async function getWorkspaceDashboardLocationDetailHandler(c: Context<{ Bindings: Env }>) {
  try {
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const rawId = (c.req.param("locationId") ?? "").trim();
  if (!isUuid(rawId)) {
    return c.json({ error: "invalid_location_id" }, 400);
  }

  const dbProbe = createDb(c.env.DATABASE_URL);
  const ok = await canWorkspaceAccessLocationUuid(dbProbe, policy, rawId);
  if (!ok) {
    return c.json({ error: "forbidden_location" }, 403);
  }

  const [dashboardLoc] = await dbProbe
    .select({
      excludeFromDashboard: locations.excludeFromDashboard,
      ghlLocationId: locations.ghlLocationId
    })
    .from(locations)
    .where(eq(locations.id, rawId))
    .limit(1);

  if (!dashboardLoc) {
    return c.json({ error: "forbidden_location" }, 403);
  }
  if (dashboardLoc.excludeFromDashboard) {
    return c.json({ error: "location_excluded_from_dashboard" }, 403);
  }

  const bounds = resolveDashboardBounds(c.req.query("from"), c.req.query("to"));
  if ("error" in bounds) {
    return c.json({ error: bounds.error }, 400);
  }
  const { from, toExclusive } = bounds;
  const db = dbProbe;

  const scope = await scopedAppointmentPredicates(db, policy);
  const bookedDuring = appointmentsBookedDuringRange(from, toExclusive);

  let appointmentWhere: SQL | undefined;
  if (!bookedDuring) {
    appointmentWhere = undefined;
  } else if (scope.length === 0) {
    appointmentWhere = and(bookedDuring, eq(appointments.locationId, rawId));
  } else {
    appointmentWhere = and(bookedDuring, eq(appointments.locationId, rawId), ...scope);
  }

  const appointmentCalendarBucketExpr = sql`coalesce(${appointments.calendarId}, '')`;

  const calendarRowsRaw =
    appointmentWhere ?
      await db
        .select({
          bookedCount: sql<number>`cast(count(*) as int)`.as("bookedCount"),
          displayLabel: sql<string>`coalesce(
            nullif(trim(max(${locationCalendars.name})), ''),
            case
              when max(trim(both from coalesce(${appointments.calendarId}, ''))) = '' then 'No calendar'
              else concat('Calendar · ', max(trim(both from coalesce(${appointments.calendarId}, ''))))
            end
          )`.as("displayLabel"),
          sampleGhlCalendarId: sql<string | null>`max(${appointments.calendarId})`.as("sampleGhlCalendarId")
        })
        .from(appointments)
        .leftJoin(
          locationCalendars,
          and(
            eq(locationCalendars.locationId, appointments.locationId),
            sql`lower(trim(both from coalesce(${appointments.calendarId}, ''))) = lower(trim(both from coalesce(${locationCalendars.ghlCalendarId}, '')))`
          )
        )
        .where(appointmentWhere)
        .groupBy(appointmentCalendarBucketExpr)
    : [];

  const calendars = [...calendarRowsRaw]
    .sort((a, b) => Number(b.bookedCount) - Number(a.bookedCount))
    .map((row) => {
      const cid = row.sampleGhlCalendarId;
      const ghlCalendarId =
        cid !== null && typeof cid === "string" && cid.trim() !== "" ? cid.trim() : null;
      return {
        ghlCalendarId,
        name: row.displayLabel ?? "",
        bookedCount: Number(row.bookedCount ?? 0)
      };
    });

  let calendarsHydrated = calendars;
  calendarsHydrated = await reconcileCalendarBucketsWithStoredLocationCalendarNames(db, rawId, calendarsHydrated);

  const orderTs = sql`coalesce(${ghlPaymentOrders.ghlUpdatedAt}, ${ghlPaymentOrders.ghlCreatedAt}, ${ghlPaymentOrders.updatedAt}, ${ghlPaymentOrders.createdAt})`;
  const orderWhereBase = await scopedPaymentOrdersWhere(db, policy, orderTs, from, toExclusive);
  const orderWhere = orderWhereBase ? and(orderWhereBase, eq(ghlPaymentOrders.locationId, rawId)) : undefined;

  const orderPaymentRowsRaw =
    orderWhere ?
      await db
        .select({
          paymentSourceId: ghlPaymentOrders.paymentSourceId,
          displayName: sql<string>`
            coalesce(
              nullif(trim(max(${paymentSources.displayName})), ''),
              nullif(trim(max(${ghlPaymentOrders.raw}->'source'->>'name')), ''),
              'Unknown source'
            )
          `.as("displayName"),
          paidOrderCount: sql<number>`cast(count(*) as int)`.as("paidOrderCount"),
          amountSum: sql<number>`coalesce(sum(cast(${ghlPaymentOrders.amount} as bigint)), 0)::bigint`.as("amountSum"),
          sampleCurrency: sql<string | null>`max(${ghlPaymentOrders.currency})`.as("sampleCurrency")
        })
        .from(ghlPaymentOrders)
        .leftJoin(paymentSources, eq(ghlPaymentOrders.paymentSourceId, paymentSources.id))
        .where(orderWhere)
        .groupBy(ghlPaymentOrders.paymentSourceId)
    : [];

  const orderPaymentsBySource = [...orderPaymentRowsRaw]
    .sort((a, b) => Number(b.amountSum) - Number(a.amountSum))
    .map((row) => {
      const amt = Number(row.amountSum ?? 0);
      return {
        paymentSourceId: row.paymentSourceId,
        displayName: row.displayName,
        paidOrderCount: Number(row.paidOrderCount ?? 0),
        depositsCollectedAmount: amt,
        depositsCollectedFormatted: formatDashboardDeposits(amt, row.sampleCurrency ?? null)
      };
    });

  const invoiceTs = sql`coalesce(${invoices.ghlUpdatedAt}, ${invoices.issueDate}, ${invoices.dueDate}, ${invoices.updatedAt}, ${invoices.createdAt})`;
  const invWhereBase = await scopedInvoicesWhere(db, policy, invoiceTs, from, toExclusive);
  const invoiceWhere = invWhereBase ? and(invWhereBase, eq(invoices.locationId, rawId)) : undefined;

  const [invoiceAgg] =
    invoiceWhere ?
      await db
        .select({
          depositSum: sql<number>`coalesce(sum(cast(${invoices.amountPaid} as bigint)), 0)::bigint`.as("depositSum"),
          sampleCurrency: sql<string | null>`max(${invoices.currency})`.as("sampleCurrency")
        })
        .from(invoices)
        .where(invoiceWhere)
    : [];

  const invoiceDepositNum = invoiceAgg ? Number(invoiceAgg.depositSum ?? 0) : 0;

  return c.json({
    fromInclusive: from.toISOString(),
    toExclusive: toExclusive.toISOString(),
    locationId: rawId,
    calendars: calendarsHydrated,
    orderPaymentsBySource,
    invoiceDepositsCollectedAmount: invoiceDepositNum,
    invoiceDepositsCollectedFormatted: formatDashboardDeposits(
      invoiceDepositNum,
      invoiceAgg?.sampleCurrency ?? null
    )
  });
  } catch (error) {
    console.error("[dashboard.location_detail]", { locationId: c.req.param("locationId"), error });
    return c.json(
      {
        error: "detail_failed",
        message: formatDashboardHandlerError(error)
      },
      500
    );
  }
}

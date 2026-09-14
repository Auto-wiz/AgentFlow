/**
 * Location display-name cron helpers.
 *
 * Cloudflare Workers cannot GHL-fetch every subaccount in one invocation (subrequest budget),
 * so “daily refresh of all names” is: a dedicated daily trigger plus small batches on the
 * existing 15-minute cron, with a ~1 day stale window.
 *
 * Do not pin LOCATION_NAMES_REFRESH_BATCH / LOCATION_NAMES_DAILY_CRON_BATCH in wrangler.toml
 * `[vars]` — those overwrite Dashboard values on every deploy. `"0"` disables the matching path.
 */

export const LOCATION_NAMES_CRON_LOOKUP_CAP = 15;
export const LOCATION_NAMES_REFRESH_BATCH_DEFAULT = 8;
export const LOCATION_NAMES_DAILY_CRON_BATCH_DEFAULT = 15;
export const LOCATION_NAMES_STALE_AFTER_DAYS_DEFAULT = 1;
export const LOCATION_NAMES_DAILY_CRON_DEFAULT = "0 8 * * *";

export type LocationNameRefreshSchedule =
  | { run: false; kind: "disabled" | "hour_gated" }
  | { run: true; kind: "daily" | "interval"; batch: number };

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  max: number
): number {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed === "0") {
    return 0;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n < 0) {
    return fallback;
  }
  return Math.min(max, n);
}

/** Unset defaults to 8; `"0"` disables the 15-minute stale-name refresh. */
export function parseLocationNamesRefreshBatch(raw: string | undefined): number {
  return parseBoundedInt(raw, LOCATION_NAMES_REFRESH_BATCH_DEFAULT, LOCATION_NAMES_CRON_LOOKUP_CAP);
}

/** Unset defaults to 15; `"0"` disables the dedicated daily name refresh. */
export function parseLocationNamesDailyCronBatch(raw: string | undefined): number {
  return parseBoundedInt(raw, LOCATION_NAMES_DAILY_CRON_BATCH_DEFAULT, LOCATION_NAMES_CRON_LOOKUP_CAP);
}

/** Unset defaults to 1 day so a rolling pass covers every subaccount about once per day. */
export function parseLocationNamesStaleAfterDays(raw: string | undefined): number {
  const n = Number.parseFloat(String(raw ?? LOCATION_NAMES_STALE_AFTER_DAYS_DEFAULT).trim());
  if (!Number.isFinite(n) || n < 1) {
    return LOCATION_NAMES_STALE_AFTER_DAYS_DEFAULT;
  }
  return Math.min(365, n);
}

/**
 * True for a once-per-day crontab (numeric minute + hour, `*` for day/month/dow).
 * `*\/15 * * * *` stays on the interval path.
 */
export function isDailyLocationNameCron(cron: string | undefined): boolean {
  const value = cron?.trim();
  if (!value) {
    return false;
  }
  if (value === LOCATION_NAMES_DAILY_CRON_DEFAULT) {
    return true;
  }
  const parts = value.split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  const minute = parts[0];
  const hour = parts[1];
  const dayOfMonth = parts[2];
  const month = parts[3];
  const dayOfWeek = parts[4];
  return (
    Boolean(minute && /^\d+$/.test(minute)) &&
    Boolean(hour && /^\d+$/.test(hour)) &&
    dayOfMonth === "*" &&
    month === "*" &&
    dayOfWeek === "*"
  );
}

/** When unset or invalid hour, interval refreshes run on every eligible cron tick. */
export function passesLocationRefreshHourUtcGate(
  hourUtcRaw: string | undefined,
  scheduledTimeMs: number
): boolean {
  const trimmed = hourUtcRaw?.trim();
  if (!trimmed) {
    return true;
  }
  const hour = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    return true;
  }
  return new Date(scheduledTimeMs).getUTCHours() === hour;
}

export function resolveLocationNameRefreshSchedule(input: {
  cron?: string;
  scheduledTimeMs: number;
  refreshBatchRaw?: string;
  dailyBatchRaw?: string;
  hourUtcRaw?: string;
}): LocationNameRefreshSchedule {
  if (isDailyLocationNameCron(input.cron)) {
    const batch = parseLocationNamesDailyCronBatch(input.dailyBatchRaw);
    if (batch <= 0) {
      return { run: false, kind: "disabled" };
    }
    return { run: true, kind: "daily", batch };
  }

  const batch = parseLocationNamesRefreshBatch(input.refreshBatchRaw);
  if (batch <= 0) {
    return { run: false, kind: "disabled" };
  }
  if (!passesLocationRefreshHourUtcGate(input.hourUtcRaw, input.scheduledTimeMs)) {
    return { run: false, kind: "hour_gated" };
  }
  return { run: true, kind: "interval", batch };
}

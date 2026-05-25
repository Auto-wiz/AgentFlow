"use client";

/** Inclusive `[from,to]` calendar days in UTC, matching API `resolveDashboardBounds` YYYY-MM-DD parsing. */

export type DateRangeStrings = {
  /** Inclusive lower bound UTC calendar day */
  fromInclusive: string;
  /** Inclusive upper bound UTC calendar day */
  toInclusive: string;
};

export function formatIsoDayUtc(ms: number) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** End-exclusive returned as next calendar day UTC (API `toExclusive` is start of following day). */
export function utcInclusiveRange(days: number): DateRangeStrings {
  const now = new Date();
  const endInclusiveMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const toExclusiveMs = endInclusiveMs + 86400000;
  const fromInclusiveMs = endInclusiveMs - (days - 1) * 86400000;
  return {
    fromInclusive: formatIsoDayUtc(fromInclusiveMs),
    toInclusive: formatIsoDayUtc(endInclusiveMs)
  };
}

type PresetKey = "7" | "30" | "90" | "custom";

export type DashboardRangeControlProps = {
  value: DateRangeStrings;
  preset: PresetKey;
  customDraft: Pick<DateRangeStrings, "fromInclusive" | "toInclusive">;
  onPresetChange: (preset: PresetKey) => void;
  onCustomDraft: (draft: DateRangeStrings) => void;
  onApplyCustom: () => void;
};

export function DashboardRangeControl({
  value,
  preset,
  customDraft,
  onPresetChange,
  onCustomDraft,
  onApplyCustom
}: DashboardRangeControlProps) {
  return (
    <div className="dashboard-range-bar">
      <span className="dashboard-range-label muted">Period (UTC)</span>
      <select
        className="dashboard-range-select appointments-filter-select"
        onChange={(e) => {
          onPresetChange(e.target.value as PresetKey);
        }}
        value={preset}
      >
        <option value="7">Last 7 days</option>
        <option value="30">Last 30 days</option>
        <option value="90">Last 90 days</option>
        <option value="custom">Custom range</option>
      </select>
      {preset === "custom" ? (
        <span className="dashboard-custom-range">
          <input
            className="dashboard-date-input appointments-filter-select"
            onChange={(e) => onCustomDraft({ ...customDraft, fromInclusive: e.target.value })}
            type="date"
            value={customDraft.fromInclusive.slice(0, 10)}
          />
          <span className="muted">–</span>
          <input
            className="dashboard-date-input appointments-filter-select"
            onChange={(e) => onCustomDraft({ ...customDraft, toInclusive: e.target.value })}
            type="date"
            value={customDraft.toInclusive.slice(0, 10)}
          />
          <button className="button secondary" onClick={() => onApplyCustom()} type="button">
            Apply
          </button>
        </span>
      ) : (
        <span className="muted dashboard-range-reading">
          {value.fromInclusive} → {value.toInclusive}
        </span>
      )}
    </div>
  );
}

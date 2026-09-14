import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  LOCATION_NAMES_DAILY_CRON_DEFAULT,
  isDailyLocationNameCron,
  parseLocationNamesDailyCronBatch,
  parseLocationNamesRefreshBatch,
  parseLocationNamesStaleAfterDays,
  passesLocationRefreshHourUtcGate,
  resolveLocationNameRefreshSchedule
} from "./location-names-cron.ts";

describe("location name cron parsers", () => {
  it("enables interval refresh by default and disables on 0", () => {
    assert.equal(parseLocationNamesRefreshBatch(undefined), 8);
    assert.equal(parseLocationNamesRefreshBatch(""), 8);
    assert.equal(parseLocationNamesRefreshBatch("0"), 0);
    assert.equal(parseLocationNamesRefreshBatch("4"), 4);
    assert.equal(parseLocationNamesRefreshBatch("99"), 15);
    assert.equal(parseLocationNamesRefreshBatch("nope"), 8);
  });

  it("enables the daily burst by default and disables on 0", () => {
    assert.equal(parseLocationNamesDailyCronBatch(undefined), 15);
    assert.equal(parseLocationNamesDailyCronBatch("0"), 0);
    assert.equal(parseLocationNamesDailyCronBatch("9"), 9);
    assert.equal(parseLocationNamesDailyCronBatch("40"), 15);
  });

  it("defaults stale window to one day", () => {
    assert.equal(parseLocationNamesStaleAfterDays(undefined), 1);
    assert.equal(parseLocationNamesStaleAfterDays("2"), 2);
    assert.equal(parseLocationNamesStaleAfterDays("0"), 1);
    assert.equal(parseLocationNamesStaleAfterDays("400"), 365);
  });
});

describe("isDailyLocationNameCron", () => {
  it("treats the wrangler daily expression as daily", () => {
    assert.equal(isDailyLocationNameCron(LOCATION_NAMES_DAILY_CRON_DEFAULT), true);
    assert.equal(isDailyLocationNameCron("0 7 * * *"), true);
    assert.equal(isDailyLocationNameCron(" 00 08 * * * "), true);
  });

  it("keeps interval and weekly expressions off the daily path", () => {
    assert.equal(isDailyLocationNameCron("*/15 * * * *"), false);
    assert.equal(isDailyLocationNameCron("0 */6 * * *"), false);
    assert.equal(isDailyLocationNameCron("0 8 * * 1"), false);
    assert.equal(isDailyLocationNameCron(undefined), false);
  });
});

describe("resolveLocationNameRefreshSchedule", () => {
  const eightUtc = Date.UTC(2026, 8, 14, 8, 0, 0);
  const nineUtc = Date.UTC(2026, 8, 14, 9, 0, 0);

  it("runs a daily burst even when the hour gate would block interval ticks", () => {
    assert.deepEqual(
      resolveLocationNameRefreshSchedule({
        cron: LOCATION_NAMES_DAILY_CRON_DEFAULT,
        scheduledTimeMs: nineUtc,
        hourUtcRaw: "8",
        dailyBatchRaw: undefined,
        refreshBatchRaw: "0"
      }),
      { run: true, kind: "daily", batch: 15 }
    );
  });

  it("skips daily when the daily batch is 0", () => {
    assert.deepEqual(
      resolveLocationNameRefreshSchedule({
        cron: LOCATION_NAMES_DAILY_CRON_DEFAULT,
        scheduledTimeMs: eightUtc,
        dailyBatchRaw: "0"
      }),
      { run: false, kind: "disabled" }
    );
  });

  it("runs interval batches by default and honors the hour gate", () => {
    assert.deepEqual(
      resolveLocationNameRefreshSchedule({
        cron: "*/15 * * * *",
        scheduledTimeMs: eightUtc
      }),
      { run: true, kind: "interval", batch: 8 }
    );
    assert.deepEqual(
      resolveLocationNameRefreshSchedule({
        cron: "*/15 * * * *",
        scheduledTimeMs: nineUtc,
        hourUtcRaw: "8"
      }),
      { run: false, kind: "hour_gated" }
    );
  });

  it("disables interval refresh when LOCATION_NAMES_REFRESH_BATCH is 0", () => {
    assert.deepEqual(
      resolveLocationNameRefreshSchedule({
        cron: "*/15 * * * *",
        scheduledTimeMs: eightUtc,
        refreshBatchRaw: "0"
      }),
      { run: false, kind: "disabled" }
    );
  });
});

describe("passesLocationRefreshHourUtcGate", () => {
  it("passes when unset and matches the configured UTC hour", () => {
    const eightUtc = Date.UTC(2026, 8, 14, 8, 12, 0);
    assert.equal(passesLocationRefreshHourUtcGate(undefined, eightUtc), true);
    assert.equal(passesLocationRefreshHourUtcGate("8", eightUtc), true);
    assert.equal(passesLocationRefreshHourUtcGate("9", eightUtc), false);
  });
});

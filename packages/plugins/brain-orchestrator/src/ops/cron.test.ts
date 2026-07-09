import { describe, expect, it } from "vitest";
import { computeNextRun, parseCron } from "./cron.js";

describe("parseCron", () => {
  it("parses '* * * * *' to full ranges", () => {
    const cron = parseCron("* * * * *");
    expect(cron.minute.size).toBe(60);
    expect(cron.hour.size).toBe(24);
    expect(cron.dayOfMonth.size).toBe(31);
    expect(cron.month.size).toBe(12);
    expect(cron.dayOfWeek.size).toBe(7);
  });

  it("parses a single number per field", () => {
    const cron = parseCron("5 14 1 6 3");
    expect([...cron.minute]).toEqual([5]);
    expect([...cron.hour]).toEqual([14]);
    expect([...cron.dayOfMonth]).toEqual([1]);
    expect([...cron.month]).toEqual([6]);
    expect([...cron.dayOfWeek]).toEqual([3]);
  });

  it("parses ranges (1-5)", () => {
    const cron = parseCron("1-5 * * * *");
    expect([...cron.minute].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  it("parses comma lists (1,3,5)", () => {
    const cron = parseCron("1,3,5 * * * *");
    expect([...cron.minute].sort((a, b) => a - b)).toEqual([1, 3, 5]);
  });

  it("parses steps with wildcard (*/15)", () => {
    const cron = parseCron("*/15 * * * *");
    expect([...cron.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
  });

  it("parses steps with range (10-20/5)", () => {
    const cron = parseCron("10-20/5 * * * *");
    expect([...cron.minute].sort((a, b) => a - b)).toEqual([10, 15, 20]);
  });

  it("rejects expressions with the wrong number of fields", () => {
    expect(() => parseCron("* * * *")).toThrow(/expected 5 fields/);
    expect(() => parseCron("* * * * * *")).toThrow(/expected 5 fields/);
  });

  it("rejects zero step values", () => {
    expect(() => parseCron("*/0 * * * *")).toThrow(/Invalid cron step/);
    expect(() => parseCron("1-5/0 * * * *")).toThrow(/Invalid cron step/);
  });

  it("rejects invalid field values and ranges", () => {
    expect(() => parseCron("x * * * *")).toThrow(/Invalid cron value/);
    expect(() => parseCron("60 * * * *")).toThrow(/Invalid cron range/);
    expect(() => parseCron("5-1 * * * *")).toThrow(/Invalid cron range/);
    expect(() => parseCron("1,,3 * * * *")).toThrow(
      /Invalid cron field part/,
    );
  });

  it("rejects malformed range expressions (non-numeric or too many pieces)", () => {
    expect(() => parseCron("1-x * * * *")).toThrow(/Invalid cron range/);
    expect(() => parseCron("x-5 * * * *")).toThrow(/Invalid cron range/);
    expect(() => parseCron("1-2-3 * * * *")).toThrow(/Invalid cron range/);
  });

  it("ignores extra whitespace when splitting", () => {
    const cron = parseCron("  *   *   *   *   *  ");
    expect(cron.minute.size).toBe(60);
  });
});

describe("computeNextRun", () => {
  it("finds the next minute boundary for '* * * * *' in UTC", () => {
    // 2026-05-17T12:30:42Z → next minute 12:31:00
    const after = Date.parse("2026-05-17T12:30:42Z");
    const next = computeNextRun("* * * * *", "UTC", after);
    expect(new Date(next).toISOString()).toBe("2026-05-17T12:31:00.000Z");
  });

  it("finds the next 'every 15 minutes' boundary", () => {
    const after = Date.parse("2026-05-17T12:14:00Z");
    const next = computeNextRun("*/15 * * * *", "UTC", after);
    expect(new Date(next).toISOString()).toBe("2026-05-17T12:15:00.000Z");
  });

  it("jumps to the next hour when the hour doesn't match", () => {
    // Run at 03:00 every day. After 12:30, next match is tomorrow 03:00.
    const after = Date.parse("2026-05-17T12:30:00Z");
    const next = computeNextRun("0 3 * * *", "UTC", after);
    expect(new Date(next).toISOString()).toBe("2026-05-18T03:00:00.000Z");
  });

  it("jumps to the next day when day-of-month doesn't match", () => {
    // Run at 00:00 on day 1 of each month. After 2026-05-17 → next is 2026-06-01.
    const after = Date.parse("2026-05-17T12:30:00Z");
    const next = computeNextRun("0 0 1 * *", "UTC", after);
    expect(new Date(next).toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("respects the timezone parameter (Eastern vs UTC)", () => {
    // "0 2 * * *" in America/New_York means 02:00 NY = 06:00 UTC (during DST).
    // 2026-05-17 is in EDT (UTC-4) → 06:00 UTC.
    const after = Date.parse("2026-05-17T00:00:00Z");
    const next = computeNextRun("0 2 * * *", "America/New_York", after);
    expect(new Date(next).toISOString()).toBe("2026-05-17T06:00:00.000Z");
  });

  it("does not skip local midnight across the spring-forward DST boundary", () => {
    // US DST 2026 starts Sun Mar 8. "0 0 9 3 *" = midnight Mar 9 (EDT, UTC-4)
    // = 2026-03-09T04:00:00Z. The old fixed-24h startOfNextDay overshot the
    // 23h Mar 8 day to 01:00, skipping the 00:00 match entirely.
    const after = Date.parse("2026-03-07T17:00:00Z");
    const next = computeNextRun("0 0 9 3 *", "America/New_York", after);
    expect(new Date(next).toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("advances past local midnight across the fall-back DST boundary", () => {
    // US DST 2026 ends Sun Nov 1. "0 0 2 11 *" = midnight Nov 2 (EST, UTC-5)
    // = 2026-11-02T05:00:00Z. The old startOfNextDay under-shot the 25h Nov 1
    // day and failed to leave it.
    const after = Date.parse("2026-11-01T12:00:00Z");
    const next = computeNextRun("0 0 2 11 *", "America/New_York", after);
    expect(new Date(next).toISOString()).toBe("2026-11-02T05:00:00.000Z");
  });

  it("throws when no match is found within 366 days (impossible date)", () => {
    // Feb 30 doesn't exist. Search exhausts within ~366 days.
    expect(() =>
      computeNextRun("0 0 30 2 *", "UTC", Date.parse("2026-05-17T00:00:00Z")),
    ).toThrow(/No matching cron time/);
  });

  it("matches day-of-week filter (every Monday at 09:00 UTC)", () => {
    // 2026-05-17 is a Sunday. Next Monday 09:00 UTC = 2026-05-18T09:00.
    const after = Date.parse("2026-05-17T08:00:00Z");
    const next = computeNextRun("0 9 * * 1", "UTC", after);
    expect(new Date(next).toISOString()).toBe("2026-05-18T09:00:00.000Z");
  });

  it("advances by one minute when the minute is the only mismatched field", () => {
    // Schedule: 12:30 every day. Start at 12:00:30Z — same matching hour
    // but minutes 0-29 don't match; loop must advance minute-by-minute.
    const after = Date.parse("2026-05-17T12:00:30Z");
    const next = computeNextRun("30 12 * * *", "UTC", after);
    expect(new Date(next).toISOString()).toBe("2026-05-17T12:30:00.000Z");
  });
});

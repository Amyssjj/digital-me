/**
 * Lightweight 5-field cron parser — port of upstream task-orchestrator
 * `src/cron.ts`. No dependencies.
 *
 * Supports: minute, hour, day-of-month, month, day-of-week.
 * Features per field: numbers, ranges (1-5), steps (`*\/15`), lists (1,3,5),
 * wildcards (*).
 *
 * Timezone is honored via Intl.DateTimeFormat — `computeNextRun` returns
 * an epoch-ms value of the next matching minute boundary in the given zone.
 */

type CronField = ReadonlySet<number>;

export type ParsedCron = {
  readonly minute: CronField;
  readonly hour: CronField;
  readonly dayOfMonth: CronField;
  /** 1-12. */
  readonly month: CronField;
  /** 0-6, where 0 = Sunday. */
  readonly dayOfWeek: CronField;
};

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "") {
      throw new Error(`Invalid cron field part: ${field}`);
    }
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? Number.parseInt(stepMatch[2]!, 10) : 1;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(`Invalid cron step: ${part}`);
    }
    const range = stepMatch ? stepMatch[1]! : part;

    let start: number;
    let end: number;
    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const pieces = range.split("-");
      if (
        pieces.length !== 2 ||
        !/^\d+$/.test(pieces[0]!) ||
        !/^\d+$/.test(pieces[1]!)
      ) {
        throw new Error(`Invalid cron range: ${part}`);
      }
      start = Number.parseInt(pieces[0]!, 10);
      end = Number.parseInt(pieces[1]!, 10);
    } else {
      if (!/^\d+$/.test(range)) {
        throw new Error(`Invalid cron value: ${part}`);
      }
      start = Number.parseInt(range, 10);
      end = start;
    }
    if (
      start < min ||
      start > max ||
      end < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`Invalid cron range: ${part}`);
    }
    for (let i = start; i <= end; i += step) {
      result.add(i);
    }
  }
  return result;
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `Invalid cron expression: expected 5 fields, got ${parts.length}`,
    );
  }
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dayOfMonth: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dayOfWeek: parseField(parts[4]!, 0, 6),
  };
}

type DateParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly dow: number;
};

function extractParts(
  formatter: Intl.DateTimeFormat,
  ms: number,
): DateParts {
  const resolved = formatter.formatToParts(new Date(ms));
  // The formatter is constructed with explicit year/month/day/hour/minute, so
  // these types are always present — we narrow with a non-null assertion.
  const get = (type: string): number =>
    Number.parseInt(resolved.find((p) => p.type === type)!.value, 10);
  // Day-of-week from a tz-aware re-parse of the formatted string.
  const tzDate = new Date(
    formatter
      .format(new Date(ms))
      .replace(
        /(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}):(\d{2})/,
        "$3-$1-$2T$4:$5:00",
      ),
  );
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    dow: tzDate.getDay(),
  };
}

/** Offset (ms) of `timezone` at instant `ms`: the local wall-clock read as if
 * it were UTC, minus `ms`. e.g. America/New_York in winter → -5h. */
function tzOffsetMs(ms: number, timezone: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t: string) =>
    Number.parseInt(p.find((x) => x.type === t)!.value, 10);
  const hour = g("hour") % 24; // some engines emit "24" for midnight
  const asUTC = Date.UTC(g("year"), g("month") - 1, g("day"), hour, g("minute"), g("second"));
  return asUTC - ms;
}

/** Epoch ms of the next local 00:00 strictly after `ms`, DST-safe.
 *
 * The old implementation added a fixed `(24h - elapsed)` which over/under-shoots
 * on DST boundary days (a 23h spring-forward day skipped midnight entirely; a
 * 25h fall-back day failed to leave the day). Here we take the local calendar
 * day, increment it (UTC date math handles month/year rollover), then resolve
 * the epoch for that next local midnight with one DST-correction pass. */
function startOfNextDay(ms: number, timezone: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const g = (t: string) =>
    Number.parseInt(p.find((x) => x.type === t)!.value, 10);
  const next = new Date(Date.UTC(g("year"), g("month") - 1, g("day") + 1));
  const guess = Date.UTC(
    next.getUTCFullYear(),
    next.getUTCMonth(),
    next.getUTCDate(),
    0,
    0,
    0,
  );
  // First approximation uses the offset at the naive instant; correct once
  // using the offset at the resulting real instant (differs across a DST jump).
  const epoch = guess - tzOffsetMs(guess, timezone);
  return guess - tzOffsetMs(epoch, timezone);
}

/**
 * Compute the next occurrence after `afterMs`. Searches up to 366 days
 * forward; throws when no match is found in that window (e.g., an
 * unreachable `Feb 30` expression).
 */
export function computeNextRun(
  cronExpr: string,
  timezone: string,
  afterMs: number,
): number {
  const cron = parseCron(cronExpr);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  let cursor = afterMs + 60_000 - (afterMs % 60_000);
  const limit = afterMs + 366 * 24 * 60 * 60_000;

  while (cursor < limit) {
    const parts = extractParts(formatter, cursor);
    if (
      cron.month.has(parts.month) &&
      cron.dayOfMonth.has(parts.day) &&
      cron.dayOfWeek.has(parts.dow) &&
      cron.hour.has(parts.hour) &&
      cron.minute.has(parts.minute)
    ) {
      return cursor;
    }
    if (
      !cron.month.has(parts.month) ||
      !cron.dayOfMonth.has(parts.day) ||
      !cron.dayOfWeek.has(parts.dow)
    ) {
      cursor = startOfNextDay(cursor, timezone);
    } else if (!cron.hour.has(parts.hour)) {
      cursor += (60 - parts.minute) * 60_000;
    } else {
      cursor += 60_000;
    }
  }
  throw new Error(
    `No matching cron time found within 366 days for: ${cronExpr}`,
  );
}

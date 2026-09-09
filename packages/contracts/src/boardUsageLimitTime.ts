/**
 * T3o resume-time reading (T3O-22, D5) — when does the provider say we may try
 * again?
 *
 * Providers state it in whatever shape suits their prose, so this reads all of
 * them over the same text and takes the first hit:
 *
 * | Form                  | Example                                   |
 * | --------------------- | ----------------------------------------- |
 * | relative, compact     | `resets in 3d 2h`                         |
 * | relative, spelled out | `Try again in 4 days 2 hours 46 minutes`  |
 * | relative, seconds     | `Please retry in 12s`                     |
 * | absolute              | `try again at Jul 20th, 2026 9:48PM`      |
 * | bare clock + zone     | `resets 2:50am (Pacific/Auckland)`        |
 * | bare clock            | `try again a 4:03AM` (the provider's typo)|
 *
 * Time tokens are scanned for DIRECTLY rather than behind a `resets` / `try
 * again at` lead-in. That is what makes the last row parse: the message really
 * did say "try again a 4:03AM", and a parser keyed on the lead-in would have
 * read nothing and slept the card for half an hour instead of four minutes.
 *
 * Pure and total: `nowMs` and `timeZone` arrive as scalars, so there is no clock
 * here and a test pins both. `Intl` does the zone arithmetic — the one thing
 * that cannot be done with `Date` alone, since a wall-clock time in a named zone
 * is not a fixed offset from UTC.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Month names as providers write them, long and abbreviated. */
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/** `in 3d 2h 15m` / `in 90s` — one or more compact duration atoms after "in".
    Anchored on "in" so a version string or a bare `2h` in prose is not a time. */
const COMPACT_DURATION = /\bin\s+((?:\d+\s*[dhms]\b\s*)+)/i;
const COMPACT_ATOM = /(\d+)\s*([dhms])\b/gi;

/** `in 4 days 2 hours 46 minutes` — the spelled-out twin of the above. */
const SPELLED_DURATION =
  /\bin\s+((?:\d+\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)[\s,and]*)+)/i;
const SPELLED_ATOM = /(\d+)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/gi;

/** `Jul 20th, 2026 9:48PM` / `20 July 2026 21:48` — a month name, a day, a year
    and a clock time, in either order, with optional ordinal suffix and comma. */
const ABSOLUTE_DATE =
  /\b(?:([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?|(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})\.?)[,\s]+(\d{4})(?:[,\s]+|\s+at\s+)(\d{1,2}):(\d{2})\s*(am|pm)?/i;

/** `2:50am`, `4:03 PM`, `21:48` — a bare clock with no date around it. */
const BARE_CLOCK = /\b(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?\b/i;

/** An IANA zone in parentheses, as Claude Code writes it: `(Pacific/Auckland)`. */
const ZONE_IN_PARENS = /\(\s*([A-Za-z]+(?:[_-][A-Za-z]+)*\/[A-Za-z]+(?:[_-][A-Za-z]+)*)\s*\)/;
/** …or a bare `UTC` / `GMT`, which providers do use and which `Intl` accepts. */
const UTC_ZONE = /\b(UTC|GMT)\b/;

/** Whether `Intl` will accept this as a time zone. A provider is free to write
    anything inside those parentheses, and an unknown zone must fall back to the
    server's rather than throw out of a pure function. */
function zoneIsUsable(timeZone: string): boolean {
  try {
    const probe = new Intl.DateTimeFormat("en-US", { timeZone });
    return probe.resolvedOptions().timeZone.length > 0;
  } catch {
    return false;
  }
}

/** The time zone the message itself names, or null. A zone in the provider's
    own sentence always wins over the server's: it is describing ITS clock. */
export function boardUsageLimitTimeZoneIn(text: string): string | null {
  const named = ZONE_IN_PARENS.exec(text)?.[1];
  if (named !== undefined && zoneIsUsable(named)) return named;
  return UTC_ZONE.test(text) ? "UTC" : null;
}

const ZONE_PARTS = new Map<string, Intl.DateTimeFormat>();
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = ZONE_PARTS.get(timeZone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  ZONE_PARTS.set(timeZone, formatter);
  return formatter;
}

type WallClock = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
};

/** The wall clock an instant reads as in a zone. */
function wallClockAt(utcMs: number, timeZone: string): WallClock & { readonly second: number } {
  const parts = zoneFormatter(timeZone).formatToParts(utcMs);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/**
 * The instant at which a zone's clock reads `wall`.
 *
 * Two passes, because the offset depends on the answer: guess with the offset
 * at the naive instant, then re-measure at the guess and correct if a DST
 * boundary sits between them. A wall time that does not exist (the hour a
 * spring-forward skips) resolves to the instant just after the jump, which is
 * the reading that makes "wake up then" behave sensibly.
 */
function instantOfWallClock(wall: WallClock, timeZone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const offsetAt = (utcMs: number) => {
    const there = wallClockAt(utcMs, timeZone);
    return (
      Date.UTC(there.year, there.month - 1, there.day, there.hour, there.minute, there.second) -
      Math.floor(utcMs / 1000) * 1000
    );
  };
  const first = naive - offsetAt(naive);
  const second = naive - offsetAt(first);
  return second;
}

function durationFromAtoms(
  source: string,
  pattern: RegExp,
  unitOf: (unit: string) => number | null,
): number | null {
  let total = 0;
  let matched = false;
  for (const atom of source.matchAll(pattern)) {
    const amount = Number(atom[1]);
    const unit = unitOf((atom[2] ?? "").toLowerCase());
    if (!Number.isFinite(amount) || unit === null) continue;
    total += amount * unit;
    matched = true;
  }
  return matched ? total : null;
}

const COMPACT_UNITS: Record<string, number> = { d: DAY, h: HOUR, m: MINUTE, s: 1000 };

function spelledUnit(unit: string): number | null {
  if (unit.startsWith("day")) return DAY;
  if (unit.startsWith("hour") || unit.startsWith("hr")) return HOUR;
  if (unit.startsWith("min")) return MINUTE;
  if (unit.startsWith("sec")) return 1000;
  return null;
}

/** The relative duration the message states, in ms, or null. Exported because
    the classifier needs to tell a 12-second throttle from a quota window before
    it decides what kind of refusal it is looking at (D4, rule 3). */
export function boardUsageLimitDurationMs(text: string): number | null {
  const compact = COMPACT_DURATION.exec(text)?.[1];
  if (compact !== undefined) {
    const ms = durationFromAtoms(compact, COMPACT_ATOM, (unit) => COMPACT_UNITS[unit] ?? null);
    if (ms !== null) return ms;
  }
  const spelled = SPELLED_DURATION.exec(text)?.[1];
  if (spelled !== undefined) {
    const ms = durationFromAtoms(spelled, SPELLED_ATOM, spelledUnit);
    if (ms !== null) return ms;
  }
  return null;
}

function to24Hour(hour: number, meridiem: string | undefined): number | null {
  if (meridiem === undefined) return hour >= 0 && hour <= 23 ? hour : null;
  if (hour < 1 || hour > 12) return null;
  const pm = meridiem.toLowerCase() === "pm";
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

function absoluteInstant(text: string, timeZone: string): number | null {
  const match = ABSOLUTE_DATE.exec(text);
  if (match === null) return null;
  const monthWord = (match[1] ?? match[4] ?? "").toLowerCase();
  const dayWord = match[2] ?? match[3];
  const month = MONTHS.findIndex((name) => name.startsWith(monthWord.slice(0, 3)));
  if (month < 0 || monthWord.length < 3 || dayWord === undefined) return null;
  const day = Number(dayWord);
  const year = Number(match[5]);
  const hour = to24Hour(Number(match[6]), match[8]);
  const minute = Number(match[7]);
  if (hour === null || day < 1 || day > 31 || minute > 59) return null;
  return instantOfWallClock({ year, month: month + 1, day, hour, minute }, timeZone);
}

/**
 * The NEXT time the zone's clock reads `hh:mm` after `nowMs` — 2:50am seen at
 * 11pm is tonight, seen at 3am is tomorrow.
 *
 * Rolling the DAY forward and re-resolving, rather than adding 24 hours to the
 * instant, so a day that is 23 or 25 hours long still lands on the stated clock
 * time.
 */
function nextClockInstant(hour: number, minute: number, nowMs: number, timeZone: string): number {
  const on = (utcMs: number) => {
    const there = wallClockAt(utcMs, timeZone);
    return instantOfWallClock(
      { year: there.year, month: there.month, day: there.day, hour, minute },
      timeZone,
    );
  };
  const today = on(nowMs);
  return today > nowMs ? today : on(nowMs + DAY);
}

function bareClockInstant(text: string, nowMs: number, timeZone: string): number | null {
  const match = BARE_CLOCK.exec(text);
  if (match === null) return null;
  const hour = to24Hour(Number(match[1]), match[3]);
  const minute = Number(match[2]);
  if (hour === null || minute > 59) return null;
  return nextClockInstant(hour, minute, nowMs, timeZone);
}

/**
 * When the provider says we may try again, as epoch millis — or null when the
 * message says nothing readable.
 *
 * Deliberately NOT clamped here: the horizon and the past-time rule belong to
 * the caller (`detectBoardUsageLimit`), which needs to know the difference
 * between "it said nothing" and "it said something we refuse to believe".
 */
export function boardUsageLimitResumeAtMs(input: {
  readonly text: string;
  readonly nowMs: number;
  /** The server's zone. A zone named in the message itself overrides it. */
  readonly timeZone: string;
}): number | null {
  const zone = boardUsageLimitTimeZoneIn(input.text) ?? input.timeZone;
  const timeZone = zoneIsUsable(zone) ? zone : "UTC";
  // Relative first: "try again in 2 hours" and "resets 2:50am" can both appear,
  // and the relative form is the one the provider computed for us.
  const duration = boardUsageLimitDurationMs(input.text);
  if (duration !== null) return input.nowMs + duration;
  const absolute = absoluteInstant(input.text, timeZone);
  if (absolute !== null) return absolute;
  return bareClockInstant(input.text, input.nowMs, timeZone);
}

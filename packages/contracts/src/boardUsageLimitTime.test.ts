import { describe, expect, it } from "@effect/vitest";

import {
  boardUsageLimitDurationMs,
  boardUsageLimitResumeAtMs,
  boardUsageLimitTimeZoneIn,
} from "./boardUsageLimitTime.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A fixed instant to measure every relative form against. */
const NOW = Date.parse("2026-07-19T12:00:00.000Z");

const resumeAt = (text: string, timeZone = "UTC") =>
  boardUsageLimitResumeAtMs({ text, nowMs: NOW, timeZone });

describe("boardUsageLimitDurationMs", () => {
  it("reads the compact form", () => {
    expect(boardUsageLimitDurationMs("resets in 3d 2h")).toBe(3 * DAY + 2 * HOUR);
  });

  it("reads the spelled-out form", () => {
    expect(boardUsageLimitDurationMs("Try again in 4 days 2 hours 46 minutes.")).toBe(
      4 * DAY + 2 * HOUR + 46 * MINUTE,
    );
  });

  it("reads seconds", () => {
    expect(boardUsageLimitDurationMs("Please retry in 12s")).toBe(12_000);
  });

  it("does not read a bare unit that is not a duration", () => {
    // The "in" anchor is what stops a version string or an incidental "2h" in
    // prose reading as a time.
    expect(boardUsageLimitDurationMs("the 3d model rendered fine")).toBeNull();
    expect(boardUsageLimitDurationMs("You hit your weekly limit")).toBeNull();
  });
});

describe("boardUsageLimitTimeZoneIn", () => {
  it("reads an IANA zone the provider named", () => {
    expect(boardUsageLimitTimeZoneIn("resets 2:50am (Pacific/Auckland)")).toBe("Pacific/Auckland");
  });

  it("ignores parentheses that are not a zone", () => {
    expect(boardUsageLimitTimeZoneIn("Upgrade to Plus (https://example.com/pricing)")).toBeNull();
  });

  it("reads a bare UTC", () => {
    expect(boardUsageLimitTimeZoneIn("resets at 09:00 UTC")).toBe("UTC");
  });
});

describe("boardUsageLimitResumeAtMs", () => {
  it("reads a compact relative duration", () => {
    expect(resumeAt("resets in 3d 2h")).toBe(NOW + 3 * DAY + 2 * HOUR);
  });

  it("reads a spelled-out relative duration", () => {
    expect(resumeAt("You've hit your usage limit. Try again in 4 days 2 hours 46 minutes.")).toBe(
      NOW + 4 * DAY + 2 * HOUR + 46 * MINUTE,
    );
  });

  it("reads an absolute date with an ordinal day and a meridiem", () => {
    expect(resumeAt("or try again at Jul 20th, 2026 9:48PM")).toBe(
      Date.parse("2026-07-20T21:48:00.000Z"),
    );
  });

  it("reads a bare clock in the zone the message names", () => {
    // 2:50am in Auckland (UTC+12 in July) on the next occurrence after
    // 2026-07-20 00:00 local — the instant the observed board actually resumed.
    expect(resumeAt("You've hit your session limit · resets 2:50am (Pacific/Auckland)")).toBe(
      Date.parse("2026-07-19T14:50:00.000Z"),
    );
  });

  it("reads a bare clock in the server's zone when the message names none", () => {
    // The provider's own typo: "try again a 4:03AM". Scanning for the time
    // token directly rather than behind a `try again at` lead-in is what makes
    // this parse at all.
    expect(
      resumeAt("visit https://example.com to purchase more credits or try again a 4:03AM"),
    ).toBe(Date.parse("2026-07-20T04:03:00.000Z"));
  });

  it("takes a bare clock's NEXT occurrence, today or tomorrow", () => {
    // 23:00 today is still ahead of 12:00, so it is tonight…
    expect(resumeAt("resets 23:00")).toBe(Date.parse("2026-07-19T23:00:00.000Z"));
    // …and 09:00 has gone, so it is tomorrow.
    expect(resumeAt("resets 09:00")).toBe(Date.parse("2026-07-20T09:00:00.000Z"));
  });

  it("does not roll a clock time that has only just gone to tomorrow", () => {
    // The provider writes these to the minute, so "resets 12:00" composed at
    // 11:59:59 is read a heartbeat later at 12:00:00.5. Rolling it forward
    // would park the account for 24 hours on a window that had just reopened;
    // handing the past reading back lets the classifier degrade it to the blind
    // half-hourly poll instead.
    expect(
      boardUsageLimitResumeAtMs({ text: "resets 12:00", nowMs: NOW + 500, timeZone: "UTC" }),
    ).toBe(Date.parse("2026-07-19T12:00:00.000Z"));
    // Five minutes past is still the reading it plainly is…
    expect(
      boardUsageLimitResumeAtMs({ text: "resets 12:00", nowMs: NOW + 4 * MINUTE, timeZone: "UTC" }),
    ).toBe(Date.parse("2026-07-19T12:00:00.000Z"));
    // …and beyond the grace it is tomorrow's, as before.
    expect(
      boardUsageLimitResumeAtMs({
        text: "resets 12:00",
        nowMs: NOW + 10 * MINUTE,
        timeZone: "UTC",
      }),
    ).toBe(Date.parse("2026-07-20T12:00:00.000Z"));
  });

  it("resolves a bare clock across a DST boundary in the named zone", () => {
    // 2026-03-29 is the European spring-forward. 06:00 Europe/London the
    // morning after is BST, i.e. 05:00Z — the naive "add an offset" reading
    // would be an hour out.
    const springForward = Date.parse("2026-03-29T12:00:00.000Z");
    expect(
      boardUsageLimitResumeAtMs({
        text: "resets 06:00 (Europe/London)",
        nowMs: springForward,
        timeZone: "UTC",
      }),
    ).toBe(Date.parse("2026-03-30T05:00:00.000Z"));
  });

  it("falls back to the server zone when the message names an unusable one", () => {
    expect(resumeAt("resets 23:00 (Middle/Earth)")).toBe(Date.parse("2026-07-19T23:00:00.000Z"));
  });

  it("reads a bare hour written with no minutes", () => {
    // Claude's documented refusal states the hour alone. Without this the card
    // would blind-poll every half hour to a time the provider had already given.
    expect(resumeAt("Claude AI usage limit reached, please try again after 3pm")).toBe(
      Date.parse("2026-07-19T15:00:00.000Z"),
    );
    expect(resumeAt("try again after 11 AM")).toBe(Date.parse("2026-07-20T11:00:00.000Z"));
  });

  it("prefers a full clock over the hour inside it", () => {
    // `4:03AM` must not be read as `03 AM`: the bare-hour form is a fallback.
    expect(resumeAt("try again a 4:03AM")).toBe(Date.parse("2026-07-20T04:03:00.000Z"));
  });

  it("reads nothing from a message with no time", () => {
    expect(resumeAt("You hit your weekly limit")).toBeNull();
    // A number in prose is not a time without a meridiem beside it.
    expect(resumeAt("You've reached your 5-hour message limit")).toBeNull();
  });
});

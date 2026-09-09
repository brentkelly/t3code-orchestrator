import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { BOARD_USAGE_LIMIT_RULES, type BoardUsageLimitRule } from "./boardUsageLimitCatalogue.ts";
import { detectBoardUsageLimit } from "./boardUsageLimitDetect.ts";

/**
 * Every relative form in the catalogue is measured against this, and the one
 * absolute date in it (`Jul 20th, 2026 9:48PM`) sits a day and a half ahead —
 * inside the seven-day horizon, so the sample it belongs to classifies as the
 * `wait` its rule claims. A sample carrying an absolute date has to be read
 * against a pinned clock; that is the cost of stating a real observed sentence
 * verbatim rather than a synthetic one.
 */
const NOW = Date.parse("2026-07-19T12:00:00.000Z");

const detect = (text: string, channel: "message" | "turn-error" = "message") =>
  detectBoardUsageLimit({ text, channel, nowMs: NOW, timeZone: "UTC" });

describe("detectBoardUsageLimit — the shipped catalogue", () => {
  // Criterion 9: a rule cannot be added without a working example of what it is
  // supposed to catch. This is what stops the data drifting from the algorithm.
  it.each(BOARD_USAGE_LIMIT_RULES.map((rule) => [rule.id, rule] as const))(
    "classifies %s's own sample as its own kind",
    (_id, rule: BoardUsageLimitRule) => {
      const match = detect(rule.sample);
      expect(match).not.toBeNull();
      expect(match?.kind).toBe(rule.kind);
    },
  );

  // Classifying the sample is not enough: a rule whose sample states a time the
  // parser cannot read still ships, and the card blind-polls to a moment the
  // provider had already named. These are the catalogue's timed samples.
  it.each([
    ["claude-code.session-limit", "2026-07-19T14:51:00.000Z"],
    ["claude-code.usage-limit-reached", "2026-07-19T15:01:00.000Z"],
    ["codex.usage-limit", "2026-07-20T21:49:00.000Z"],
  ])("reads the time %s's own sample states", (id, resumeAt) => {
    const rule = BOARD_USAGE_LIMIT_RULES.find((candidate) => candidate.id === id);
    expect(rule).toBeDefined();
    expect(detect(rule?.sample ?? "")?.resumeAt).toBe(resumeAt);
  });

  it("gives every rule a unique id", () => {
    const ids = BOARD_USAGE_LIMIT_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("parks Claude's session limit with a resume time and the provider's own words", () => {
    const match = detect("You've hit your session limit · resets 2:50am (Pacific/Auckland)");
    expect(match?.kind).toBe("wait");
    expect(match?.confidence).toBe("strict");
    expect(match?.ruleId).toBe("claude-code.session-limit");
    // 2:50am Auckland is 14:50Z in July, plus the +60s margin.
    expect(match?.resumeAt).toBe("2026-07-19T14:51:00.000Z");
    expect(match?.reason).toBe("You've hit your session limit · resets 2:50am (Pacific/Auckland)");
  });

  it("reads Grok's refusal off a failed turn's error field", () => {
    // No assistant message exists at all on this path — the text is the turn's
    // `errorMessage`, which is why the channel alone makes it strict.
    const match = detect("Grok usage limit reached. Try again later.", "turn-error");
    expect(match?.kind).toBe("wait");
    expect(match?.confidence).toBe("strict");
    expect(match?.resumeAt).toBeNull();
  });

  it("classifies a 429 carrying the word 'quota' as exhausted, not wait", () => {
    // The trap the three-way split exists for: retrying this never succeeds.
    const match = detect(
      "You exceeded your current quota, please check your plan and billing details",
    );
    expect(match?.kind).toBe("exhausted");
    expect(match?.resumeAt).toBeNull();
    expect(match?.ruleId).toBe("openai.insufficient-quota");
  });

  it.each([
    "Insufficient credits. This account never purchased credits, add some to continue.",
    "Insufficient Balance",
    "Your Claude Code trial has ended. Run /upgrade or /extra-usage to continue.",
    "Your credit balance is too low to access the Claude API",
  ])("classifies %s as exhausted", (text) => {
    expect(detect(text)?.kind).toBe("exhausted");
  });

  it("lets a parseable reset time beat upsell language", () => {
    const match = detect(
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://openai.com/chatgpt/pricing), or try again at Jul 20th, 2026 9:48PM",
    );
    expect(match?.kind).toBe("wait");
    expect(match?.resumeAt).toBe("2026-07-20T21:49:00.000Z");
  });

  it("escalates the same upsell when it names no time", () => {
    const match = detect(
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://openai.com/chatgpt/pricing)",
    );
    expect(match?.kind).toBe("exhausted");
  });

  it("reads the observed Codex message whose 'try again at' is a typo", () => {
    const match = detect(
      "You've hit your usage limit. Upgrade to Pro (https://example.com/pro), visit https://example.com/credits to purchase more credits or try again a 4:03AM",
    );
    expect(match?.kind).toBe("wait");
    expect(match?.resumeAt).toBe("2026-07-20T04:04:00.000Z");
  });

  it.each(["Please retry in 12s", "429 Too Many Requests"])(
    "classifies %s as slow-down, which sleeps nothing",
    (text) => {
      const match = detect(text);
      expect(match?.kind).toBe("slow-down");
      expect(match?.resumeAt).toBeNull();
    },
  );

  it("treats a time in the past or past the horizon as unreadable", () => {
    // A misread year. Believing it would park the card for a decade.
    expect(detect("You've hit your usage limit. Try again in 400 days")?.resumeAt).toBeNull();
    expect(
      detectBoardUsageLimit({
        text: "You've hit your usage limit, try again at Jan 2nd, 2020 9:00AM",
        channel: "message",
        nowMs: NOW,
        timeZone: "UTC",
      })?.resumeAt,
    ).toBeNull();
  });

  it("says nothing about an ordinary agent message", () => {
    expect(detect("I have finished the refactor and all the tests pass.")).toBeNull();
    expect(detect("")).toBeNull();
  });

  it("never reads a refusal quoted inside a long message as strict", () => {
    // Criterion 19. An agent WORKING on this very feature quotes the sentence
    // constantly; a strict match here would gate the whole provider.
    const essay = `I have been reading the usage-limit catalogue. ${"The rule set covers each provider in turn and explains the reasoning behind the three classes. ".repeat(
      6,
    )}\n\nThe observed sentence is: You've hit your session limit · resets 2:50am (Pacific/Auckland)`;
    const match = detect(essay);
    expect(match?.kind).toBe("wait");
    expect(match?.confidence).toBe("loose");
  });

  it("reads only the LAST paragraph", () => {
    // The refusal is the last thing the provider said. A quota sentence earlier
    // in a message the agent went on to work past is not a refusal.
    const match = detect(
      "You've hit your session limit · resets 2:50am (Pacific/Auckland)\n\nI worked around it and finished the migration instead.",
    );
    expect(match).toBeNull();
  });

  it("ignores a refusal inside a fenced code block", () => {
    const match = detect(
      "Here is the fixture I added:\n\n```\nYou've hit your session limit · resets 2:50am\n```",
    );
    expect(match).toBeNull();
  });
});

describe("detectBoardUsageLimit — against an injected catalogue", () => {
  // Criterion 11: the ALGORITHM is proved independently of the shipped data, so
  // a catalogue that grows to fifty entries cannot quietly become the only
  // thing under test.
  const rules: ReadonlyArray<BoardUsageLimitRule> = [
    {
      id: "test.wait",
      provider: "test",
      kind: "wait",
      match: [/\bwindow is spent\b/i],
      provenance: "inferred",
      sample: "window is spent",
    },
    {
      id: "test.slow",
      provider: "test",
      kind: "slow-down",
      match: [/\bease off\b/i],
      provenance: "inferred",
      sample: "ease off",
    },
    {
      id: "test.broke",
      provider: "test",
      kind: "exhausted",
      match: [/\bwallet is empty\b/i],
      codes: [402],
      provenance: "inferred",
      sample: "wallet is empty",
    },
  ];
  const run = (text: string, channel: "message" | "turn-error" = "message") =>
    detectBoardUsageLimit({ text, channel, nowMs: NOW, timeZone: "UTC", rules });

  it("matches nothing the injected catalogue does not name", () => {
    // Proving the injection is real: this is a shipped-catalogue refusal.
    expect(run("You've hit your session limit · resets 2:50am")).toBeNull();
  });

  it("applies precedence 1 — an exhausted marker with no time escalates", () => {
    expect(run("wallet is empty")?.kind).toBe("exhausted");
  });

  it("applies precedence 1's second clause — a readable time beats the marker", () => {
    const match = run("wallet is empty, try again in 3 hours");
    expect(match?.kind).toBe("wait");
    expect(match?.resumeAt).toBe(
      DateTime.formatIso(DateTime.makeUnsafe(NOW + 3 * 3_600_000 + 60_000)),
    );
  });

  it("applies precedence 2 — a windowed phrase waits with no time at all", () => {
    const match = run("window is spent");
    expect(match?.kind).toBe("wait");
    expect(match?.resumeAt).toBeNull();
  });

  it("applies precedence 3 — a sub-five-minute retry is a throttle", () => {
    expect(run("ease off, retry in 90s")?.kind).toBe("slow-down");
    expect(run("ease off")?.kind).toBe("slow-down");
  });

  it("believes a sub-five-minute time once a WINDOW phrase has matched", () => {
    // The floor is a test of what a bare interval MEANS, and a windowed-limit
    // phrase has already answered that. Disbelieving the time here threw away
    // the one useful fact in the sentence: the card polled blind for half an
    // hour, under a pill reading "no reset time given", to rediscover a wall
    // that had come down in three.
    const match = run("window is spent, try again in 2 minutes");
    expect(match?.kind).toBe("wait");
    expect(match?.resumeAt).toBe(DateTime.formatIso(DateTime.makeUnsafe(NOW + 120_000 + 60_000)));
  });

  it("still refuses a sub-five-minute time to an exhausted marker alone", () => {
    // Precedence 1's second clause is about a RESET time, and two minutes with
    // nothing but a billing marker beside it is not one. Nothing has said this
    // is a window, so the floor still decides.
    expect(run("wallet is empty, try again in 2 minutes")?.kind).toBe("exhausted");
  });

  it("matches on a provider error code as readily as on wording", () => {
    expect(run("Request failed with status 402")?.kind).toBe("exhausted");
    // …and not on a number that merely contains it.
    expect(run("Request failed with status 4021")).toBeNull();
  });

  it("names the rule that produced the verdict, not merely the first that matched", () => {
    // Both a slow-down and a wait rule match; the verdict is `wait`, so the
    // recorded id is the wait rule's — which is what makes a production misfire
    // point at the entry to fix.
    const match = run("ease off, the window is spent");
    expect(match?.kind).toBe("wait");
    expect(match?.ruleId).toBe("test.wait");
  });
});

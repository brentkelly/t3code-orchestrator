/**
 * T3o usage-limit classification (T3O-22, D4/D17) — the algorithm, separate
 * from the data it runs over.
 *
 * Pure and total: no Effect, no clock, no I/O, no randomness. `nowMs` and
 * `timeZone` arrive as scalars, the same "the reactor resolves, the function
 * stays pure" split `recoveryDecision` established, and `rules` is injectable so
 * the algorithm can be tested against a synthetic three-entry catalogue
 * independently of whatever the shipped one has grown into.
 *
 * ## Why strictness matters here and not in the stop-signal reader
 *
 * The costs are asymmetric. A MISSED detection is cheap: the card retries on the
 * ordinary backoff and then asks a human. A FALSE detection idles the whole
 * provider until the prober gets through. So this reads only the LAST paragraph,
 * and tiers its confidence, where `boardTextEndsWithQuestion` is deliberately
 * generous.
 */
import * as DateTime from "effect/DateTime";

import {
  BOARD_USAGE_LIMIT_RULES,
  type BoardUsageLimitClass,
  type BoardUsageLimitRule,
} from "./boardUsageLimitCatalogue.ts";
import {
  BOARD_USAGE_LIMIT_MAX_HORIZON_MS,
  BOARD_USAGE_LIMIT_RESUME_MARGIN_MS,
  BOARD_USAGE_LIMIT_SHORT_RETRY_MS,
} from "./boardUsageLimitSchedule.ts";
import { boardUsageLimitResumeAtMs } from "./boardUsageLimitTime.ts";

/**
 * Where the text came from, which is half the confidence signal.
 *
 * `turn-error` is the failed turn's own `errorMessage` — nobody quotes a
 * sentence INTO a failed turn's error field, so it is unambiguous. `message` is
 * the last assistant message, which an agent discussing quota errors can also
 * produce.
 */
export type BoardUsageLimitChannel = "message" | "turn-error";

export type BoardUsageLimitMatch = {
  readonly kind: BoardUsageLimitClass;
  readonly confidence: "strict" | "loose";
  /** When the provider says we may try again, ISO, already carrying the +60s
      margin — or null, meaning nothing readable and the caller polls blind. */
  readonly resumeAt: string | null;
  /** The provider's OWN sentence, for the card and the popover. Never our
      paraphrase: a human reading "Out of credits" wants to see what the
      provider actually said. */
  readonly reason: string;
  readonly ruleId: string;
};

/**
 * The longest a refusal can be and still read as one (D4).
 *
 * A real refusal is a bare one-liner that did no work. An agent that has been
 * WORKING and happens to mention a quota error writes paragraphs around it. So
 * length is the second half of the strict test — one string already in hand,
 * versus another projection query per turn end to ask whether the turn made any
 * tool calls.
 */
export const BOARD_USAGE_LIMIT_STRICT_MAX_CHARS = 240;

/** How much of the provider's sentence is kept as `reason`. Long enough for
    every observed refusal, short enough that a stray paragraph cannot bloat a
    persisted row or the popover. */
const REASON_MAX_CHARS = 400;

const INLINE_CODE = /`{1,2}[^`\n]*`{1,2}/g;
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/** Drop fenced code blocks, keeping the prose around them. Line-wise for the
    same reason `boardStopSignal` walks lines: a multiline regex's `$` matches at
    every line end, so a lazy body stops at the first newline and the rest of the
    block leaks into the window. */
function stripFencedBlocks(text: string): string {
  const kept: Array<string> = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1];
    if (fence === null) {
      if (marker === undefined) kept.push(line);
      else fence = marker[0] as string;
      continue;
    }
    if (marker !== undefined && marker[0] === fence) fence = null;
  }
  return kept.join("\n");
}

/** The message with code removed — what strictness is measured against. */
function strippedProse(text: string): string {
  return stripFencedBlocks(text).replace(INLINE_CODE, " ").trim();
}

/** The last non-empty paragraph, which is the only thing the catalogue is run
    over. A refusal is the last thing the provider said; anything earlier is the
    agent's own work, and matching it is how a card that quoted an error at us
    would gate its whole provider. */
function lastParagraph(prose: string): string {
  const paragraphs = prose
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  return paragraphs[paragraphs.length - 1] ?? "";
}

/** Whether a provider error code appears in the text as a whole token, so
    `429` in `HTTP 429` matches and `4290` does not. */
function mentionsCode(text: string, code: string | number): boolean {
  const token = String(code).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w-])${token}(?![\\w-])`, "i").test(text);
}

function ruleMatches(rule: BoardUsageLimitRule, text: string): boolean {
  if (rule.match.some((pattern) => pattern.test(text))) return true;
  return (rule.codes ?? []).some((code) => mentionsCode(text, code));
}

/**
 * Classify a stopped turn's text, or `null` when nothing in the catalogue
 * matched.
 *
 * **Precedence (D4), in order:**
 *
 * 1. an `exhausted` marker AND no believable resume time → `exhausted`;
 * 2. a believable resume time, or a windowed-limit phrase → `wait`;
 * 3. a retry interval under five minutes, or per-second/per-minute wording →
 *    `slow-down`;
 * 4. otherwise → `wait` with no time, and the caller polls blind.
 *
 * Rule 1's second clause is the whole point: the observed Codex refusal carries
 * an upsell AND a reset time, and **a parseable reset time beats upsell
 * language**. The same upsell with no time is an escalation.
 *
 * "Believable" excludes a time in the past and a time more than seven days out
 * (a misread year, a provider quoting a support SLA) — both read as "it said
 * nothing". A retry shorter than five minutes is excluded too, but only when no
 * windowed-limit phrase matched: on its own a short interval is a throttle and
 * rule 3 is where it belongs, while alongside "you've hit your usage limit" it
 * is simply a window that reopens soon, and the board should wake then rather
 * than poll blind for thirty minutes.
 */
export function detectBoardUsageLimit(input: {
  readonly text: string;
  readonly channel: BoardUsageLimitChannel;
  readonly nowMs: number;
  /** The server's zone, unless the message names one of its own. */
  readonly timeZone: string;
  /** Defaults to the shipped catalogue; injected in tests. */
  readonly rules?: ReadonlyArray<BoardUsageLimitRule>;
}): BoardUsageLimitMatch | null {
  const prose = strippedProse(input.text);
  if (prose.length === 0) return null;
  const paragraph = lastParagraph(prose);
  if (paragraph.length === 0) return null;

  const rules = input.rules ?? BOARD_USAGE_LIMIT_RULES;
  const matched = rules.filter((rule) => ruleMatches(rule, paragraph));
  if (matched.length === 0) return null;

  const parsedMs = boardUsageLimitResumeAtMs({
    text: paragraph,
    nowMs: input.nowMs,
    timeZone: input.timeZone,
  });
  const aheadMs = parsedMs === null ? null : parsedMs - input.nowMs;
  const shortRetry = aheadMs !== null && aheadMs > 0 && aheadMs < BOARD_USAGE_LIMIT_SHORT_RETRY_MS;
  const has = (kind: BoardUsageLimitClass) => matched.some((rule) => rule.kind === kind);
  // The short-retry floor is a test of what the interval MEANS, and once a
  // windowed-limit phrase has matched there is nothing left for it to decide:
  // "try again a 4:03AM" read at 4:01 is a window that reopens in two minutes,
  // not a per-second throttle, and disbelieving it threw away the one useful
  // fact in the sentence — the card then polled blind for half an hour to
  // rediscover a wall that had already come down, under a pill reading "no
  // reset time given". The floor still decides rule 3, where the wording alone
  // cannot tell a window from a throttle.
  const believable =
    aheadMs !== null &&
    (aheadMs >= BOARD_USAGE_LIMIT_SHORT_RETRY_MS || has("wait")) &&
    aheadMs > 0 &&
    aheadMs <= BOARD_USAGE_LIMIT_MAX_HORIZON_MS;
  const resumeAtMs = believable ? (parsedMs as number) + BOARD_USAGE_LIMIT_RESUME_MARGIN_MS : null;

  const kind: BoardUsageLimitClass =
    has("exhausted") && resumeAtMs === null
      ? "exhausted"
      : resumeAtMs !== null || has("wait")
        ? "wait"
        : shortRetry || has("slow-down")
          ? "slow-down"
          : "wait";

  // Name the rule that produced the verdict where one did, so a misfire in
  // production points at the catalogue entry to fix rather than at "some regex".
  const ruleId = (matched.find((rule) => rule.kind === kind) ?? (matched[0] as BoardUsageLimitRule))
    .id;

  return {
    kind,
    // Strict on the channel, or on a message short enough to be nothing but the
    // refusal. `slow-down` never sleeps anything, so its confidence is recorded
    // for completeness and read by nobody.
    confidence:
      input.channel === "turn-error" || prose.length <= BOARD_USAGE_LIMIT_STRICT_MAX_CHARS
        ? "strict"
        : "loose",
    // `DateTime.makeUnsafe` on a scalar, not `new Date()`: this package reaches
    // for no clock (`effect(globalDate)`), and formatting a millisecond value
    // the caller supplied is not reaching for one.
    resumeAt:
      kind === "wait" && resumeAtMs !== null
        ? DateTime.formatIso(DateTime.makeUnsafe(resumeAtMs))
        : null,
    reason: paragraph.length > REASON_MAX_CHARS ? paragraph.slice(0, REASON_MAX_CHARS) : paragraph,
    ruleId,
  };
}

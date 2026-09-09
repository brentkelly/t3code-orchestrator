/**
 * T3o provider-refusal catalogue (T3O-22, D17) — PURE DATA, no logic.
 *
 * Every quota pattern and provider error code in the product lives here and
 * NOWHERE ELSE. The two halves of detection change for different reasons and at
 * wildly different rates: this file changes whenever a provider rewrites a
 * sentence — often, by outsiders, with no reasoning required — while the
 * algorithm beside it (`boardUsageLimitDetect.ts`) changes almost never, and
 * every change to it is a behavioural change wanting review. Fusing them would
 * mean every wording tweak reopens the logic and every logic change risks the
 * wordings.
 *
 * **The centralisation rule, stated so review can enforce it:** a quota pattern
 * or provider error code appearing anywhere other than this file is a defect.
 *
 * Three classes, only one of which sleeps (D4):
 *
 * - `wait` — a usage window is exhausted and resets on its own. Park, cool the
 *   provider down, auto-resume.
 * - `slow-down` — a short per-second / per-minute throttle. No cooldown; the
 *   retry backoff already covers it.
 * - `exhausted` — out of credits, unpaid, expired plan or trial. NEVER sleep:
 *   no amount of waiting fixes it, so it goes straight to a human.
 *
 * The trap that split exists to avoid: OpenAI's `insufficient_quota` arrives as
 * an HTTP **429** carrying the word **"quota"** and retrying it never succeeds.
 * A single "quota" pattern would put a card to sleep for seven days over an
 * expired card, and gate the whole provider while it did.
 */

/** What a refusal means for scheduling. See the module doc. */
export const BOARD_USAGE_LIMIT_CLASSES = ["wait", "slow-down", "exhausted"] as const;
export type BoardUsageLimitClass = (typeof BOARD_USAGE_LIMIT_CLASSES)[number];

/**
 * How well we know a rule is real.
 *
 * Load-bearing, not documentation. Two of the `observed` rules came out of this
 * board's own database; the API-key providers reached through OpenCode are
 * `documented` or `inferred` from their error-code docs, because their exact
 * user-facing strings could not be confirmed. Those want a second pass once a
 * real one is seen, and this field is what makes that list greppable instead of
 * archaeology.
 */
export type BoardUsageLimitProvenance = "observed" | "documented" | "inferred";

export type BoardUsageLimitRule = {
  /** Stable, e.g. `claude-code.session-limit`. Recorded on the cooldown, so a
      misfire in production names the entry that caused it — the difference
      between "some regex matched" and a one-line fix. */
  readonly id: string;
  readonly provider: string;
  readonly kind: BoardUsageLimitClass;
  /** Any-of. Written case-insensitive; the classifier does not re-flag them. */
  readonly match: ReadonlyArray<RegExp>;
  /** Provider error codes that mean the same thing, e.g. `402`, `-32003`,
      `insufficient_quota`. Matched as whole tokens against the message. */
  readonly codes?: ReadonlyArray<string | number>;
  readonly provenance: BoardUsageLimitProvenance;
  /** A URL, or where it was seen: `live board, thread-05401bfb, 2026-09-08`. */
  readonly source?: string;
  /** The exact sentence. This IS the test fixture — the catalogue suite walks
      every rule's own sample through the classifier and asserts its `kind`, so a
      rule cannot be added without an example of what it is supposed to catch. */
  readonly sample: string;
};

/**
 * The shipped catalogue.
 *
 * Ordered `wait`, then `slow-down`, then `exhausted`, purely for reading. The
 * classifier applies its own precedence and never depends on this order.
 */
export const BOARD_USAGE_LIMIT_RULES: ReadonlyArray<BoardUsageLimitRule> = [
  // ── wait: a window that resets on its own ────────────────────────────
  {
    id: "claude-code.session-limit",
    provider: "claude",
    kind: "wait",
    match: [/\byou'?ve hit your session limit\b/i, /\bsession limit\b.*\bresets?\b/i],
    provenance: "observed",
    source: "live board, thread-05401bfb, 2026-09-08",
    sample: "You've hit your session limit · resets 2:50am (Pacific/Auckland)",
  },
  {
    id: "claude-code.usage-limit-reached",
    provider: "claude",
    kind: "wait",
    match: [/\bclaude (ai )?usage limit reached\b/i, /\busage limit reached\b.*\btry again\b/i],
    provenance: "documented",
    source: "https://docs.claude.com/en/docs/claude-code",
    sample: "Claude AI usage limit reached, please try again after 3pm",
  },
  {
    id: "claude.message-window-limit",
    provider: "claude",
    kind: "wait",
    match: [/\byou'?ve reached your \d+[-\s]?hour (message )?limit\b/i],
    provenance: "documented",
    sample: "You've reached your 5-hour message limit",
  },
  {
    id: "codex.usage-limit",
    provider: "codex",
    kind: "wait",
    match: [/\byou'?ve hit your usage limit\b/i, /\busage limit\b.*\btry again\b/i],
    provenance: "observed",
    source: "T3O-22 brief, reported by the maintainer",
    sample:
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://openai.com/chatgpt/pricing), or try again at Jul 20th, 2026 9:48PM",
  },
  {
    id: "codex.usage-limit-relative",
    provider: "codex",
    kind: "wait",
    match: [/\byou'?ve hit your usage limit\b/i],
    provenance: "documented",
    sample: "You've hit your usage limit. Try again in 4 days 2 hours 46 minutes.",
  },
  {
    id: "grok.weekly-limit",
    provider: "grok",
    kind: "wait",
    match: [/\byou hit your (weekly|daily|monthly) limit\b/i],
    provenance: "observed",
    source: "T3O-22 brief, reported by the maintainer",
    sample: "You hit your weekly limit",
  },
  {
    id: "grok.resets-in",
    provider: "grok",
    kind: "wait",
    match: [/\bresets? in\s+\d/i],
    provenance: "observed",
    source: "T3O-22 brief, reported by the maintainer",
    sample: "resets in 3d 2h",
  },
  {
    id: "grok.acp-usage-limit",
    provider: "grok",
    kind: "wait",
    // The text the xAI ACP extension raises with code -32003.
    match: [/\bgrok usage limit reached\b/i],
    codes: [-32003],
    provenance: "observed",
    source: "apps/server/src/providers/grok/XAiAcpExtension.ts",
    sample: "Grok usage limit reached. Try again later.",
  },
  {
    id: "cursor.plan-limit",
    provider: "cursor",
    kind: "wait",
    match: [/\byou'?ve reached the limit for your current plan\b/i],
    provenance: "documented",
    sample: "You've reached the limit for your current plan",
  },
  {
    id: "gemini.resource-exhausted",
    provider: "gemini",
    kind: "wait",
    match: [/\bquota exceeded for quota metric\b/i, /\bRESOURCE_EXHAUSTED\b/],
    provenance: "documented",
    source: "https://ai.google.dev/gemini-api/docs/troubleshooting",
    sample: "Quota exceeded for quota metric 'Generate requests per minute'",
  },

  // ── slow-down: a short throttle the retry backoff already covers ─────
  {
    id: "http.429",
    provider: "any",
    kind: "slow-down",
    match: [/\b429 too many requests\b/i, /\btoo many requests\b/i],
    codes: [429],
    provenance: "documented",
    sample: "429 Too Many Requests",
  },
  {
    id: "generic.rate-limit-exceeded",
    provider: "any",
    kind: "slow-down",
    match: [/\brate limit(ed| exceeded| reached)?\b/i],
    provenance: "documented",
    sample: "Rate limit exceeded. Please retry in 12s",
  },
  {
    id: "generic.retry-in-seconds",
    provider: "any",
    kind: "slow-down",
    // A retry measured in SECONDS is a throttle whatever the surrounding
    // wording says: it clears well inside the first retry rung, so parking the
    // card and gating the provider would trade seconds of waiting for minutes.
    match: [/\b(retry|try again)\s+in\s+\d+\s*(s\b|seconds?\b)/i],
    provenance: "documented",
    sample: "Please retry in 12s",
  },
  {
    id: "generic.per-minute-limit",
    provider: "any",
    kind: "slow-down",
    match: [/\b(requests?|tokens?) per (second|minute)\b/i, /\bslow down\b/i],
    provenance: "documented",
    sample: "You have exceeded the requests per minute limit for this model",
  },
  {
    id: "deepseek.rate-limit",
    provider: "deepseek",
    kind: "slow-down",
    match: [/\breduce (your )?concurrency\b/i],
    provenance: "documented",
    source: "https://api-docs.deepseek.com/quick_start/error_codes",
    sample: "Rate limit reached — please reduce your concurrency and retry",
  },

  // ── exhausted: money, not time ───────────────────────────────────────
  {
    id: "openai.insufficient-quota",
    provider: "openai",
    kind: "exhausted",
    // The trap this catalogue exists for: an HTTP 429 that carries the word
    // "quota" and NEVER succeeds on retry.
    match: [
      /\byou exceeded your current quota\b/i,
      /\bcheck your plan and billing details\b/i,
      /\binsufficient_quota\b/i,
    ],
    codes: ["insufficient_quota"],
    provenance: "documented",
    source: "https://platform.openai.com/docs/guides/error-codes",
    sample: "You exceeded your current quota, please check your plan and billing details",
  },
  {
    id: "codex.upgrade-upsell",
    provider: "codex",
    kind: "exhausted",
    // Upsell language with NO reset time is an escalation, not a sleep: the
    // provider is telling us the only way forward is money. The same sentence
    // WITH a time classifies `wait`, because a parseable reset beats an upsell
    // (D4, rule 1) — which is exactly how the observed Codex message reads.
    match: [/\bupgrade to (plus|pro|max|a paid plan)\b/i, /\bpurchase more credits\b/i],
    provenance: "observed",
    source: "T3O-22 brief, reported by the maintainer",
    sample:
      "You've hit your usage limit. Upgrade to Plus to continue using Codex (https://openai.com/chatgpt/pricing)",
  },
  {
    id: "openrouter.insufficient-credits",
    provider: "openrouter",
    kind: "exhausted",
    match: [
      /\binsufficient credits\b/i,
      /\bthis request requires more credits\b/i,
      /\bnever purchased credits\b/i,
    ],
    codes: [402],
    provenance: "documented",
    source: "https://openrouter.ai/docs/errors",
    sample: "Insufficient credits. This account never purchased credits, add some to continue.",
  },
  {
    id: "deepseek.insufficient-balance",
    provider: "deepseek",
    kind: "exhausted",
    match: [/\binsufficient balance\b/i],
    codes: [402],
    provenance: "documented",
    source: "https://api-docs.deepseek.com/quick_start/error_codes",
    sample: "Insufficient Balance",
  },
  {
    id: "kimi.exceeded-current-quota",
    provider: "kimi",
    kind: "exhausted",
    match: [/\bexceeded_current_quota_error\b/i],
    codes: ["exceeded_current_quota_error"],
    provenance: "inferred",
    source: "Moonshot error-code reference; exact user-facing string unconfirmed",
    sample: "exceeded_current_quota_error: your account balance is not enough",
  },
  {
    id: "claude-code.trial-ended",
    provider: "claude",
    kind: "exhausted",
    match: [/\btrial has ended\b/i],
    provenance: "documented",
    sample: "Your Claude Code trial has ended. Run /upgrade or /extra-usage to continue.",
  },
  {
    id: "claude.credit-balance-too-low",
    provider: "claude",
    kind: "exhausted",
    match: [/\bcredit balance is too low\b/i],
    provenance: "documented",
    source: "https://docs.claude.com/en/api/errors",
    sample: "Your credit balance is too low to access the Claude API",
  },
  {
    id: "generic.plan-expired",
    provider: "any",
    kind: "exhausted",
    match: [/\b(subscription|plan) has expired\b/i, /\bpayment (is )?(required|failed)\b/i],
    codes: [402],
    provenance: "documented",
    sample: "Your subscription has expired — renew it to continue.",
  },
];

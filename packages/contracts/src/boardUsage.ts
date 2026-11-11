/**
 * T3o: a card's token usage and cost (T3O-77). Each finished turn is priced once: a user
 * price (`override`) is exact, the LiteLLM table (`listPriced`) is an estimate, and
 * `unpriced`, `noUsage` or provider-`partial` turns leave the figure a lower bound.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const NonNegativeNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const BoardCardUsageRow = Schema.Struct({
  /** The thread link's role: a stage id (`building`) or a step id (`review@2`). */
  stepId: TrimmedNonEmptyString,
  threadId: ThreadId,
  /** The provider driver (`claudeAgent`, `codex`, …). */
  provider: TrimmedNonEmptyString,
  /** The model the turns reported, or null when no turn named one. */
  model: Schema.NullOr(TrimmedNonEmptyString),
  uncachedInputTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  /** Includes reasoning. */
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  /** The priced turns only; an unpriced or no-usage turn adds nothing. */
  costUsd: NonNegativeNumber,
  turnsReported: NonNegativeInt,
  turnsOverride: NonNegativeInt,
  turnsListPriced: NonNegativeInt,
  turnsUnpriced: NonNegativeInt,
  turnsNoUsage: NonNegativeInt,
  /** Priced turns (also counted above) whose provider marked them `partial`. */
  turnsPartial: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  updatedAt: IsoDateTime,
});
export type BoardCardUsageRow = typeof BoardCardUsageRow.Type;

/** At most this many providers ride a shell summary; the rest fold into `other`. */
export const BOARD_USAGE_SHELL_PROVIDERS_MAX = 4;
export const BOARD_USAGE_OTHER_PROVIDER = "other";

export const BoardCardUsageProviderSummary = Schema.Struct({
  provider: TrimmedNonEmptyString,
  tokens: NonNegativeInt,
  costUsd: NonNegativeNumber,
  /** Key-optional, present only when true, like the summary's own flags. */
  estimated: Schema.optionalKey(Schema.Boolean),
  partial: Schema.optionalKey(Schema.Boolean),
});
export type BoardCardUsageProviderSummary = typeof BoardCardUsageProviderSummary.Type;

/**
 * The shell's per-card figure. Absent on the shell when nothing is known, which reads
 * `—`, never `$0`. The flags are key-optional and present only when true, to keep the
 * shell's byte budget.
 */
export const BoardCardUsageSummary = Schema.Struct({
  /** Input (cached and uncached) plus output. */
  tokens: NonNegativeInt,
  costUsd: NonNegativeNumber,
  /** At least one turn was priced, so `costUsd` is a figure and not just a zero. */
  costKnown: Schema.optionalKey(Schema.Boolean),
  /** At least one turn was priced from the model price table. */
  estimated: Schema.optionalKey(Schema.Boolean),
  /** Some turn was unpriced, reported no usage or only partial usage, or the card ran on a worker before
      usage was tracked: the figure is a lower bound. */
  partial: Schema.optionalKey(Schema.Boolean),
  providers: Schema.Array(BoardCardUsageProviderSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type BoardCardUsageSummary = typeof BoardCardUsageSummary.Type;

/** The fields of a row that a summary is built from. */
export type BoardUsageRowTotals = Pick<
  BoardCardUsageRow,
  | "provider"
  | "uncachedInputTokens"
  | "cachedInputTokens"
  | "cacheCreationTokens"
  | "outputTokens"
  | "costUsd"
  | "turnsReported"
  | "turnsOverride"
  | "turnsListPriced"
  | "turnsUnpriced"
  | "turnsNoUsage"
  | "turnsPartial"
>;

const boardUsageRowTokens = (
  row: Pick<
    BoardCardUsageRow,
    "uncachedInputTokens" | "cachedInputTokens" | "cacheCreationTokens" | "outputTokens"
  >,
): number =>
  row.uncachedInputTokens + row.cachedInputTokens + row.cacheCreationTokens + row.outputTokens;

const flag = <K extends string>(key: K, value: boolean): { readonly [P in K]?: true } =>
  (value ? { [key]: true } : {}) as { readonly [P in K]?: true };

/** Cost is summed in micro-dollars so the SQL producer, which rounds the same way, agrees. */
const roundUsd = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

/**
 * The card's shell summary from its rows, or null when there is nothing to show. The JS
 * producer; `listBoardCardShellRows` aggregates the same thing in SQL and
 * `cardMetaShellFields.test.ts` holds the two together.
 */
export function boardCardUsageSummaryFromRows(
  rows: ReadonlyArray<BoardUsageRowTotals>,
  historyPartial: boolean,
): BoardCardUsageSummary | null {
  if (rows.length === 0 && !historyPartial) return null;
  type Acc = {
    tokens: number;
    costUsd: number;
    priced: boolean;
    estimated: boolean;
    partial: boolean;
  };
  const empty = (): Acc => ({
    tokens: 0,
    costUsd: 0,
    priced: false,
    estimated: false,
    partial: false,
  });
  const total = empty();
  const byProvider = new Map<string, Acc>();
  for (const row of rows) {
    const tokens = boardUsageRowTokens(row);
    const priced = row.turnsReported + row.turnsOverride + row.turnsListPriced > 0;
    const estimated = row.turnsListPriced > 0;
    const partial = row.turnsUnpriced + row.turnsNoUsage + row.turnsPartial > 0;
    let provider = byProvider.get(row.provider);
    if (provider === undefined) {
      provider = empty();
      byProvider.set(row.provider, provider);
    }
    for (const acc of [total, provider]) {
      acc.tokens += tokens;
      acc.costUsd += row.costUsd;
      acc.priced ||= priced;
      acc.estimated ||= estimated;
      acc.partial ||= partial;
    }
  }
  total.partial ||= historyPartial;
  const ranked = [...byProvider.entries()].sort(
    ([a, left], [b, right]) =>
      right.costUsd - left.costUsd || right.tokens - left.tokens || (a < b ? -1 : 1),
  );
  const kept = ranked.slice(0, BOARD_USAGE_SHELL_PROVIDERS_MAX - 1);
  const rest = ranked.slice(BOARD_USAGE_SHELL_PROVIDERS_MAX - 1);
  if (rest.length === 1) kept.push(rest[0]!);
  else if (rest.length > 1) {
    const other = empty();
    for (const [, acc] of rest) {
      other.tokens += acc.tokens;
      other.costUsd += acc.costUsd;
      other.estimated ||= acc.estimated;
      other.partial ||= acc.partial;
    }
    kept.push([BOARD_USAGE_OTHER_PROVIDER, other]);
  }
  return {
    tokens: total.tokens,
    costUsd: roundUsd(total.costUsd),
    ...flag("costKnown", total.priced),
    ...flag("estimated", total.estimated),
    ...flag("partial", total.partial),
    providers: kept.map(([provider, acc]) => ({
      provider,
      tokens: acc.tokens,
      costUsd: roundUsd(acc.costUsd),
      ...flag("estimated", acc.estimated),
      ...flag("partial", acc.partial),
    })),
  };
}

/**
 * Several summaries as one: a group's children, or the cards in view. Null when none of
 * them has anything to show. Providers are summed across the inputs and never capped,
 * because the result is only ever drawn, never sent.
 */
export function sumBoardCardUsageSummaries(
  summaries: Iterable<BoardCardUsageSummary | null | undefined>,
): BoardCardUsageSummary | null {
  let any = false;
  let tokens = 0;
  let costUsd = 0;
  let costKnown = false;
  let estimated = false;
  let partial = false;
  const providers = new Map<
    string,
    { tokens: number; costUsd: number; estimated: boolean; partial: boolean }
  >();
  for (const summary of summaries) {
    if (summary == null) continue;
    any = true;
    tokens += summary.tokens;
    costUsd += summary.costUsd;
    costKnown ||= summary.costKnown === true;
    estimated ||= summary.estimated === true;
    partial ||= summary.partial === true;
    for (const entry of summary.providers) {
      const held = providers.get(entry.provider) ?? {
        tokens: 0,
        costUsd: 0,
        estimated: false,
        partial: false,
      };
      held.tokens += entry.tokens;
      held.costUsd += entry.costUsd;
      held.estimated ||= entry.estimated === true;
      held.partial ||= entry.partial === true;
      providers.set(entry.provider, held);
    }
  }
  if (!any) return null;
  return {
    tokens,
    costUsd: roundUsd(costUsd),
    ...flag("costKnown", costKnown),
    ...flag("estimated", estimated),
    ...flag("partial", partial),
    providers: [...providers.entries()]
      .sort(([, a], [, b]) => b.costUsd - a.costUsd || b.tokens - a.tokens)
      .map(([provider, held]) => ({
        provider,
        tokens: held.tokens,
        costUsd: roundUsd(held.costUsd),
        ...flag("estimated", held.estimated),
        ...flag("partial", held.partial),
      })),
  };
}

const REVIEW_LOOP_STEP = /^(?:review|triage|adjudicate|retriage|readjudicate|sync)@\d+$/;
const CI_STEP = /^ci(?:-fix)?@/;

/**
 * The stage a usage row's step belongs to, for the By stage view: a review round's
 * phases group under `review`, CI agents and CI fixes under `ci`, and a stage-named role
 * (`planning`, `building`, `merge`) is its own stage.
 */
export function boardUsageStageOfStep(stepId: string): string {
  if (REVIEW_LOOP_STEP.test(stepId)) return "review";
  if (CI_STEP.test(stepId)) return "ci";
  return stepId;
}

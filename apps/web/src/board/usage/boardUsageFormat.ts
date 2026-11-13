/**
 * How a card's cost is written everywhere it appears (T3O-77, the Token Usage and Cost
 * prototype). Cost is plain ink, never a status hue. `$1.84` is exact, `≈$1.84` is partly
 * priced from the model price table, `$1.84+` is a lower bound, and `—` means nothing is
 * known: never `$0`.
 */
import {
  BOARD_USAGE_OTHER_PROVIDER,
  type BoardCardUsageSummary,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
} from "@t3tools/contracts";

// oxlint-disable-next-line t3code/no-em-dash-copy -- the design's figure for "nothing known", not prose
export const BOARD_USAGE_UNKNOWN = "—";

export interface BoardUsageFigure {
  /** The figure as drawn: `≈$1.84+`, `—` or `no usage`. */
  readonly text: string;
  /** Whether a dollar amount is shown; a `—` sorts last and reads muted. */
  readonly known: boolean;
  readonly tooltip: string;
}

/** The steps behind ≈ and +, named in the tooltip where the caller knows them. */
export interface BoardUsageFigureSteps {
  readonly estimated?: ReadonlyArray<string>;
  readonly partial?: ReadonlyArray<string>;
}

export interface BoardUsageMarks {
  readonly costUsd: number;
  readonly costKnown?: boolean | undefined;
  readonly estimated?: boolean | undefined;
  readonly partial?: boolean | undefined;
  readonly tokens: number;
  readonly providers?: ReadonlyArray<unknown>;
}

// Grey shades by stage order: cost is plain ink, never a status hue.
const STAGE_SHADES = [64, 48, 36, 26, 18, 12];

/** The grey a stage wears in every cost bar and swatch, by its position. */
export function boardUsageStageShade(index: number): string {
  const percent = STAGE_SHADES[Math.min(index, STAGE_SHADES.length - 1)];
  return `color-mix(in srgb, var(--foreground) ${percent}%, transparent)`;
}

/** `Code review (4 rounds)`: a review stage names how many rounds it spent. */
export function boardUsageStageLabel(stage: {
  readonly label: string;
  readonly rounds: number;
}): string {
  if (stage.rounds === 0) return stage.label;
  return `${stage.label} (${stage.rounds} ${stage.rounds === 1 ? "round" : "rounds"})`;
}

export function formatBoardUsd(costUsd: number): string {
  if (costUsd > 0 && costUsd < 0.005) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

/** `1.24M`, `12.4k`, `812`. */
export function formatBoardTokens(tokens: number | null): string {
  if (tokens === null) return BOARD_USAGE_UNKNOWN;
  if (tokens >= 999_950) return `${(tokens / 1e6).toFixed(2)}M`;
  if (tokens >= 1e3) return `${(tokens / 1e3).toFixed(1)}k`;
  return String(tokens);
}

const listSteps = (steps: ReadonlyArray<string> | undefined): string =>
  steps === undefined || steps.length === 0 ? "" : ` (${steps.join(", ")})`;

/**
 * The figure for a card, a group or the cards in view. `noUsageWord` writes `no usage`
 * instead of `—` when every turn reported nothing, as the Done card face does.
 */
export function formatBoardUsageCost(
  usage: BoardUsageMarks | null | undefined,
  options: { readonly steps?: BoardUsageFigureSteps; readonly noUsageWord?: boolean } = {},
): BoardUsageFigure {
  if (usage == null) {
    return { text: BOARD_USAGE_UNKNOWN, known: false, tooltip: "No usage recorded yet." };
  }
  if (usage.costKnown !== true) {
    // No rows at all, only a partial mark: the card's earlier work ran on a worker.
    if (usage.tokens === 0 && usage.partial === true && usage.providers?.length === 0) {
      return {
        text: BOARD_USAGE_UNKNOWN,
        known: false,
        tooltip: "Earlier work ran on a worker before usage was tracked, so it is not counted.",
      };
    }
    const nothingReported = usage.tokens === 0;
    return {
      text: nothingReported && options.noUsageWord === true ? "no usage" : BOARD_USAGE_UNKNOWN,
      known: false,
      tooltip: nothingReported
        ? "The provider reported no token usage. Not counted, and not $0."
        : "Tokens were reported, but no model here has a price. Add one on the Usage page.",
    };
  }
  const estimated = usage.estimated === true;
  const partial = usage.partial === true;
  const notes = [
    partial
      ? `Partial: some steps were unpriced or reported only part or none of their usage${listSteps(options.steps?.partial)}, so this is a lower bound.`
      : "",
    estimated
      ? `Partly priced from the model price table${listSteps(options.steps?.estimated)}.`
      : "",
  ].filter((note) => note.length > 0);
  return {
    text: `${estimated ? "≈" : ""}${formatBoardUsd(usage.costUsd)}${partial ? "+" : ""}`,
    known: true,
    tooltip: notes.length === 0 ? "Exact: every priced turn has a set price." : notes.join(" "),
  };
}

export function boardUsageProviderLabel(provider: string): string {
  if (provider === BOARD_USAGE_OTHER_PROVIDER) return "Other providers";
  return PROVIDER_DISPLAY_NAMES[provider as ProviderDriverKind] ?? provider;
}

/** A Done card's figure is drawn in full ink at or over the board's threshold. */
export function isBoardUsageEmphasized(
  usage: Pick<BoardCardUsageSummary, "costUsd" | "costKnown"> | null | undefined,
  thresholdUsd: number,
): boolean {
  return usage?.costKnown === true && usage.costUsd >= thresholdUsd;
}

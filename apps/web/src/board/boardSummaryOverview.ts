/**
 * The Summary pane's overview (Build Summary v3): the tiles that answer "is it
 * safe, what did it cost", the not-done callout, and each collapsed section's
 * closed-row counts. Pure over the recap, the decision log and the usage, so the
 * pane only draws it. Tones follow docs/t3o/status-colours.md.
 */
import type {
  BoardBuildSummaryCheck,
  BoardBuildSummaryCheckStatus,
  BoardBuildSummaryNote,
  BoardBuildSummaryNoteKind,
} from "@t3tools/contracts";

import type { BoardCardWorkSummary, BoardCardWorkSummaryTone } from "./boardCardWorkSummary";
import type { BoardDecisionLogView } from "./boardDecisionLog";
import type { BoardUsageBreakdown } from "./usage/boardUsageBreakdown";
import {
  BOARD_USAGE_UNKNOWN,
  boardUsageStageLabel,
  formatBoardTokens,
  formatBoardUsageCost,
} from "./usage/boardUsageFormat";

/** Green settled only, blue running, violet waiting on a human, amber flagged. */
export type BoardSummaryTone = "success" | "info" | "attention" | "warning" | "none";

export type BoardSummarySectionId = "notes" | "checks" | "built" | "decisions" | "usage";

export const BOARD_SUMMARY_SECTION_NAMES: Record<BoardSummarySectionId, string> = {
  notes: "Heads-up",
  checks: "Checks & review",
  built: "What was built",
  decisions: "Decision log",
  usage: "Usage",
};

/** A status hue, plain grey, or a stage's cost shade by index. */
export type BoardSummaryFill =
  | Exclude<BoardSummaryTone, "none">
  | "neutral"
  | { readonly shade: number };

export interface BoardSummaryBarSegment {
  readonly weight: number;
  readonly fill: BoardSummaryFill;
  readonly tip: string;
}

export interface BoardSummaryTile {
  readonly section: BoardSummarySectionId;
  readonly label: string;
  readonly value: string;
  /** Muted words after the value: `so far` on a running card. */
  readonly suffix: string | null;
  readonly sub: string;
  readonly bar: ReadonlyArray<BoardSummaryBarSegment>;
  readonly tone: BoardSummaryTone;
  /** The value's own tooltip, such as what ≈ and + mean. */
  readonly tooltip: string | null;
  readonly ariaLabel: string;
  /** False for an empty slot: nothing to open, drawn muted. */
  readonly available: boolean;
}

export interface BoardSummaryChip {
  readonly label: string;
  readonly tone: Exclude<BoardSummaryTone, "none"> | "neutral";
}

export interface BoardSummarySection {
  readonly id: BoardSummarySectionId;
  readonly name: string;
  readonly count: string;
  readonly chips: ReadonlyArray<BoardSummaryChip>;
}

export interface BoardSummaryOverview {
  readonly tiles: ReadonlyArray<BoardSummaryTile>;
  /** The text of each `not_done` note, for the callout. */
  readonly notDone: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<BoardSummarySection>;
  /** Sections open when the pane mounts. */
  readonly initiallyOpen: ReadonlyArray<BoardSummarySectionId>;
  /** Notes sorted not done, plan change, shortcut. */
  readonly notes: ReadonlyArray<BoardBuildSummaryNote>;
  /** Checks sorted flagged, skipped, passed. */
  readonly checks: ReadonlyArray<BoardBuildSummaryCheck>;
  /** Whether Checks & review carries the review row. */
  readonly showReview: boolean;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const NOTE_ORDER: Record<BoardBuildSummaryNoteKind, number> = {
  not_done: 0,
  plan_change: 1,
  shortcut: 2,
};

const CHECK_ORDER: Record<BoardBuildSummaryCheckStatus, number> = {
  fail: 0,
  fail_preexisting: 0,
  not_run: 1,
  pass: 2,
};

const stableSort = <T>(items: ReadonlyArray<T>, rank: (item: T) => number): ReadonlyArray<T> =>
  items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map((entry) => entry.item);

const toneOf = (tone: BoardCardWorkSummaryTone): BoardSummaryTone =>
  tone === "muted" ? "none" : tone;

const TONE_WORD: Record<BoardSummaryTone, string> = {
  success: "settled",
  info: "running",
  attention: "waiting on you",
  warning: "needs a look",
  none: "",
};

function ariaLabelOf(tile: Omit<BoardSummaryTile, "ariaLabel">): string {
  const value = tile.suffix === null ? tile.value : `${tile.value} ${tile.suffix}`;
  const tone = TONE_WORD[tile.tone];
  const head = tile.available ? `${tile.label}: ${value}` : tile.label;
  const parts = [head, tile.sub, tone].filter((part) => part.length > 0).join(", ");
  return tile.available
    ? `${parts}. Opens ${BOARD_SUMMARY_SECTION_NAMES[tile.section]}`
    : `${parts}.`;
}

const tile = (input: Omit<BoardSummaryTile, "ariaLabel">): BoardSummaryTile => ({
  ...input,
  ariaLabel: ariaLabelOf(input),
});

const emptyTile = (section: BoardSummarySectionId, label: string, sub: string): BoardSummaryTile =>
  tile({
    section,
    label,
    value: BOARD_USAGE_UNKNOWN,
    suffix: null,
    sub,
    bar: [],
    tone: "none",
    tooltip: null,
    available: false,
  });

function checkCounts(checks: ReadonlyArray<BoardBuildSummaryCheck>) {
  const count = (statuses: ReadonlyArray<BoardBuildSummaryCheckStatus>) =>
    checks.filter((check) => statuses.includes(check.status)).length;
  return {
    passed: count(["pass"]),
    flagged: count(["fail", "fail_preexisting"]),
    preexisting: count(["fail_preexisting"]),
    skipped: count(["not_run"]),
  };
}

function noteCounts(notes: ReadonlyArray<BoardBuildSummaryNote>) {
  const count = (kind: BoardBuildSummaryNoteKind) =>
    notes.filter((note) => note.kind === kind).length;
  return {
    notDone: count("not_done"),
    planChanges: count("plan_change"),
    shortcuts: count("shortcut"),
  };
}

function checksTile(checks: ReadonlyArray<BoardBuildSummaryCheck>): BoardSummaryTile {
  if (checks.length === 0) return emptyTile("checks", "Checks", "No checks reported");
  const { passed, flagged, preexisting, skipped } = checkCounts(checks);
  const flaggedText =
    flagged === 0
      ? null
      : preexisting === flagged
        ? `${flagged} flagged, not from this card`
        : `${flagged} flagged`;
  const subParts = [flaggedText, skipped > 0 ? `${skipped} skipped` : null].filter(
    (part): part is string => part !== null,
  );
  return tile({
    section: "checks",
    label: "Checks",
    value: `${passed} / ${checks.length} passed`,
    suffix: null,
    sub: subParts.length === 0 ? "All clean" : subParts.join(" · "),
    bar: [
      { weight: passed, fill: "success", tip: `${passed} passed` },
      { weight: flagged, fill: "warning", tip: `${flagged} flagged` },
      { weight: skipped, fill: "neutral", tip: `${skipped} skipped` },
    ].filter((segment) => segment.weight > 0) as ReadonlyArray<BoardSummaryBarSegment>,
    tone: flagged > 0 ? "warning" : "success",
    tooltip: null,
    available: true,
  });
}

function reviewTile(review: BoardCardWorkSummary["review"]): BoardSummaryTile {
  const { raised, fixed, rejected, open, disputed, escalated } = review.counts;
  const extra = [
    open > 0 ? `${open} open` : null,
    disputed > 0 ? `${disputed} disputed` : null,
    escalated > 0 ? `${escalated} escalated` : null,
  ].filter((part): part is string => part !== null);
  const settled = !review.empty && open + disputed + escalated === 0;
  const tone =
    review.loop !== null ? toneOf(review.loop.tone) : settled ? ("success" as const) : "none";
  return tile({
    section: "checks",
    label: "Review",
    value: `Round ${review.empty ? 1 : review.currentRound} of ${review.maxRounds}`,
    suffix: null,
    sub: [`${raised} raised · ${fixed} fixed · ${rejected} rejected`, ...extra].join(" · "),
    bar: [
      { weight: fixed, fill: "success", tip: `${fixed} fixed` },
      { weight: rejected, fill: "neutral", tip: `${rejected} rejected` },
      { weight: open, fill: "info", tip: `${open} open` },
      {
        weight: disputed + escalated,
        fill: "attention",
        tip: `${disputed + escalated} disputed or escalated`,
      },
    ].filter((segment) => segment.weight > 0) as ReadonlyArray<BoardSummaryBarSegment>,
    tone,
    tooltip: review.loop?.label ?? null,
    available: true,
  });
}

function notesTile(notes: ReadonlyArray<BoardBuildSummaryNote> | null): BoardSummaryTile {
  if (notes === null) return emptyTile("notes", "Heads-up", "No build notes");
  const { notDone, planChanges, shortcuts } = noteCounts(notes);
  if (notes.length === 0) {
    return tile({
      section: "notes",
      label: "Heads-up",
      value: "0 notes",
      suffix: null,
      sub: "Nothing to flag",
      bar: [],
      tone: "success",
      tooltip: null,
      available: false,
    });
  }
  return tile({
    section: "notes",
    label: "Heads-up",
    value: plural(notes.length, "note"),
    suffix: null,
    sub: [
      notDone > 0 ? `${notDone} not done` : null,
      planChanges > 0 ? plural(planChanges, "plan change") : null,
      shortcuts > 0 ? plural(shortcuts, "shortcut") : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
    bar: [
      { weight: notDone, fill: "warning", tip: `${notDone} not done` },
      { weight: planChanges, fill: "attention", tip: plural(planChanges, "plan change") },
      { weight: shortcuts, fill: "neutral", tip: plural(shortcuts, "shortcut") },
    ].filter((segment) => segment.weight > 0) as ReadonlyArray<BoardSummaryBarSegment>,
    tone: notDone > 0 ? "warning" : "none",
    tooltip: null,
    available: true,
  });
}

function costFigure(usage: BoardUsageBreakdown) {
  return formatBoardUsageCost(usage.summary, {
    steps: { estimated: usage.estimatedSteps, partial: usage.partialSteps },
  });
}

function costTile(usage: BoardUsageBreakdown | null): BoardSummaryTile {
  if (usage === null) return emptyTile("usage", "Cost", "No usage yet");
  const figure = costFigure(usage);
  const tokens = usage.totals.input + usage.totals.cached + usage.totals.output;
  const models = [...new Set(usage.models.map((model) => model.model))];
  return tile({
    section: "usage",
    label: "Cost",
    value: figure.text,
    suffix: usage.running ? "so far" : null,
    sub: [
      `${formatBoardTokens(tokens)} tokens`,
      ...(models.length > 0 ? [models.join(", ")] : []),
    ].join(" · "),
    bar: usage.stages.flatMap((stage, index): ReadonlyArray<BoardSummaryBarSegment> =>
      stage.summary.costKnown === true
        ? [
            {
              weight: Math.max(stage.summary.costUsd, 0.02),
              fill: { shade: index },
              tip: `${boardUsageStageLabel(stage)} ${formatBoardUsageCost(stage.summary).text}`,
            },
          ]
        : [],
    ),
    tone: "none",
    tooltip: figure.tooltip,
    available: true,
  });
}

function chipsOf(
  entries: ReadonlyArray<readonly [number, string, BoardSummaryChip["tone"]]>,
): ReadonlyArray<BoardSummaryChip> {
  return entries.flatMap(([count, label, tone]) => (count > 0 ? [{ label, tone }] : []));
}

const MAX_AREA_CHIPS = 4;

export function deriveBoardSummaryOverview(input: {
  readonly summary: BoardCardWorkSummary;
  readonly decisionLog: BoardDecisionLogView | null;
  readonly usage: BoardUsageBreakdown | null;
  /** The card is past the build-role stage. */
  readonly pastBuild: boolean;
  /** The card integrates its own work: false for an inherit group, which is never reviewed. */
  readonly integrates: boolean;
}): BoardSummaryOverview {
  const { summary, decisionLog, usage } = input;
  const { review, build } = summary;
  const structured = build.structured;
  const rawChecks = structured?.checks ?? [];
  const rawNotes = structured?.notes ?? [];
  const checks = stableSort(rawChecks, (check) => CHECK_ORDER[check.status]);
  const notes = stableSort(rawNotes, (note) => NOTE_ORDER[note.kind]);
  const showReview = input.integrates && (!review.empty || review.loop !== null);

  const tiles: BoardSummaryTile[] = [];
  if (checks.length > 0 || input.pastBuild) tiles.push(checksTile(checks));
  if (showReview) tiles.push(reviewTile(review));
  if (notes.length > 0 || input.pastBuild)
    tiles.push(notesTile(structured === null ? null : notes));
  tiles.push(costTile(usage));

  const sections: BoardSummarySection[] = [];
  if (notes.length > 0) {
    const { notDone, planChanges, shortcuts } = noteCounts(notes);
    sections.push({
      id: "notes",
      name: BOARD_SUMMARY_SECTION_NAMES.notes,
      count: plural(notes.length, "note"),
      chips: chipsOf([
        [notDone, `${notDone} not done`, "warning"],
        [planChanges, plural(planChanges, "plan change"), "attention"],
        [shortcuts, plural(shortcuts, "shortcut"), "neutral"],
      ]),
    });
  }
  if (checks.length > 0 || showReview || review.outstanding.length > 0) {
    const { passed, flagged, skipped } = checkCounts(checks);
    const count = [
      checks.length > 0 ? plural(checks.length, "check") : null,
      showReview ? `round ${review.empty ? 1 : review.currentRound}` : null,
    ].filter((part): part is string => part !== null);
    sections.push({
      id: "checks",
      name: BOARD_SUMMARY_SECTION_NAMES.checks,
      count: count.join(" · "),
      chips: chipsOf([
        [passed, `${passed} passed`, "success"],
        [flagged, `${flagged} flagged`, "warning"],
        [skipped, `${skipped} skipped`, "neutral"],
      ]),
    });
  }
  const children = build.children !== null && build.children.total > 0 ? build.children : null;
  if (children !== null || build.areaCount > 0) {
    const areas = (structured?.areas ?? []).filter((area) => area.items.length > 0);
    const count = [
      children === null ? null : `${children.done} of ${children.total} plans done`,
      build.areaCount > 0
        ? `${plural(build.changeCount, "change")} · ${plural(build.areaCount, "area")}`
        : null,
    ].filter((part): part is string => part !== null);
    sections.push({
      id: "built",
      name: BOARD_SUMMARY_SECTION_NAMES.built,
      count: count.join(" · "),
      chips: [
        ...areas
          .slice(0, MAX_AREA_CHIPS)
          .map((area) => ({ label: area.name, tone: "neutral" as const })),
        ...(areas.length > MAX_AREA_CHIPS
          ? [{ label: `+${areas.length - MAX_AREA_CHIPS}`, tone: "neutral" as const }]
          : []),
      ],
    });
  }
  if (decisionLog !== null) {
    const important = decisionLog.rows.filter((row) => row.flag === "important").length;
    const unclear = decisionLog.rows.filter((row) => row.flag === "unclear").length;
    sections.push({
      id: "decisions",
      name: BOARD_SUMMARY_SECTION_NAMES.decisions,
      count: decisionLog.count,
      chips: chipsOf([
        [important, `${important} important`, "info"],
        [unclear, `${unclear} unclear`, "attention"],
      ]),
    });
  }
  if (usage !== null) {
    sections.push({
      id: "usage",
      name: BOARD_SUMMARY_SECTION_NAMES.usage,
      count: plural(usage.stages.length, "stage"),
      chips: [{ label: costFigure(usage).text, tone: "neutral" }],
    });
  }

  return {
    tiles,
    notDone: notes.filter((note) => note.kind === "not_done").map((note) => note.text),
    sections,
    initiallyOpen: decisionLog?.defaultOpen === true ? ["decisions"] : [],
    notes,
    checks,
    showReview,
  };
}

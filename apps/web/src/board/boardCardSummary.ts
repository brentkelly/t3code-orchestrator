/**
 * T3o stage-specific card summary (t3o-06). The one thing that makes this
 * board different from every other Kanban board: what a card shows changes
 * with the stage it is in, because what matters about a piece of work changes
 * as it moves.
 *
 * This is a PURE function of `BoardCardShell` — the bounded summary that rides
 * the shell snapshot (D7). It NEVER opens `board.subscribeCard`; the column
 * view renders from the shell alone, and taking only a `BoardCardShell`
 * structurally guarantees it (a subscription needs an environment id and a
 * card id this function is never given). That guarantee is asserted in
 * `boardCardSummary.test.ts`.
 *
 * No-speculative-inventory (t3o-03): most stage fields have no data source
 * until a later spec populates them (sub-board plans, the review pipeline, PR
 * detection). This function emits a summary item ONLY when its field is
 * present, so a stage variant with nothing to show degrades to the base card,
 * NOT to a skeleton of empty slots. The `items` array is empty today for
 * every stage; the renderers exist so the card lights up the day the data
 * lands, with no further UI work.
 */
import type { BoardCardShell } from "@t3tools/contracts";

/** One piece of stage-specific summary content. Each variant carries exactly
    the scalars the shell provides — the renderer maps it to a chip/pip row. */
export type BoardCardSummaryItem =
  | { readonly kind: "attachments"; readonly count: number }
  | { readonly kind: "plans"; readonly done: number; readonly total: number }
  | { readonly kind: "round"; readonly current: number; readonly max: number }
  | { readonly kind: "step"; readonly label: string }
  | {
      readonly kind: "severity";
      readonly critical: number;
      readonly improvement: number;
      readonly nitpick: number;
    }
  | {
      readonly kind: "issues";
      readonly fixed: number;
      readonly rejected: number;
      readonly open: number;
      readonly disputed: number;
    };

export interface BoardCardSummary {
  /** Done cards render collapsed and muted — finished work recedes. */
  readonly muted: boolean;
  /** Stage-specific content, in render order. Empty means "nothing to add
      beyond the base card" — the correct, non-speculative resting state. */
  readonly items: ReadonlyArray<BoardCardSummaryItem>;
}

/** Present and non-zero — an absent optional key or a hardcoded `0`/`false`
    placeholder (t3o-04's not-yet-sourced shell fields) contributes nothing. */
function positive(value: number | undefined): value is number {
  return value !== undefined && value > 0;
}

export function boardCardSummary(card: BoardCardShell): BoardCardSummary {
  const items: Array<BoardCardSummaryItem> = [];
  switch (card.stage) {
    case "backlog":
    case "sprint":
    case "planning":
      // The base card (key, labels, title, thread/blocked/input flags handled
      // by the card itself) is the whole summary at these stages.
      break;

    case "ready":
      if (positive(card.attachmentCount)) {
        items.push({ kind: "attachments", count: card.attachmentCount });
      }
      break;

    case "building":
      // Plan progress pips when this card is a parent of a sub-board (D12);
      // absent until sub-boards materialise post-MVP. Queue position and
      // thread state are rendered by the card chrome, not the summary.
      if (card.planTotal !== undefined && card.planTotal > 0) {
        items.push({ kind: "plans", done: card.planDone ?? 0, total: card.planTotal });
      }
      break;

    case "review":
      // The PR reference is NOT here: it moved to the card's meta row, which
      // renders it at every stage rather than only where the pipeline happens
      // to be looking (`boardCardMeta`).
      if (card.roundMax !== undefined && card.roundMax > 0) {
        items.push({ kind: "round", current: card.roundCurrent ?? 0, max: card.roundMax });
      }
      if (card.stepLabel !== undefined) items.push({ kind: "step", label: card.stepLabel });
      if (
        card.severityCritical !== undefined ||
        card.severityImprovement !== undefined ||
        card.severityNitpick !== undefined
      ) {
        items.push({
          kind: "severity",
          critical: card.severityCritical ?? 0,
          improvement: card.severityImprovement ?? 0,
          nitpick: card.severityNitpick ?? 0,
        });
      }
      if (
        card.issuesFixed !== undefined ||
        card.issuesRejected !== undefined ||
        card.issuesOpen !== undefined ||
        card.issuesDisputed !== undefined
      ) {
        items.push({
          kind: "issues",
          fixed: card.issuesFixed ?? 0,
          rejected: card.issuesRejected ?? 0,
          open: card.issuesOpen ?? 0,
          disputed: card.issuesDisputed ?? 0,
        });
      }
      break;

    case "merge":
      // PR state and check summary. The PR number itself rides the meta row
      // (`boardCardMeta`); a check summary has no data source until t3o-11.
      break;

    case "done":
      break;
  }
  return { muted: card.stage === "done", items };
}

/**
 * The card's footer meta row: four counts, then the brief's image flag pushed
 * to the far end. Unlike `boardCardSummary` this is stage-INDEPENDENT — how
 * many things a card is tied to does not change with where it sits, and a
 * dependency that only shows up in some columns is a dependency you forget.
 *
 * `threadCount` is the one input that is not a shell field: the card's live
 * thread links ride the snapshot as their own array (t3o-18, D3), joined
 * client-side. Surfaces that do not carry them (the archive sheet, the drag
 * ghost) pass 0 and the bubble simply does not render.
 */
export interface BoardCardMeta {
  /** How many other cards this one waits on. */
  readonly dependencyCount: number;
  /** Agent threads attached to the card — its own, plus any running on the
      plans stacked under it once sub-boards materialise (D12). */
  readonly threadCount: number;
  /** Stacked plan cards, else the count of attached plan documents. */
  readonly planCount: number;
  /** The linked pull request, absent until PR detection lands (t3o-11). */
  readonly prNumber: number | undefined;
  /** Whether the brief carries a picture — the one right-aligned indicator. */
  readonly briefHasImage: boolean;
  /** Nothing to show, so the row adds no height to the card. */
  readonly empty: boolean;
}

export function boardCardMeta(card: BoardCardShell, threadCount: number): BoardCardMeta {
  // `planTotal` is the sub-board's count of stacked plan cards (D12) and
  // outranks `planCount`, the card's own attached plan documents (t3o-08) —
  // a parent card counts its children, not the plan it was built from.
  const planCount = card.planTotal ?? card.planCount ?? 0;
  const prNumber = positive(card.prNumber) ? card.prNumber : undefined;
  const briefHasImage = card.briefHasImage === true;
  return {
    dependencyCount: card.dependencyCount,
    threadCount,
    planCount,
    prNumber,
    briefHasImage,
    empty:
      card.dependencyCount === 0 &&
      threadCount === 0 &&
      planCount === 0 &&
      prNumber === undefined &&
      !briefHasImage,
  };
}

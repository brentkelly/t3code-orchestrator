/**
 * T3o card progress block (t3o-18, D8) — the ONE progress element a column card
 * may render, chosen by a fixed precedence.
 *
 * `boardCardSummary` is provably shell-only: its test asserts it renders its
 * documented variant from `BoardCardShell` fields ALONE, and that guarantee is
 * what structurally prevents the column view from ever reaching for
 * `subscribeCard`. Todos need thread-joined data (`boardCardThreads`, which rides
 * the shell snapshot as its own array), so they cannot live inside it and its
 * signature is not widened. This is its pure sibling instead.
 *
 * Precedence is **review > subcards > todos** (the prototype's rule, `hasPlans:
 * stacked && !review`). A split parent builds THROUGH its children, so while it
 * is building, how its children are doing IS its progress — but once it reaches
 * code review the children are finished and the loop reviewing the merged
 * branch is the only thing still moving. A parent that keeps wearing a full
 * green plan bar in the review column reads as work that is over.
 * The sub-board door is not lost with the bar: the card's detail sheet opens
 * the sub-board (`onOpenOwnSubBoard`).
 *
 * It is also the one place the "a second thread must add no height until
 * clicked" rule can be verified: the block is chosen from exactly ONE thread, and
 * the extra threads are a count.
 */
import type { BoardCardShell, BoardCardThreadShell, ThreadId } from "@t3tools/contracts";
import { boardThreadTodosComplete } from "@t3tools/contracts";

import type { BoardCardSummary, BoardCardSummaryItem } from "./boardCardSummary";

/** The thread-shell fields the winner rule reads. Structural, so any
    `OrchestrationThreadShell` satisfies it and this module needs no import from
    the orchestration contracts. */
export interface BoardTodoThreadState {
  readonly awaitingInput: boolean;
  readonly running: boolean;
  readonly stopped: boolean;
}

export type BoardCardProgressBlock =
  | { readonly kind: "none" }
  /** Sub-board plan progress (D12) — the parent card's children. */
  | { readonly kind: "subcards"; readonly items: ReadonlyArray<BoardCardSummaryItem> }
  /** The review ledger — rounds, severities, issue tallies. */
  | { readonly kind: "review"; readonly items: ReadonlyArray<BoardCardSummaryItem> }
  | {
      readonly kind: "todos";
      /** The winning thread's cached list. */
      readonly todo: BoardCardThreadShell;
      /** Live-linked threads BEYOND the winner. The chip renders this count and
          adds no height; only clicking it expands the rest. */
      readonly otherThreadCount: number;
    };

/** The review ledger's item kinds. No "pr": the PR reference moved to the
    stage-independent meta row, so it is not part of the block any more.
    Exported so the inline summary row can leave these out — they render as the
    review block instead, and rendering both would say everything twice. */
export const BOARD_CARD_REVIEW_ITEM_KINDS: ReadonlySet<BoardCardSummaryItem["kind"]> = new Set([
  "round",
  "step",
  "severity",
  "issues",
]);

/**
 * Which thread's list the card STRIP shows (D7). Independent of the card badge,
 * which aggregates across every thread: the badge answers "does this card need
 * me", a question about *any* thread; the strip answers "what is being worked
 * on", a question about *one*. They are allowed to disagree, and neither is
 * wrong when they do.
 *
 * Order: awaiting input → running → most recently updated → `activeThreadId` as
 * the final tiebreak. Runs client-side because only the client holds the live
 * thread shells the rule reads.
 */
export function pickBoardCardTodoThread(input: {
  readonly threads: ReadonlyArray<BoardCardThreadShell>;
  readonly stateOf: (threadId: ThreadId) => BoardTodoThreadState | undefined;
  readonly activeThreadId: ThreadId | null;
}): BoardCardThreadShell | null {
  const withTodos = input.threads.filter((entry) => (entry.todoTotal ?? 0) > 0);
  if (withTodos.length === 0) return null;
  if (withTodos.length === 1) return withTodos[0] ?? null;
  const rank = (entry: BoardCardThreadShell): number => {
    const state = input.stateOf(entry.threadId);
    if (state?.awaitingInput === true) return 0;
    if (state?.running === true) return 1;
    return 2;
  };
  return (
    [...withTodos].sort((left, right) => {
      const byRank = rank(left) - rank(right);
      if (byRank !== 0) return byRank;
      const byUpdated = (right.todoUpdatedAt ?? "").localeCompare(left.todoUpdatedAt ?? "");
      if (byUpdated !== 0) return byUpdated;
      if (input.activeThreadId !== null) {
        if (left.threadId === input.activeThreadId) return -1;
        if (right.threadId === input.activeThreadId) return 1;
      }
      return String(left.threadId).localeCompare(String(right.threadId));
    })[0] ?? null
  );
}

/**
 * The single progress block for a column card. Pure: everything it branches on
 * is passed in.
 *
 * The strip HIDES a finished list whose thread is also stopped (D5). Retention is
 * a storage rule and visibility is a render rule: the board keeps the last list
 * for a live-linked thread regardless of completion or thread state, which is
 * what lets a card show `5/5` at the moment the agent succeeds — while a stale
 * card falls back to its plain meta row instead of advertising `Migration spike
 * 3/3 idle 2h` forever. The expanded panel and the modal always show what is
 * stored.
 */
export function boardCardProgressBlock(
  summary: BoardCardSummary,
  todo: BoardCardThreadShell | null,
  options?: {
    readonly liveThreadCount?: number | undefined;
    readonly winnerStopped?: boolean | undefined;
  },
): BoardCardProgressBlock {
  const review = summary.items.filter((item) => BOARD_CARD_REVIEW_ITEM_KINDS.has(item.kind));
  if (review.length > 0) return { kind: "review", items: review };
  const subcards = summary.items.filter((item) => item.kind === "plans");
  if (subcards.length > 0) return { kind: "subcards", items: subcards };
  if (todo === null) return { kind: "none" };
  if (boardThreadTodosComplete(todo) && options?.winnerStopped === true) return { kind: "none" };
  return {
    kind: "todos",
    todo,
    otherThreadCount: Math.max(0, (options?.liveThreadCount ?? 1) - 1),
  };
}

/** Thread state for the winner rule, from the card shell's own aggregate flags —
    the fallback a caller uses when it holds no per-thread shells. */
export function boardCardShellThreadState(card: BoardCardShell): BoardTodoThreadState {
  return {
    awaitingInput: card.awaitingInput,
    running: card.threadState === "working",
    // A failed thread is stopped for the winner rule (t3o-10): it is not
    // running, and there is nothing more coming from it.
    stopped:
      card.threadState === "stopped" ||
      card.threadState === "failed" ||
      card.threadState === "none",
  };
}

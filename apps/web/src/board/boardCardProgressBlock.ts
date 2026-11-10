/**
 * The one progress block a column card renders. Precedence: review > subcards >
 * todos. Kept out of the shell-only `boardCardSummary` because todos need
 * thread-joined data.
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
 * Which thread's list the strip shows: awaiting input, then running, then most
 * recently updated, then `activeThreadId`. It may disagree with the card badge,
 * which aggregates every thread.
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
 * The single progress block for a column card. The strip hides a finished list
 * whose thread has stopped; the stored list is kept and the expanded panel and
 * modal still show it.
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

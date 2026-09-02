/**
 * T3o card progress block (t3o-18, D5/D7/D8).
 *
 * The precedence — review > subcards > todos — is the rule that decides what a
 * split parent shows once it reaches code review, and this is the one place the
 * "a second thread adds no height until clicked" rule can be verified.
 */
import type { BoardCardThreadShell, ThreadId } from "@t3tools/contracts";
import { BoardCardId, ThreadId as ThreadIdSchema } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardProgressBlock,
  pickBoardCardTodoThread,
  type BoardTodoThreadState,
} from "./boardCardProgressBlock";
import type { BoardCardSummary } from "./boardCardSummary";

const cardId = BoardCardId.make("card-1");
const thread = (id: string) => ThreadIdSchema.make(id);

const todo = (id: string, overrides: Partial<BoardCardThreadShell> = {}): BoardCardThreadShell => ({
  cardId,
  threadId: thread(id),
  todoStatuses: "dip",
  todoDone: 1,
  todoTotal: 3,
  ...overrides,
});

const summary = (items: BoardCardSummary["items"] = []): BoardCardSummary => ({
  muted: false,
  items,
});

const idle: BoardTodoThreadState = { awaitingInput: false, running: false, stopped: true };
const running: BoardTodoThreadState = { awaitingInput: false, running: true, stopped: false };
const waiting: BoardTodoThreadState = { awaitingInput: true, running: false, stopped: false };

describe("boardCardProgressBlock (D8)", () => {
  it("AC 11: returns exactly one block, review outranking subcards outranking todos", () => {
    // A split parent in code review: its children are finished, so the plan bar
    // would report progress on work nobody is waiting for. The review ledger
    // wins, and it wins carrying only the review items.
    const parentInReview = summary([
      { kind: "plans", done: 3, total: 3, statuses: "ddd" },
      { kind: "round", current: 1, max: 3, outcome: undefined },
      { kind: "issues", fixed: 0, rejected: 0, open: 3, disputed: 0 },
    ]);
    const parentBlock = boardCardProgressBlock(parentInReview, todo("t1"));
    expect(parentBlock.kind).toBe("review");
    if (parentBlock.kind !== "review") return;
    expect(parentBlock.items.map((item) => item.kind)).toEqual(["round", "issues"]);

    // The same parent before review: nothing from the review ledger yet, so its
    // children ARE its progress.
    const parentBuilding = summary([{ kind: "plans", done: 1, total: 3, statuses: "dip" }]);
    expect(boardCardProgressBlock(parentBuilding, todo("t1")).kind).toBe("subcards");

    const review = summary([
      { kind: "round", current: 1, max: 3, outcome: undefined },
      { kind: "severity", critical: 1, improvement: 0, nitpick: 2 },
    ]);
    expect(boardCardProgressBlock(review, todo("t1")).kind).toBe("review");

    // Attachments are not a progress block — a Ready card with a paperclip still
    // shows its todos.
    const todosOnly = summary([{ kind: "attachments", count: 2 }]);
    expect(boardCardProgressBlock(todosOnly, todo("t1")).kind).toBe("todos");

    expect(boardCardProgressBlock(summary(), null).kind).toBe("none");
  });

  it("AC 6: a finished list survives while its thread runs and hides once it stops", () => {
    const finished = todo("t1", { todoStatuses: "ddd", todoDone: 3, todoTotal: 3 });
    // 5/5 at the moment the agent succeeds — the card shows the win.
    expect(
      boardCardProgressBlock(summary(), finished, { liveThreadCount: 1, winnerStopped: false })
        .kind,
    ).toBe("todos");
    // Stopped as well: the card falls back to its plain meta row rather than
    // advertising a stale "3/3 idle 2h" forever.
    expect(
      boardCardProgressBlock(summary(), finished, { liveThreadCount: 1, winnerStopped: true }).kind,
    ).toBe("none");
    // An unfinished list on a stopped thread still shows — the work is real and
    // unfinished, which is exactly what a human needs to see.
    expect(
      boardCardProgressBlock(summary(), todo("t1"), { liveThreadCount: 1, winnerStopped: true })
        .kind,
    ).toBe("todos");
  });

  it("AC 13: a second thread is a count on the winner, never a second block", () => {
    const block = boardCardProgressBlock(summary(), todo("t1"), { liveThreadCount: 3 });
    expect(block.kind).toBe("todos");
    if (block.kind !== "todos") return;
    expect(block.otherThreadCount).toBe(2);
    // One block, one thread's list — the others cost no height until clicked.
    expect(block.todo.threadId).toBe(thread("t1"));
  });
});

describe("pickBoardCardTodoThread (D7)", () => {
  const stateOf = (states: Record<string, BoardTodoThreadState>) => (id: ThreadId) =>
    states[String(id)];

  it("prefers awaiting input, then running, then the most recently updated", () => {
    const threads = [
      todo("running", { todoUpdatedAt: "2026-01-01T03:00:00.000Z" }),
      todo("waiting", { todoUpdatedAt: "2026-01-01T01:00:00.000Z" }),
      todo("idle", { todoUpdatedAt: "2026-01-01T05:00:00.000Z" }),
    ];
    const states = { running, waiting, idle };
    expect(
      pickBoardCardTodoThread({ threads, stateOf: stateOf(states), activeThreadId: null })
        ?.threadId,
    ).toBe(thread("waiting"));

    // Without a waiting thread, running wins over a more recently updated idle
    // one: "what is being worked on" is a question about live work.
    expect(
      pickBoardCardTodoThread({
        threads: [threads[0]!, threads[2]!],
        stateOf: stateOf(states),
        activeThreadId: null,
      })?.threadId,
    ).toBe(thread("running"));
  });

  it("falls back to recency, then to activeThreadId, and ignores listless threads", () => {
    const threads = [
      todo("a", { todoUpdatedAt: "2026-01-01T01:00:00.000Z" }),
      todo("b", { todoUpdatedAt: "2026-01-01T02:00:00.000Z" }),
    ];
    const states = { a: idle, b: idle };
    expect(
      pickBoardCardTodoThread({ threads, stateOf: stateOf(states), activeThreadId: null })
        ?.threadId,
    ).toBe(thread("b"));

    // Equal recency → the card's active thread breaks the tie.
    const tied = [
      todo("a", { todoUpdatedAt: "2026-01-01T01:00:00.000Z" }),
      todo("b", { todoUpdatedAt: "2026-01-01T01:00:00.000Z" }),
    ];
    expect(
      pickBoardCardTodoThread({
        threads: tied,
        stateOf: stateOf(states),
        activeThreadId: thread("a"),
      })?.threadId,
    ).toBe(thread("a"));

    // A linked thread with no list is not a candidate (D14: the cache fills
    // forward, so this is the common state right after an upgrade).
    expect(
      pickBoardCardTodoThread({
        threads: [{ cardId, threadId: thread("bare") }],
        stateOf: stateOf({}),
        activeThreadId: null,
      }),
    ).toBeNull();
  });
});

/**
 * The settle grace's two inputs (T3O-29): when each card's thread went quiet,
 * and when the board next has to repaint because a grace expired.
 */
import { BOARD_ATTENTION_SETTLE_MS, BoardCardId, ThreadId, TurnId } from "@t3tools/contracts";
import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveBoardThreadIdleSince, nextBoardAttentionSettleAt } from "./boardAttentionSettle";

const cardOf = (id: string, threadId: string | null) => ({
  cardId: BoardCardId.make(id),
  activeThreadId: threadId === null ? null : ThreadId.make(threadId),
});

const threadOf = (completedAt: string | null): Pick<OrchestrationThreadShell, "latestTurn"> => ({
  latestTurn: {
    turnId: TurnId.make("turn-1"),
    state: "completed",
    requestedAt: "2026-09-09T11:59:00.000Z",
    startedAt: "2026-09-09T11:59:00.000Z",
    completedAt,
    assistantMessageId: null,
  },
});

describe("deriveBoardThreadIdleSince", () => {
  it("reads the active thread's last completed turn, and nothing else", () => {
    const idle = deriveBoardThreadIdleSince({
      cards: [cardOf("card-quiet", "thread-quiet"), cardOf("card-none", null)],
      threadOf: (threadId) =>
        threadId === "thread-quiet" ? threadOf("2026-09-09T12:00:00.000Z") : undefined,
    });
    expect(idle.get("card-quiet")).toBe("2026-09-09T12:00:00.000Z");
    // A card with no linked thread has no stop to wait out.
    expect(idle.has("card-none")).toBe(false);
  });

  it("omits a card whose thread has never finished a turn", () => {
    // Mid-turn, or a thread that has not started one: there is no evidence the
    // card just went quiet, so the chips are not held back at all. The working
    // dot is what covers a card that is mid-turn.
    const idle = deriveBoardThreadIdleSince({
      cards: [cardOf("card-running", "thread-running"), cardOf("card-fresh", "thread-fresh")],
      threadOf: (threadId) =>
        threadId === "thread-running" ? threadOf(null) : { latestTurn: null },
    });
    expect(idle.size).toBe(0);
  });

  it("omits a card whose thread shell the client does not hold", () => {
    const idle = deriveBoardThreadIdleSince({
      cards: [cardOf("card-1", "thread-gone")],
      threadOf: () => undefined,
    });
    expect(idle.size).toBe(0);
  });
});

describe("nextBoardAttentionSettleAt", () => {
  const at = (iso: string) => Date.parse(iso);
  const noon = at("2026-09-09T12:00:00.000Z");

  it("wakes for the soonest grace that is still outstanding", () => {
    const soonest = nextBoardAttentionSettleAt(
      ["2026-09-09T12:00:04.000Z", "2026-09-09T12:00:01.000Z", "2026-09-09T12:00:09.000Z"],
      noon,
    );
    expect(soonest).toBe(at("2026-09-09T12:00:01.000Z") + BOARD_ATTENTION_SETTLE_MS);
  });

  it("sets no timer when nothing is waiting", () => {
    expect(nextBoardAttentionSettleAt([], noon)).toBeNull();
    // Expired graces are not scheduled again — a board of long-quiet cards
    // paints once and then sets no timer at all.
    expect(nextBoardAttentionSettleAt(["2026-09-09T11:00:00.000Z"], noon)).toBeNull();
    // …nor is a timestamp nothing can parse.
    expect(nextBoardAttentionSettleAt(["whenever"], noon)).toBeNull();
  });

  it("terminates: each firing clears at least the deadline it woke for", () => {
    // The property that stops the tick becoming an interval. Feeding the
    // returned deadline back in as `now` must always make progress, and the
    // sequence must end.
    const idle = ["2026-09-09T12:00:01.000Z", "2026-09-09T12:00:04.000Z"];
    const woken: Array<number> = [];
    let now = noon;
    for (let guard = 0; guard < 10; guard++) {
      const next = nextBoardAttentionSettleAt(idle, now);
      if (next === null) break;
      expect(next).toBeGreaterThan(now);
      woken.push(next);
      now = next;
    }
    expect(woken).toEqual([
      at("2026-09-09T12:00:01.000Z") + BOARD_ATTENTION_SETTLE_MS,
      at("2026-09-09T12:00:04.000Z") + BOARD_ATTENTION_SETTLE_MS,
    ]);
  });
});

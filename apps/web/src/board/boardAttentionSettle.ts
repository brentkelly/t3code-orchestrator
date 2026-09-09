/**
 * The settle grace behind the board's two "Needs a human" chips (T3O-29).
 *
 * A card that has just stopped being worked is not yet a card that needs a
 * human: the turn ends, the step row parks, and the supervisor decides whether
 * to resume — three facts that arrive over a handful of round trips and do not
 * arrive together. `boardCardAttention` withholds both chips for
 * `BOARD_ATTENTION_SETTLE_MS` after the card's thread went quiet; this module
 * supplies the two things it needs to do that and the board page cannot make up:
 * WHEN the thread went quiet, and a clock that ticks once when the grace runs
 * out.
 *
 * The timestamp is joined from the thread shells the board already holds, so it
 * costs no payload and — unlike a client-side "I saw it stop" flag — survives a
 * reload: a card whose agent finished an hour ago flags the instant the board
 * paints, and only a genuinely fresh stop waits.
 */
import { BOARD_ATTENTION_SETTLE_MS } from "@t3tools/contracts";
import type { BoardCardShell, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

/**
 * When each card's active thread last finished a turn, keyed by card id, for
 * the cards that have such a thread. Cards with no linked thread, or whose
 * thread has never completed a turn, are absent — there is no evidence of a
 * fresh stop, so there is nothing to wait out.
 *
 * The ACTIVE thread specifically: it is the one the shell's own `threadState`
 * and `awaitingInput` are derived from, so the grace and the dot it defers to
 * are talking about the same thread.
 */
export function deriveBoardThreadIdleSince(input: {
  readonly cards: ReadonlyArray<Pick<BoardCardShell, "cardId" | "activeThreadId">>;
  readonly threadOf: (
    threadId: ThreadId,
  ) => Pick<OrchestrationThreadShell, "latestTurn"> | undefined;
}): ReadonlyMap<string, string> {
  const idleSince = new Map<string, string>();
  for (const card of input.cards) {
    if (card.activeThreadId === null) continue;
    const completedAt = input.threadOf(card.activeThreadId)?.latestTurn?.completedAt;
    if (completedAt != null) idleSince.set(String(card.cardId), completedAt);
  }
  return idleSince;
}

/**
 * The next moment a grace expires, or null when none is outstanding — the one
 * timer the board sets, rather than a repeating clock. Graces that have already
 * expired at `now` are not scheduled again, which is what makes the tick
 * terminate: each firing advances `now` past at least the deadline it woke for.
 */
export function nextBoardAttentionSettleAt(
  idleSince: Iterable<string>,
  now: number,
): number | null {
  let soonest: number | null = null;
  for (const iso of idleSince) {
    const expiry = Date.parse(iso) + BOARD_ATTENTION_SETTLE_MS;
    if (!Number.isFinite(expiry) || expiry <= now) continue;
    if (soonest === null || expiry < soonest) soonest = expiry;
  }
  return soonest;
}

/**
 * The board page's half: the per-card idle timestamps to hand
 * `boardCardAttention`, and the `now` to measure them against.
 *
 * `now` advances ONLY when an outstanding grace runs out, never on an interval
 * — a board of quiet cards sets no timer at all, and a board of busy ones sets
 * one per stop. Cards re-render on that tick, which is the point: nothing else
 * on the wire changes when a grace expires, so without it the chip would wait
 * for the next unrelated delta to appear.
 */
export function useBoardAttentionSettle(input: {
  readonly cards: ReadonlyArray<Pick<BoardCardShell, "cardId" | "activeThreadId">>;
  readonly threadOf: (
    threadId: ThreadId,
  ) => Pick<OrchestrationThreadShell, "latestTurn"> | undefined;
}): {
  readonly threadIdleSinceByCard: ReadonlyMap<string, string>;
  readonly now: number;
} {
  const { cards, threadOf } = input;
  const threadIdleSinceByCard = useMemo(
    () => deriveBoardThreadIdleSince({ cards, threadOf }),
    [cards, threadOf],
  );
  const [now, setNow] = useState(() => Date.now());
  // The DEADLINE, not the map, is what the timer depends on. `cards` is a fresh
  // array on every board delta, so the map behind it is a new identity many
  // times a second on a busy board; the deadline it implies is a number, and an
  // unchanged one leaves the pending timer alone instead of tearing it down and
  // setting an identical replacement.
  const settleAt = useMemo(
    () => nextBoardAttentionSettleAt(threadIdleSinceByCard.values(), now),
    [threadIdleSinceByCard, now],
  );
  useEffect(() => {
    if (settleAt === null) return;
    // `+ 1` so the timer cannot land a millisecond short of the deadline and
    // re-arm itself for the same one.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, settleAt - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [settleAt]);
  return { threadIdleSinceByCard, now };
}

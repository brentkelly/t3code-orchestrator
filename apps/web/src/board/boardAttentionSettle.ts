/**
 * The settle grace behind the "Needs a human" chips: when each card's thread went
 * quiet, and a clock that ticks when a grace expires. Joined from thread shells,
 * so it survives a reload and only a genuinely fresh stop waits.
 */
import { BOARD_ATTENTION_SETTLE_MS } from "@t3tools/contracts";
import type { BoardCardShell, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";

/**
 * When each card's active thread last finished a turn. The active thread is the
 * one the shell's `threadState` comes from. Cards with no completed turn are
 * absent: nothing to wait out.
 */
export function deriveBoardThreadIdleSince(input: {
  readonly cards: ReadonlyArray<Pick<BoardCardShell, "cardId" | "activeThreadId">>;
  readonly threadOf: (
    threadId: ThreadId,
  ) => Pick<OrchestrationV2ThreadShell, "latestRunCompletedAt"> | undefined;
}): ReadonlyMap<string, string> {
  const idleSince = new Map<string, string>();
  for (const card of input.cards) {
    if (card.activeThreadId === null) continue;
    const completedAt = input.threadOf(card.activeThreadId)?.latestRunCompletedAt;
    if (completedAt != null) idleSince.set(String(card.cardId), DateTime.formatIso(completedAt));
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
 * The per-card idle timestamps and the `now` to measure them against. `now`
 * advances only when a grace expires, never on an interval, because nothing on
 * the wire changes at that moment.
 */
export function useBoardAttentionSettle(input: {
  readonly cards: ReadonlyArray<Pick<BoardCardShell, "cardId" | "activeThreadId">>;
  readonly threadOf: (
    threadId: ThreadId,
  ) => Pick<OrchestrationV2ThreadShell, "latestRunCompletedAt"> | undefined;
}): {
  readonly threadIdleSinceByCard: ReadonlyMap<string, string>;
  readonly now: number;
} {
  const { cards, threadOf } = input;
  const threadIdleSinceByCard = deriveBoardThreadIdleSince({ cards, threadOf });
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- one timer that ticks `now` when the next settle grace expires.
  useEffect(() => {
    const next = nextBoardAttentionSettleAt(threadIdleSinceByCard.values(), now);
    if (next === null) return;
    // `+ 1` so the timer cannot land a millisecond short of the deadline and
    // re-arm itself for the same one.
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [threadIdleSinceByCard, now]);
  return { threadIdleSinceByCard, now };
}

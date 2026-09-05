/**
 * T3o queued-for-build copy (t3o-33). One place that turns a card's place in
 * the build queue into the words every surface shows — the board card's
 * tooltip, the modal header pill, the right-rail banner and the thread-pane
 * strip — so the four can never tell the user four different stories.
 *
 * Pure: the queue itself is derived in `boardBuildQueue` (client-runtime), the
 * running count in `boardRunningStepCount`, and the cap is a setting. Nothing
 * here reads state.
 */
import type { BoardQueueSlot } from "@t3tools/client-runtime/state/shell";

export interface BoardQueueInfo {
  readonly position: number;
  readonly total: number;
  readonly ahead: number;
  readonly running: number;
  readonly cap: number;
  readonly startsNext: boolean;
  /** The pill: `Next` at the front of the queue, `Queued #3` behind it. */
  readonly label: string;
  /** The banner's bold line. */
  readonly headline: string;
  /** Why it is waiting, and that nobody has to do anything about it. */
  readonly detail: string;
}

/**
 * How busy the agents are, said honestly at every count.
 *
 * A force-start deliberately runs OVER the cap (t3o-33), so `4 of 3 agents
 * busy` is reachable and reads as a bug. Past the ceiling the sentence stops
 * being a fraction and reports the limit instead.
 */
function describeAgents(running: number, cap: number): string {
  return running > cap
    ? `${running} agents running (limit ${cap})`
    : `${running} of ${cap} agents busy`;
}

/**
 * The full queued story for one card, or null when it is not queued.
 *
 * The copy never names a project. The queue is board-wide, so the work ahead
 * is frequently on someone else's board, and "1 task ahead" that implies this
 * board would send the user looking for a card that is not there.
 */
export function boardQueueInfo(input: {
  readonly slot: BoardQueueSlot | undefined;
  readonly running: number;
  readonly cap: number;
}): BoardQueueInfo | null {
  const { slot } = input;
  if (slot === undefined) return null;
  const ahead = slot.ahead === 0 ? "" : ` · ${slot.ahead} task${slot.ahead === 1 ? "" : "s"} ahead`;
  return {
    position: slot.position,
    total: slot.total,
    ahead: slot.ahead,
    running: input.running,
    cap: input.cap,
    startsNext: slot.startsNext,
    label: slot.startsNext ? "Next" : `Queued #${slot.position}`,
    headline: slot.startsNext
      ? "Queued for build — starts next"
      : `Queued #${slot.position} for build`,
    detail: `${describeAgents(input.running, input.cap)}${ahead}. It starts on its own when an agent frees up.`,
  };
}

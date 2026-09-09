/**
 * T3o queued-for-a-slot copy (t3o-33). One place that turns a card's place in
 * the agent queue into the words every surface shows — the board card's
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
 * The count is CARDS THE EXECUTOR IS RUNNING, which is not quite the same as
 * slots held: a step parked on a question (`awaiting-input`) or finishing up
 * (`completing`) keeps its slot but is not "running", and neither status
 * reaches the client — the card shell carries no field for them. A per-instance
 * cap can hold a step back too, with the global count nowhere near its ceiling.
 *
 * So the fraction is only stated when it cannot be wrong. Below the cap the
 * numbers would imply spare capacity the card demonstrably could not get — it
 * is queued, which means the governor refused it — so the sentence says the one
 * thing that is true at every count instead of inventing a number.
 *
 * Above the cap is reachable on purpose: a force start runs over the limit
 * (t3o-33), and `4 of 3 agents busy` reads as a bug, so past the ceiling the
 * sentence stops being a fraction and reports the limit.
 */
function describeAgents(running: number, cap: number): string {
  if (running > cap) return `${running} agents running (limit ${cap})`;
  if (running < cap) return "No agent is free for this task";
  return `${running} of ${cap} agents busy`;
}

/**
 * The full queued story for one card, or null when it is not queued.
 *
 * The copy never names a STAGE either (T3O-32). One board-wide queue holds
 * every stage's step, so a card waiting for a review or planning slot read
 * `Queued for build` and named work it was not about to do. `Queued #3` is the
 * one phrasing that is true wherever the card is sitting.
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
    headline: slot.startsNext ? "Queued — starts next" : `Queued #${slot.position}`,
    detail: `${describeAgents(input.running, input.cap)}${ahead}. It starts on its own when an agent frees up.`,
  };
}

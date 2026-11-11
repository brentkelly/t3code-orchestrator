/**
 * Queued-for-a-slot copy, the one place every surface (card tooltip, modal
 * pill, banner, thread strip) reads it from. Pure: reads no state.
 */
import type { BoardQueueSlot } from "@t3tools/client-runtime/state/shell";

import type { BoardQueueReason } from "./workers/cardWorker";

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
  /** Waiting for its worker's checkout: no limit to start past. */
  readonly waitingForCheckout?: boolean;
}

/**
 * How busy the agents are. The client sees only running steps, not ones parked
 * on a question or completing, so below the cap no fraction is stated. Above
 * it (a force start) the sentence reports the limit, not `4 of 3`.
 */
function describeAgents(running: number, cap: number): string {
  if (running > cap) return `${running} agents running (limit ${cap})`;
  if (running < cap) return "No agent is free for this task";
  return `${running} of ${cap} agents busy`;
}

/**
 * The queued story for one card, or null. It names neither a stage nor a
 * project: the queue is board-wide and holds every stage's steps.
 */
export function boardQueueInfo(input: {
  readonly slot: BoardQueueSlot | undefined;
  readonly running: number;
  readonly cap: number;
  /** Which limit holds the card, on a board with workers; absent or
      null keeps the one-worker copy. */
  readonly reason?: BoardQueueReason | null | undefined;
}): BoardQueueInfo | null {
  const { slot } = input;
  if (slot === undefined) return null;
  const ahead = slot.ahead === 0 ? "" : ` · ${slot.ahead} task${slot.ahead === 1 ? "" : "s"} ahead`;
  if (input.reason != null) return withQueueReason(slot, input, input.reason);
  return {
    position: slot.position,
    total: slot.total,
    ahead: slot.ahead,
    running: input.running,
    cap: input.cap,
    startsNext: slot.startsNext,
    label: slot.startsNext ? "Next" : `Queued #${slot.position}`,
    headline: slot.startsNext ? "Queued: starts next" : `Queued #${slot.position}`,
    detail: `${describeAgents(input.running, input.cap)}${ahead}. It starts on its own when an agent frees up.`,
  };
}

/**
 * The queued story on a board with workers: names the limit it waits on. A card
 * waiting on its worker's checkout has no queue position yet.
 */
function withQueueReason(
  slot: BoardQueueSlot,
  input: { readonly running: number; readonly cap: number },
  reason: BoardQueueReason,
): BoardQueueInfo {
  const base = {
    position: slot.position,
    total: slot.total,
    ahead: slot.ahead,
    running: input.running,
    cap: input.cap,
    startsNext: slot.startsNext,
  };
  const n = slot.position;
  switch (reason.kind) {
    case "worker":
      return {
        ...base,
        label: `Queued #${n} · worker full`,
        headline: `Queued #${n} on ${reason.worker}`,
        detail: `${reason.worker} is running ${reason.running} of ${reason.limit} agents. This card starts when one finishes.`,
      };
    case "provider":
      return {
        ...base,
        label: `Queued #${n} · provider full`,
        headline: `Queued #${n} on ${reason.worker}`,
        detail: `The provider this step uses is at its cap on ${reason.worker}. This card starts when one of those finishes.`,
      };
    case "board":
      return {
        ...base,
        label: `Queued #${n} · board full`,
        headline: `Queued #${n} for the board`,
        detail: `${reason.running} of ${reason.limit} agents are busy across all workers. This card starts when any of them finishes.`,
      };
    case "setup":
      return {
        ...base,
        waitingForCheckout: true,
        label: "Queued · setting up",
        headline: "Waiting for a checkout",
        detail: reason.failed
          ? `Cloning ${reason.project} on ${reason.worker} failed. Retry it in Settings → Board → Project checkouts, or pick another worker.`
          : reason.cloning
            ? `${reason.project} is being cloned on ${reason.worker}. This card starts once it's ready.`
            : `${reason.worker} has no checkout of ${reason.project} yet. This card starts once it has one.`,
      };
  }
}

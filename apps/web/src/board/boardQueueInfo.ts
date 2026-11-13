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
 * The queued story for one card, or null. It names neither a stage nor a
 * project: the queue is board-wide and holds every stage's steps.
 */
export function boardQueueInfo(input: {
  readonly slot: BoardQueueSlot | undefined;
  readonly running: number;
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
    startsNext: slot.startsNext,
    label: slot.startsNext ? "Next" : `Queued #${slot.position}`,
    headline: slot.startsNext ? "Queued: starts next" : `Queued #${slot.position}`,
    detail: `${input.running} agent${input.running === 1 ? "" : "s"} running${ahead}. It starts on its own when there is room.`,
  };
}

const DIMENSION_NAMES = { cpu: "CPU", ram: "RAM", disk: "disk space" } as const;

/** The hint a capacity wait carries: the worker decides what it offers. */
export const boardCapacityHint = (worker: string) =>
  `${worker} decides what it offers. Run \`pnpm t3o-worker status\` there to see what holds the rest.`;

/** The queued story when the card's worker holds it, naming why (T3O-86). */
function withQueueReason(
  slot: BoardQueueSlot,
  input: { readonly running: number },
  reason: BoardQueueReason,
): BoardQueueInfo {
  const base = {
    position: slot.position,
    total: slot.total,
    ahead: slot.ahead,
    running: input.running,
    startsNext: slot.startsNext,
  };
  const n = slot.position;
  switch (reason.kind) {
    case "capacity":
      return {
        ...base,
        label:
          reason.behind === null
            ? `Queued #${n} · waiting for room`
            : `Queued #${n} · behind ${reason.behind}`,
        headline:
          reason.behind === null
            ? `Waiting for room on ${reason.worker}`
            : `Waiting behind ${reason.behind} on ${reason.worker}`,
        detail: `${
          reason.dimension === null
            ? `${reason.worker} has no room for this card right now.`
            : `${reason.worker} has too little ${DIMENSION_NAMES[reason.dimension]} free for this card right now.`
        } ${boardCapacityHint(reason.worker)}`,
      };
    case "quota":
      return {
        ...base,
        label: `Queued #${n} · provider near quota`,
        headline: `Provider near quota on ${reason.worker}`,
        detail: `The provider this step uses is near its usage limit on ${reason.worker}. This card starts when the limit resets.`,
      };
    case "agent-cap":
      return {
        ...base,
        label: `Queued #${n} · agents busy`,
        headline: `Waiting for an agent on ${reason.worker}`,
        detail: `${reason.worker} runs as many agents at once as it allows. This card starts when one finishes.`,
      };
    case "needs-update":
      return {
        ...base,
        label: `Queued #${n} · needs update`,
        headline: `${reason.worker} needs updating`,
        detail: `${reason.worker} runs an older T3o than this board needs. Run \`pnpm t3o-update\` there.`,
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
            : `${reason.worker} isn't ready for ${reason.project} yet. This card starts once it is.`,
      };
  }
}

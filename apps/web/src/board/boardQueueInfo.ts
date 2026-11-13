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
  /** The pill: `Next up` at the front of the queue, `Queued #3` behind it, `After others`
      for a Low card behind a higher-priority one. */
  readonly label: string;
  /** The banner's bold line. */
  readonly headline: string;
  /** Why it is waiting, and that nobody has to do anything about it. */
  readonly detail: string;
  /** Waiting for its worker's checkout: no limit to start past. */
  readonly waitingForCheckout?: boolean;
  /** Held for good until a human acts (Too big): amber, not a wait. */
  readonly blocked?: boolean;
  /** Waiting on a human to sign in somewhere: violet (`--attention`). */
  readonly attention?: boolean;
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
  const runningAgents = `${input.running} agent${input.running === 1 ? "" : "s"} running`;
  return {
    position: slot.position,
    total: slot.total,
    ahead: slot.ahead,
    running: input.running,
    startsNext: slot.startsNext,
    ...(slot.afterHigherPriority === true
      ? {
          label: "After others",
          headline: `Queued #${slot.position} · low priority`,
          detail: `${runningAgents}${ahead}. It starts on its own when there is room and no higher-priority card is waiting.`,
        }
      : {
          label: slot.startsNext ? "Next up" : `Queued #${slot.position}`,
          headline: slot.startsNext ? "Queued: starts next" : `Queued #${slot.position}`,
          detail: `${runningAgents}${ahead}. It starts on its own when there is room.`,
        }),
  };
}

const DIMENSION_NAMES = { cpu: "CPU", ram: "RAM", disk: "disk space" } as const;

/** How to sign a provider in on the board server. */
export const boardProviderLoginHint = (provider: string) =>
  /claude/i.test(provider)
    ? "Run `claude login` there."
    : /codex/i.test(provider)
      ? "Run `codex login` there."
      : `Sign in to ${provider} there.`;

/** The hint a capacity wait carries: the worker decides what it offers. */
const boardCapacityHint = (worker: string) =>
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
      if (reason.tooBig && reason.anyWorker) {
        return {
          ...base,
          blocked: true,
          label: "Too big for any worker",
          headline: "Too big for any worker",
          detail: `This card needs more ${
            reason.dimension === null ? "room" : DIMENSION_NAMES[reason.dimension]
          } than any worker ready for it declares. Lower its size or the project's baseline, or raise a worker's capacity.`,
        };
      }
      if (reason.tooBig) {
        return {
          ...base,
          blocked: true,
          label: `Too big for ${reason.worker}`,
          headline: `Too big for ${reason.worker}`,
          detail: `This card needs more ${
            reason.dimension === null ? "room" : DIMENSION_NAMES[reason.dimension]
          } than ${reason.worker} declares, so it won't start there. Lower its size or the project's baseline, raise the worker's capacity, or pin another worker.`,
        };
      }
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
    case "no-ready-worker":
      return {
        ...base,
        blocked: true,
        label: "No ready worker",
        headline: "No ready worker for this project",
        detail: `No worker is online and ready for ${reason.project} with this step's provider signed in. Set ${reason.project} up on a worker from the Workers page, or fix a worker's readiness.`,
      };
    case "server-checkout":
      return {
        ...base,
        blocked: true,
        label: "No checkout on the board server",
        headline: `${reason.project}'s folder on the board server isn't a checkout`,
        detail: reason.missing
          ? `Planning runs on the board server. Clone ${reason.project} there with Clone here on the Workers page.`
          : `Planning runs on the board server, and ${reason.project}'s folder there exists but isn't a checkout of its repository. Fix the folder on the board server.`,
      };
    case "server-sign-in":
      return {
        ...base,
        attention: true,
        label: "Sign in on the board server",
        headline: `Sign in to ${reason.provider} on the board server`,
        detail: `Planning runs on the board server. ${boardProviderLoginHint(reason.provider)}`,
      };
    case "holding":
      return {
        ...base,
        label: `Next on ${reason.worker}`,
        headline: `Next on ${reason.worker}`,
        detail: `This card holds ${reason.worker}: no new card starts there before it, and it starts as soon as enough is free. ${boardCapacityHint(reason.worker)}`,
      };
    case "reserved":
      return reason.behind === null
        ? {
            ...base,
            label: `Queued #${n} · ${reason.worker} not taking cards`,
            headline: `${reason.worker} isn't taking new cards`,
            detail: `${reason.worker} isn't taking new cards right now. This card starts on it, or another worker, when one has room. ${boardCapacityHint(reason.worker)}`,
          }
        : {
            ...base,
            label: `Queued #${n} · ${reason.worker} reserved`,
            headline: `${reason.worker} is reserved for ${reason.behind}`,
            detail: `${reason.worker} is held for ${reason.behind}, earlier in this board's queue. This card starts on another worker when one has room, or after ${reason.behind}.`,
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
      if (reason.cause === "card-setup") {
        return {
          ...base,
          label: "Queued · setup running",
          headline: "Waiting for this card's setup",
          detail: `The project's setup script holds the agent until it finishes in this card's worktree on ${reason.worker}.`,
        };
      }
      if (reason.cause === "not-ready" && !reason.cloning) {
        return {
          ...base,
          blocked: true,
          label: `Not ready on ${reason.worker}`,
          headline: `${reason.worker} isn't ready for ${reason.project}`,
          detail: `${reason.worker}'s readiness check for ${reason.project} fails. Fix it there, then Re-check it on the Workers page, or pick another worker.`,
        };
      }
      if (reason.cause === "not-set-up" && !reason.cloning && !reason.failed) {
        return {
          ...base,
          blocked: true,
          label: `No checkout on ${reason.worker}`,
          headline: `${reason.worker} has no checkout of ${reason.project}`,
          detail: `Set ${reason.project} up on ${reason.worker} from the Workers page, or pick another worker.`,
        };
      }
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

/**
 * T3o card thread `+` menu — pure derivations (t3o-14).
 *
 * The menu's restart affordance is gated by two facts about the card's current
 * stage: whether it auto-executes (the item exists at all) and whether a
 * supervised run is in flight (the item is disabled). Both are computed here as
 * pure functions so the D1 safety gate — "never offer a restart that would put
 * two threads on the same step" — is assertable without mounting the connected
 * component.
 */
import type { BoardCardShell } from "@t3tools/contracts";

import type { BoardThreadStageRestart } from "./BoardCardThreadAddMenu";

/** The reason the restart item is disabled while a run is in flight — surfaced
    in the menu and pinned by the tests. */
export const BOARD_STAGE_RESTART_IN_FLIGHT_REASON =
  "A run is already in flight for this card — drag it out and back to restart.";

/**
 * Whether a supervised run is in flight for the card (t3o-14 D1). The step-state
 * read model is server-only, so the client reads the card shell's derived live
 * status as its proxy: an actively working thread, one awaiting the human
 * (`waiting`), or a build holding in the governor queue all count. An idle live
 * linked thread (`stopped` / `none`) does NOT — restarting onto it is the whole
 * point of the explicit escape hatch (D2), so it must stay enabled.
 */
export function isBoardCardRunInFlight(
  shell: Pick<BoardCardShell, "threadState" | "queued"> | undefined,
): boolean {
  if (shell === undefined) return false;
  return shell.threadState === "working" || shell.threadState === "waiting" || shell.queued;
}

/**
 * The `+` menu's restart affordance (t3o-14 D1/D4): `null` when the current
 * stage does not auto-execute (the item is absent, not disabled); otherwise the
 * stage label plus a disabled reason that is non-null exactly while a supervised
 * run is in flight.
 */
export function resolveBoardThreadStageRestart(input: {
  readonly autoExecute: boolean;
  readonly stageLabel: string;
  readonly runInFlight: boolean;
}): BoardThreadStageRestart | null {
  if (!input.autoExecute) return null;
  return {
    label: input.stageLabel,
    disabledReason: input.runInFlight ? BOARD_STAGE_RESTART_IN_FLIGHT_REASON : null,
  };
}

/**
 * The settled outcome of one command dispatch, flattened for the pure
 * orchestrator: `"ok"` succeeded, `"failed"` settled as a definite failure, and
 * `"interrupted"` was cancelled before settling (unmount, or a newer command
 * preempting it) so its SERVER outcome is unknown — the write may or may not
 * have landed.
 */
export type BlankThreadStep = "ok" | "failed" | "interrupted";

export interface BlankThreadCreation {
  readonly createThread: () => Promise<BlankThreadStep>;
  readonly linkThread: () => Promise<BlankThreadStep>;
  /** Best-effort rollback of the created-but-unlinked thread. */
  readonly rollbackThread: () => Promise<BlankThreadStep>;
  readonly warn: (message: string) => void;
}

/** Log messages, exported so the tests assert them without restating literals. */
export const BLANK_THREAD_WARN = {
  create: "Could not create a blank thread for the card.",
  link: "Could not link the new thread to the card.",
  rollback: "Could not roll back the unlinked thread.",
} as const;

/**
 * Orchestrate "new blank thread" (t3o-14 D3): create a server thread, then link
 * it to the card. Returns `true` when the thread is created AND linked, so the
 * caller can open it; `false` on any other outcome.
 *
 * Rollback policy is the load-bearing decision here. On a DEFINITE link failure
 * the thread demonstrably never joined the card, so it is deleted — nothing
 * orphans. On an INTERRUPTED link the server outcome is UNKNOWN: the link may
 * have landed, and deleting a validly-linked thread (destroying the card's
 * thread) is strictly worse than the alternative, which is at most a harmless
 * empty, unlinked thread the user can delete. So an interrupted link is NOT
 * rolled back. An interrupted create/link also skips the (expected) log.
 */
export async function runBlankThreadCreation(handlers: BlankThreadCreation): Promise<boolean> {
  const created = await handlers.createThread();
  if (created !== "ok") {
    if (created === "failed") handlers.warn(BLANK_THREAD_WARN.create);
    return false;
  }
  const linked = await handlers.linkThread();
  if (linked === "ok") return true;
  if (linked === "failed") {
    handlers.warn(BLANK_THREAD_WARN.link);
    const rolledBack = await handlers.rollbackThread();
    if (rolledBack === "failed") handlers.warn(BLANK_THREAD_WARN.rollback);
  }
  // linked === "interrupted": outcome unknown — deliberately no rollback.
  return false;
}

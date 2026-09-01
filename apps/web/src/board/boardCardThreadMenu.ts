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
 * A stage label as it reads MID-SENTENCE ("New thread — restart planning").
 * Stage labels are user-editable, so this cannot simply lowercase: `QA`,
 * `PR Review` and `UAT` are names, not sentence-case words, and lowercasing
 * them mangles them. Only a label that starts uppercase-then-lowercase — an
 * ordinary capitalised word — is de-capitalised, and only its first character,
 * so "Code review" reads "code review" while "QA" stays "QA". `toLowerCase`
 * (not `toLocaleLowerCase`) keeps the result independent of the host locale.
 */
export function boardStageLabelMidSentence(label: string): string {
  return /^\p{Lu}\p{Ll}/u.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/**
 * The `+` menu's restart affordance (t3o-14 D1/D4): `null` when there is nothing
 * to restart (the item is absent, not disabled); otherwise the stage label plus
 * a disabled reason that is non-null exactly while a supervised run is in
 * flight.
 *
 * Offered on a stage that auto-executes, and — t3o-30, D3 — on ANY stage whose
 * step has stalled. A stage that runs nothing on entry still spawns steps
 * (the merge role's conflict fix is one), and when one of those dies the stage
 * had no restart item at all: the card said a thread was running, the button
 * that would have cleared it was absent because the stage does not auto-execute,
 * and archiving the card was the only way out. A stalled step is by definition
 * something a human has to restart, whatever the stage does on entry.
 */
export function resolveBoardThreadStageRestart(input: {
  readonly autoExecute: boolean;
  readonly stageLabel: string;
  readonly runInFlight: boolean;
  /** Whether the card's live step has given up (t3o-17, D3). */
  readonly stalled: boolean;
}): BoardThreadStageRestart | null {
  if (!input.autoExecute && !input.stalled) return null;
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

/** One dispatch's flattened outcome: its control-flow `step` plus the raw
    command result as an opaque `detail`, so a definite failure can carry its
    error payload to the log (the sole diagnostic — these commands run with
    `reportFailure: false`) without the pure orchestrator inspecting it. */
export interface BlankThreadDispatch {
  readonly step: BlankThreadStep;
  readonly detail: unknown;
}

export interface BlankThreadCreation {
  readonly createThread: () => Promise<BlankThreadDispatch>;
  readonly linkThread: () => Promise<BlankThreadDispatch>;
  /** Best-effort rollback of the created-but-unlinked thread. */
  readonly rollbackThread: () => Promise<BlankThreadDispatch>;
  readonly warn: (message: string, detail: unknown) => void;
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
  if (created.step !== "ok") {
    if (created.step === "failed") handlers.warn(BLANK_THREAD_WARN.create, created.detail);
    return false;
  }
  const linked = await handlers.linkThread();
  if (linked.step === "ok") return true;
  if (linked.step === "failed") {
    handlers.warn(BLANK_THREAD_WARN.link, linked.detail);
    const rolledBack = await handlers.rollbackThread();
    if (rolledBack.step === "failed") handlers.warn(BLANK_THREAD_WARN.rollback, rolledBack.detail);
  }
  // linked.step === "interrupted": outcome unknown — deliberately no rollback.
  return false;
}

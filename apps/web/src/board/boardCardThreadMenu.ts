/**
 * Pure derivations for the card thread `+` menu, so the safety gate (never
 * offer a restart that would put two threads on one step) is testable without
 * mounting the component.
 */
import type { BoardCardShell } from "@t3tools/contracts";

import type { BoardThreadStageRestart } from "./BoardCardThreadAddMenu";

/** The reason the restart item is disabled while a run is in flight — surfaced
    in the menu and pinned by the tests. */
export const BOARD_STAGE_RESTART_IN_FLIGHT_REASON =
  "A run is already in flight for this card. Drag it out and back to restart.";

/** Disable restart when the dependency gate would refuse `start-stage-thread`. */
export function boardStageRestartBlockedReason(unmetKeys: ReadonlyArray<string>): string {
  if (unmetKeys.length === 0) return "This card is blocked by unmet dependencies.";
  if (unmetKeys.length === 1) return `Blocked until ${unmetKeys[0]} is done.`;
  return `Blocked until ${unmetKeys.join(", ")} are done.`;
}

/**
 * Whether a supervised run is in flight, read from the shell's derived status
 * (step state is server-only). Idle or dead threads do not count: restarting
 * onto them is the point of the escape hatch.
 */
export function isBoardCardRunInFlight(
  shell: Pick<BoardCardShell, "threadState" | "queued"> | undefined,
): boolean {
  if (shell === undefined) return false;
  return shell.threadState === "working" || shell.threadState === "waiting" || shell.queued;
}

/**
 * A user-editable stage label as it reads mid-sentence. Only an ordinary
 * capitalised word loses its first capital ("Code review" -> "code review",
 * "QA" stays). `toLowerCase` keeps it locale-independent.
 */
export function boardStageLabelMidSentence(label: string): string {
  return /^\p{Lu}\p{Ll}/u.test(label) ? label.charAt(0).toLowerCase() + label.slice(1) : label;
}

/**
 * The restart item: `null` when absent; otherwise the stage label and a reason
 * that is non-null while a run is in flight and the step has not stalled. Offered
 * on auto-executing stages and on any stage whose step has stalled.
 */
export function resolveBoardThreadStageRestart(input: {
  readonly autoExecute: boolean;
  readonly stageLabel: string;
  readonly runInFlight: boolean;
  /** Whether the card's live step has given up. */
  readonly stalled: boolean;
  /** Non-null when start-stage-thread would be refused for unmet deps. */
  readonly blockedReason?: string | null;
}): BoardThreadStageRestart | null {
  if (!input.autoExecute && !input.stalled) return null;
  return {
    label: input.stageLabel,
    // A stalled step has nothing running it, whatever the summed thread state
    // says. A blocked card's restart is refused by the server, so it is disabled.
    disabledReason:
      input.runInFlight && !input.stalled
        ? BOARD_STAGE_RESTART_IN_FLIGHT_REASON
        : (input.blockedReason ?? null),
  };
}

/**
 * One dispatch's settled outcome. `"interrupted"` was cancelled before settling,
 * so the server outcome is unknown: the write may have landed.
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
 * Create a server thread, then link it to the card; `true` when both landed. A
 * definite link failure deletes the thread. An interrupted link is NOT rolled
 * back: it may have landed, and deleting a linked thread is worse than an orphan.
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

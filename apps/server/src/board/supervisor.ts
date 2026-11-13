/**
 * The pure decision logic of the step machine; the reactor (`supervisorReactor.ts`) does
 * the I/O. Covers the prompt envelope, step selection, the recovery ladder and boot
 * reconciliation, all unit-tested without a server.
 */
import {
  BOARD_ENVELOPE_QUESTION_MECHANISM,
  boardBlockedInstruction,
  boardReviewQuestionAnswer,
  BOARD_LOCAL_WORKER_ID,
  boardCardPriorityRank,
  clampBoardInstanceCap,
  resolveBoardWorkerConcurrency,
} from "@t3tools/contracts";
import type {
  BoardCardId,
  BoardCardPriority,
  BoardCardStepState,
  BoardConcurrencySettings,
  BoardWorkerId,
  ProviderInstanceId,
} from "@t3tools/contracts";

// The prompt envelope moved to contracts (`boardEnvelope.ts`) so the
// settings UI renders exactly the text that wraps a stage's editable prompt;
// re-exported here so the reactor and the supervisor tests keep their one
// import site for the decision logic.
export {
  composeStepPrompt,
  type ComposeStepPromptInput,
  type ComposeStepPromptStep,
} from "@t3tools/contracts";

/**
 * How many `timeoutMs` windows thread output may shield one step from the timeout sweep.
 * Output is satisfied by noise too (a tool loop thrashing), so the shield expires and the
 * thrash climbs the ladder to a human. Todo advances and commits have no ceiling. A
 * multiple of `timeoutMs` so a stage given a longer timeout stretches it.
 */
const BOARD_OUTPUT_SIGNAL_MAX_WINDOWS = 8;

/** Whether the thread-output life sign still shields this step.
    A step whose `startedAt` is unreadable cannot have its age measured, so the
    shield holds — the conservative direction, and the same reading the sweep
    gives every other missing timestamp. */
export function outputSignalShieldsStep(input: {
  readonly nowMs: number;
  readonly startedAt: string | null;
  readonly timeoutMs: number;
}): boolean {
  const startedMs = input.startedAt === null ? Number.NaN : Date.parse(input.startedAt);
  if (!Number.isFinite(startedMs)) return true;
  return input.nowMs - startedMs <= input.timeoutMs * BOARD_OUTPUT_SIGNAL_MAX_WINDOWS;
}

export type BoardRecoveryDecision =
  | {
      readonly kind: "resume";
      readonly attempt: number;
      readonly stallCount: number;
      readonly nudge: string;
    }
  | {
      readonly kind: "escalate";
      readonly attempt: number;
      readonly stallCount: number;
      readonly question: string;
    };

/**
 * The run that stalled: its step when the stage has steps, else the stage, else neither
 * when the row froze no name, so nobody is escalated about `Stage "null"`.
 */
function stalledSubject(stepState: Pick<BoardCardStepState, "stepLabel" | "stageLabel">): string {
  if (stepState.stepLabel !== null) return `Step "${stepState.stepLabel}"`;
  return stepState.stageLabel === null ? "This stage" : `Stage "${stepState.stageLabel}"`;
}

/** Which of recovery's two ceilings a stop crosses, or null while both hold. */
export type BoardRecoveryCeiling = "stage-entry" | "stall-streak";

/**
 * The two ceilings, given the totals a stop WOULD reach. Shared because not every stop
 * that spends the retry budget goes through `recoveryDecision`, and every one owes the
 * card an eventual escalation.
 */
export function recoveryCeilingCrossed(input: {
  /** The consecutive-stall count this stop would reach, this stop included. */
  readonly stallCount: number;
  readonly maxAttempts: number;
  /** The stage entry's recovery total this stop would reach, this one included. */
  readonly stageEntryRecoveries: number;
  readonly maxRecoveriesPerStageEntry: number;
}): BoardRecoveryCeiling | null {
  // Stage ceiling first: a stage that has spent more than the ceiling on RECOVERY is a
  // runaway regardless of the per-step ladder — the backstop that stays
  // observable even when no single step wedged.
  if (input.stageEntryRecoveries > input.maxRecoveriesPerStageEntry) return "stage-entry";
  // Per-step ladder: `maxAttempts` consecutive unproductive stalls.
  if (input.stallCount >= input.maxAttempts) return "stall-streak";
  return null;
}

/**
 * How a stalled or dead step recovers: bounded, pure, never loops. Escalates when
 * `stallCount` (reset on progress) reaches `maxAttempts`, or when the stage entry's
 * total RECOVERIES (never planned steps) cross `maxRecoveriesPerStageEntry`, which catches
 * a stage whose steps each inch forward but never finish.
 */
export function recoveryDecision(input: {
  readonly stepState: Pick<
    BoardCardStepState,
    "attempt" | "stallCount" | "maxAttempts" | "stepLabel" | "stageLabel"
  > & { readonly stepId?: string };
  /**
   * Reactor-resolved: the step thread's todo list advanced (done count rose or in-progress
   * item changed) or a commit landed on the branch since the last nudge. Resets
   * `stallCount`.
   */
  readonly progressedSinceLastNudge: boolean;
  /** The stage entry's total RECOVERIES so far,
      summed across its steps by the reactor. This recovery is one more, so the
      ceiling is checked against `stageEntryRecoveries + 1`. */
  readonly stageEntryRecoveries: number;
  /** The ceiling `stageEntryRecoveries` is checked against. Named for what it
      bounds; the settings key it is resolved from keeps the older, now
      imprecise name `maxInvocationsPerStageEntry`. */
  readonly maxRecoveriesPerStageEntry: number;
  /**
   * Whether the stopped turn ended with a question for a human. Recovery is unattended by
   * construction, so the nudge answers "you decide", which stops the agent asking again.
   */
  readonly endedWithQuestion: boolean;
}): BoardRecoveryDecision {
  const nextAttempt = input.stepState.attempt + 1;
  // Progress since the last nudge forgets the prior streak, so THIS stall is
  // the first of a new one (crit 1: two stalls with a progress note between them
  // leave `stallCount` at 1, not 2). No progress just extends the streak.
  const nextStallCount = (input.progressedSinceLastNudge ? 0 : input.stepState.stallCount) + 1;
  const nextStageRecoveries = input.stageEntryRecoveries + 1;
  const escalateManually = `How should I proceed: retry it again, switch to a different provider, or do you want to take it over manually?`;

  // Planned steps never reach here.
  const ceiling = recoveryCeilingCrossed({
    stallCount: nextStallCount,
    maxAttempts: input.stepState.maxAttempts,
    stageEntryRecoveries: nextStageRecoveries,
    maxRecoveriesPerStageEntry: input.maxRecoveriesPerStageEntry,
  });
  if (ceiling === "stage-entry") {
    return {
      kind: "escalate",
      attempt: nextAttempt,
      stallCount: nextStallCount,
      question: [
        // Says RECOVERIES, not invocations: this text is what the human it
        // escalates to reads, and the old wording described a number that no
        // longer exists.
        `This stage has now needed ${nextStageRecoveries} recoveries this entry without completing, past the ${input.maxRecoveriesPerStageEntry} allowed for one stage entry.`,
        escalateManually,
      ].join(" "),
    };
  }
  if (ceiling === "stall-streak") {
    return {
      kind: "escalate",
      attempt: nextAttempt,
      stallCount: nextStallCount,
      question: [
        // Names the step only when the stage has steps, and neither name when the row froze none
        // (rather than quoting "null").
        `${stalledSubject(input.stepState)} has now stalled ${nextStallCount} times in a row without making progress.`,
        escalateManually,
      ].join(" "),
    };
  }
  return {
    kind: "resume",
    attempt: nextAttempt,
    stallCount: nextStallCount,
    nudge: boardRecoveryNudge({
      stallCount: nextStallCount,
      endedWithQuestion: input.endedWithQuestion,
      ...(input.stepState.stepId === undefined ? {} : { stepId: input.stepState.stepId }),
    }),
  };
}

/**
 * The words a recovery nudge sends. Separate from `recoveryDecision` because the ladder is
 * charged when the turn ends but the nudge goes later, when the governor re-admits the
 * step, so it is composed from the step row.
 */
export function boardRecoveryNudge(input: {
  /** The step's CONSECUTIVE stall count, already including this stall. The
      outstanding-work reminder appears from the third onward. */
  readonly stallCount: number;
  readonly endedWithQuestion: boolean;
  /** The step being nudged. Triage and adjudication never ask a human,
      so theirs says to decide instead. */
  readonly stepId?: string;
}): string {
  const decides = input.stepId !== undefined && boardReviewQuestionAnswer(input.stepId) !== null;
  const nudgeLines = [
    `Your previous turn ended without calling board_complete_step, so your work is not finished.`,
    decides
      ? `Continue where you left off and call board_complete_step when done. ${boardBlockedInstruction(input.stepId!)}`
      : `Continue where you left off and call board_complete_step when done; if you are blocked, ${BOARD_ENVELOPE_QUESTION_MECHANISM}.`,
  ];
  if (input.stallCount >= 3) {
    nudgeLines.splice(
      1,
      0,
      `Summarise what is still outstanding before continuing, so nothing is dropped.`,
    );
  }
  // Prepended after the splice, so it reads as a reply to the question. Worded around the
  // question, not the turn: the timeout sweep reaches recovery mid-turn too. Triage and
  // adjudication get a conditional form, since the last message may not end with a question.
  const decideYourself = `nobody will answer it: decide it yourself with your best judgement, record the decision, and continue.`;
  if (input.endedWithQuestion) {
    nudgeLines.unshift(`You asked a question, but this run is unattended and ${decideYourself}`);
  } else if (decides) {
    nudgeLines.unshift(`If you have a question, this run is unattended and ${decideYourself}`);
  }
  return nudgeLines.join(" ");
}

/**
 * Background-wait check-in offsets from when the wait began: 5, 15, 30 minutes, then every
 * 30. Fixed rather than a multiple of `timeoutMs`: a background job's length says nothing
 * about how long a turn should take.
 */
const BOARD_BACKGROUND_CHECK_IN_OFFSETS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000] as const;
const BOARD_BACKGROUND_CHECK_IN_INTERVAL_MS = 30 * 60_000;

/** When the next check-in of a wait is due, in epoch ms. `checkInsSent` is how
    many this wait has already had. */
export function boardBackgroundCheckInDueMs(input: {
  readonly sinceMs: number;
  readonly checkInsSent: number;
}): number {
  const offsets: ReadonlyArray<number> = BOARD_BACKGROUND_CHECK_IN_OFFSETS_MS;
  const scheduled = offsets[input.checkInsSent];
  if (scheduled !== undefined) return input.sinceMs + scheduled;
  // Past the offsets, so `beyond` is at least 1.
  const beyond = input.checkInsSent - offsets.length + 1;
  return input.sinceMs + (offsets.at(-1) ?? 0) + beyond * BOARD_BACKGROUND_CHECK_IN_INTERVAL_MS;
}

/** Where a wait resumes after a human's hold: back-dated so the next check-in
    is one step of the ladder from `nowMs`, not the whole cumulative offset. */
export function boardBackgroundWaitResumedSinceMs(input: {
  readonly nowMs: number;
  readonly checkInsSent: number;
}): number {
  if (input.checkInsSent === 0) return input.nowMs;
  return (
    input.nowMs - boardBackgroundCheckInDueMs({ sinceMs: 0, checkInsSent: input.checkInsSent - 1 })
  );
}

/** Whether a check-in spends the recovery budget. The scheduled ones
    in the first half hour are free; every one after that is charged like a
    recovery, so a background job that never finishes reaches a human at the
    existing ceilings — about three hours at the default `maxAttempts` of 5. */
export function boardBackgroundCheckInCharged(checkInsSent: number): boolean {
  return checkInsSent >= BOARD_BACKGROUND_CHECK_IN_OFFSETS_MS.length;
}

/**
 * Not `boardRecoveryNudge`: waiting is not a failure, and failure wording makes the agent
 * apologise and end another turn. It must LOOK: agents report dead work as still running.
 */
export function boardBackgroundCheckInNudge(): string {
  return [
    `You ended your turn with background work still running (a background command, a monitor, or subagents), and this is a scheduled check-in on it.`,
    `Actually verify it is still alive (check the process, its output file, or the task status) rather than assuming it is.`,
    `If it has finished or died, deal with the result and carry on toward board_complete_step.`,
    `If it is genuinely still running, end your turn again; you will be woken when it reports.`,
  ].join(" ");
}

/**
 * Sent into a `usage-limit` park's thread when the board's retry sweep wakes it because the
 * engine's resume never arrived. Not a recovery nudge: nothing failed and no attempt was
 * consumed.
 */
export const BOARD_STEP_USAGE_LIMIT_RESUME_NUDGE = [
  `Your provider's usage limit has reset and this work has been resumed automatically.`,
  `Continue from where you left off, and call board_complete_step when you are done.`,
].join(" ");

/**
 * Sent into a human-paused step's existing thread on resume, in place of the full step
 * prompt. Must not read like a recovery nudge: nothing failed and no attempt was consumed.
 */
export const BOARD_STEP_RESUME_NUDGE = [
  `This work was paused and has now been resumed.`,
  `Continue from where you left off, and call board_complete_step when you are done.`,
].join(" ");

export type BoardReconcileDecision =
  | { readonly kind: "resume-watch" }
  | { readonly kind: "recover" }
  | { readonly kind: "park" }
  | { readonly kind: "reschedule" }
  | { readonly kind: "advance" };

/**
 * What boot reconciliation does with a card found mid-step; a vanished thread is normal
 * control flow. `threadAlive` (a turn running or a question pending) and `threadPresent`
 * (a human could type in it) are separate bits: a step parked on a human sits between
 * them.
 */
export function reconcileStepDecision(input: {
  readonly status: BoardCardStepState["status"];
  readonly threadAlive: boolean;
  /** The step's thread still exists (idle counts). See above. */
  readonly threadPresent: boolean;
  /** The step runs WITH a human (planning, a human-in-the-loop build). Such a
      step stopping between turns is a pause, never a death. */
  readonly humanInLoop: boolean;
  readonly hasSucceeded: boolean;
}): BoardReconcileDecision {
  if (input.hasSucceeded) return { kind: "advance" };
  if (input.status === "stalled") {
    // Recovery gave up here: the step is non-terminal so boot
    // reconciliation must keep re-reading it, but supervision does not drive it
    // — it stops until a human acts. Leave it exactly as it is (no recover, no
    // slot restore: a stalled step already released its slot).
    return { kind: "resume-watch" };
  }
  if (input.status === "paused") {
    // A human paused this step: non-terminal like `stalled`, but supervision never drives it.
    // No slot restore: a paused step released its slot when it parked.
    return { kind: "resume-watch" };
  }
  if (input.status === "awaiting-input") {
    // Keyed on PRESENT, not alive: a step parked on a question asked in prose has no pending
    // question and so no liveness; reading `threadAlive` would un-park and nudge it on restart.
    // A gone thread is still a recover: the question can no longer be answered there.
    return input.threadPresent ? { kind: "resume-watch" } : { kind: "recover" };
  }
  if (input.status === "running") {
    if (input.threadAlive) return { kind: "resume-watch" };
    // A human-in-the-loop step whose thread is idle is waiting on the human, not dead (the same
    // call `handleTurnCompleted` makes live). Parking it stops the nudge and the running dot.
    if (input.humanInLoop && input.threadPresent) return { kind: "park" };
    return { kind: "recover" };
  }
  if (input.status === "pending" || input.status === "queued") {
    // Never started, holds no slot — not a death to recover but work to place.
    // A fresh schedule pass re-offers it to the governor (re-admit if a slot is
    // now free, otherwise re-queue), so a step queued when the server went down
    // is not mistaken for a stall and never burns a recovery attempt.
    return { kind: "reschedule" };
  }
  // completing: the agent reported done but settle did not land — re-drive.
  return { kind: "recover" };
}

// ── Offline workers ──────────────────────────────────────────

/** A stretch of time a worker was out of the board's reach, in epoch millis. */
export interface BoardOfflineInterval {
  readonly from: number;
  readonly to: number;
}

/**
 * How much of `(sinceMs, nowMs]` a step's worker spent out of reach, which the timeout sweep
 * does not count. Only the part of each interval after the step's latest life sign is
 * credited, so a life sign that arrives after the worker came back is not extended again.
 */
export function boardOfflineCreditMs(
  intervals: ReadonlyArray<BoardOfflineInterval>,
  sinceMs: number,
  nowMs: number,
): number {
  let credit = 0;
  for (const interval of intervals) {
    credit += Math.max(0, Math.min(nowMs, interval.to) - Math.max(sinceMs, interval.from));
  }
  return credit;
}

// ── Concurrency governor ─────────────────────────────────────

/** One card's step competing for a slot. Everything the ordering branches on
    is a scalar off the read model — no thread shells, no SQL. */
export interface BoardQueueCandidate {
  readonly cardId: BoardCardId;
  readonly stepId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** The card's stage position in board order: the reactor resolves it
      from the read-model stage list, since stages are user-defined and no
      longer a compiled array. */
  readonly stageOrder: number;
  /** The card has already begun this stage's work (has a recorded completion),
      so it is "mid-stage waiting on a slot", not "not yet started". */
  readonly started: boolean;
  /** Effective priority: a group's is always normal. */
  readonly priority: BoardCardPriority;
  readonly orderKey: string;
}

/**
 * The governor's total order: later stage first (finishing beats starting), then started
 * before unstarted (so a half-done card is never starved by fresh work), then priority (it
 * only decides between cards waiting at the same stage), then drag order.
 * Callers offer candidates to `acquire` in this order; greedy allocation and preemption at a
 * step boundary both fall out of iterating it.
 */
export function orderBoardQueue(
  candidates: ReadonlyArray<BoardQueueCandidate>,
): ReadonlyArray<BoardQueueCandidate> {
  return [...candidates].sort((a, b) => {
    const stageDelta = b.stageOrder - a.stageOrder;
    if (stageDelta !== 0) return stageDelta;
    if (a.started !== b.started) return a.started ? -1 : 1;
    const priorityDelta = boardCardPriorityRank(b.priority) - boardCardPriorityRank(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0;
  });
}

/**
 * The three ceilings for a step on a worker: the board limit, the worker's limit, and the
 * instance's cap on that worker. A null or absent limit or cap means no limit of that kind.
 * A cap above its worker's limit reads as the worker limit, so `acquire` names the worker.
 */
export function resolveBoardConcurrencyLimit(
  concurrency: BoardConcurrencySettings,
  providerInstanceId: ProviderInstanceId,
  workerId: BoardWorkerId = BOARD_LOCAL_WORKER_ID,
): {
  readonly global: number;
  readonly worker: number | null;
  readonly perInstance: number | null;
} {
  const onWorker = resolveBoardWorkerConcurrency(concurrency, workerId);
  const cap = clampBoardInstanceCap(
    onWorker.perInstance[providerInstanceId] ?? null,
    onWorker.maxConcurrent,
  );
  return {
    global: concurrency.globalMaxConcurrent,
    worker: onWorker.maxConcurrent,
    perInstance: cap !== null && cap === onWorker.maxConcurrent ? null : cap,
  };
}

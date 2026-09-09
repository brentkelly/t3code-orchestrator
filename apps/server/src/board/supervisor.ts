/**
 * T3o supervisor — the pure decision logic of the step machine (t3o-10).
 *
 * The reactor (`supervisorReactor.ts`) does the I/O: it watches board and
 * thread events, spawns threads, and dispatches commands. Every *decision* it
 * makes lives here as a pure function, so the plan's hard cases — which step
 * runs next, how a stall escalates, what a mid-step restart should do — are
 * unit-tested without a running server (D8 in spirit: logic is pure, the
 * effectful shell is thin).
 *
 * - Prompt envelope (D5): provider-neutral preamble + body + postamble.
 * - Step selection (D4): the next step of the card's recipe snapshot that has
 *   no successful completion yet.
 * - Recovery (D13): escalating nudges that never loop — resume, resume with an
 *   outstanding-work summary, then hand to the human.
 * - Boot reconciliation: given a persisted non-terminal step and the world's
 *   answer to "is its thread still alive / did it complete while we were
 *   down", decide resume / recover / advance.
 */
import { BOARD_ENVELOPE_QUESTION_MECHANISM } from "@t3tools/contracts";
import type {
  BoardCardId,
  BoardCardStepState,
  BoardConcurrencySettings,
  ProviderInstanceId,
} from "@t3tools/contracts";

// The prompt envelope (D5) moved to contracts (`boardEnvelope.ts`) so the
// settings UI renders exactly the text that wraps a stage's editable prompt;
// re-exported here so the reactor and the supervisor tests keep their one
// import site for the decision logic.
export {
  composeStepPrompt,
  type ComposeStepPromptInput,
  type ComposeStepPromptStep,
} from "@t3tools/contracts";

/** How many `timeoutMs` windows the thread-OUTPUT life sign may keep shielding
    one step from the timeout sweep (T3O-12, D9) — 8, so four hours at the
    default half-hour timeout.

    The output signal answers "is the agent emitting anything", which is what
    saves a healthy review phase that neither commits nor churns a todo list.
    But it is satisfied by NOISE as readily as by work: an agent thrashing in a
    tool loop emits activity rows continuously, and a signal with no ceiling
    would keep it non-overdue every window forever. It would then never be
    nudged, so `stallCount` would never climb and the recovery ceiling — only
    ever spent by an actual recovery — would never be charged either. The step
    would hold its slot for as long as it cared to thrash and no human would
    ever be told. That is the opposite failure to the one T3O-12 fixed, and the
    worse one: a supervisor that cries wolf is annoying, a supervisor that never
    cries is not a supervisor.

    So the shield expires. Past the ceiling the sweep reverts EXACTLY to its
    pre-T3O-12 life signs — last nudge/start, todo advance, branch commit — and
    the thrash climbs the ordinary ladder to a human. Genuine progress is
    untouched: the two older signs have no ceiling, because a todo list that
    advances and a commit that lands are evidence of work, not of noise, and a
    long build that keeps committing must never be nudged for taking its time.

    Deliberately a multiple of the step's own `timeoutMs` rather than a new
    setting: a stage that has been given a longer timeout has said its work is
    slower, and the ceiling should stretch with it. */
export const BOARD_OUTPUT_SIGNAL_MAX_WINDOWS = 8;

/** Whether the thread-output life sign still shields this step (T3O-12, D9).
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

/** How the escalation names the run that stalled (t3o-19, D4/D5): its step when
    the stage HAS steps, otherwise the stage, and neither when the row froze no
    name at all (pre-020) — nobody should be escalated to about `Stage "null"`.
    Reads `stageLabel` directly rather than going through `boardRunLabel`, which
    on this branch could only ever return it. */
function stalledSubject(stepState: Pick<BoardCardStepState, "stepLabel" | "stageLabel">): string {
  if (stepState.stepLabel !== null) return `Step "${stepState.stepLabel}"`;
  return stepState.stageLabel === null ? "This stage" : `Stage "${stepState.stageLabel}"`;
}

/** Which of recovery's two ceilings a stop crosses, or null while both hold. */
export type BoardRecoveryCeiling = "stage-entry" | "stall-streak";

/**
 * Ask the two ceilings on their own (T3O-22), given the totals a stop WOULD
 * reach — one definition, so nothing enforces half of them.
 *
 * `recoveryDecision` below is the usual caller, but it is not the only stop
 * that spends the retry budget: a lone LOOSE usage-limit match parks its card
 * itself (D6) and never reaches recovery at all, so without asking here it
 * would back the same card off every rung for ever, charging a budget nobody
 * reads. Ceilings are what turn "try again later" into "and eventually tell a
 * human", and every path that charges the budget owes the card that.
 */
export function recoveryCeilingCrossed(input: {
  /** The consecutive-stall count this stop would reach, this stop included. */
  readonly stallCount: number;
  readonly maxAttempts: number;
  /** The stage entry's recovery total this stop would reach, this one included. */
  readonly stageEntryRecoveries: number;
  readonly maxRecoveriesPerStageEntry: number;
}): BoardRecoveryCeiling | null {
  // D5 first: a stage that has spent more than the ceiling on RECOVERY is a
  // runaway regardless of the per-step ladder — the backstop that stays
  // observable even when no single step wedged.
  if (input.stageEntryRecoveries > input.maxRecoveriesPerStageEntry) return "stage-entry";
  // D1 per-step ladder: `maxAttempts` consecutive unproductive stalls.
  if (input.stallCount >= input.maxAttempts) return "stall-streak";
  return null;
}

/**
 * How a stalled or dead step recovers (t3o-17, D1/D5) — escalating and bounded,
 * and PURE (crit 5): git and SQL stay in the reactor, which resolves the
 * progress signal and the stage-entry invocation total and passes them in as
 * scalars. Two ceilings decide it:
 *
 * - **consecutive stalls** (`stallCount`, D1): the count resets on progress, so
 *   a step that keeps inching forward never escalates however many times it is
 *   nudged; only `maxAttempts` unproductive stops in a row does. Within budget →
 *   resume with a nudge that grows an outstanding-work reminder on the third and
 *   later consecutive stall;
 * - **per-stage-entry recoveries** (`stageEntryRecoveries`, D5 as re-pointed by
 *   T3O-12 D4): the runaway detector above the per-step ladder — once a stage
 *   entry's total RECOVERIES cross `maxRecoveriesPerStageEntry`, the stage
 *   stalls whatever the per-step ladder says. It catches the stage the per-step
 *   ladder cannot see: one where every step inches forward (resetting
 *   `stallCount`) and the whole never finishes.
 *
 *   Recoveries, not invocations. Counting invocations counted the review loop's
 *   PLANNED steps, so a loop given extra rounds blew a ceiling that was never
 *   meant to bound successful work, and from then on its first stall of any
 *   kind escalated instantly with no ladder at all.
 *
 * Either ceiling crossed → escalate (the reactor lands the step in `stalled` and
 * releases its slot); it never loops. Prevention lives in the envelope (the
 * unattended postamble asks the agent to keep a todo list current, t3o-18 D16);
 * cure lives here.
 */
export function recoveryDecision(input: {
  readonly stepState: Pick<
    BoardCardStepState,
    "attempt" | "stallCount" | "maxAttempts" | "stepLabel" | "stageLabel"
  >;
  /** Resolved by the reactor (t3o-17 D2, re-pointed by t3o-18 D16): the step
      thread's TODO LIST advanced — a `turn.plan.updated` whose done count rose or
      whose in-progress item changed — or a new commit landed on the card's
      branch, since the last nudge. Resets `stallCount`. */
  readonly progressedSinceLastNudge: boolean;
  /** Whether the step's thread has a todo list at all (t3o-18, D16), resolved by
      the reactor from `board_thread_todos` and passed in — the same pattern
      `progressedSinceLastNudge` establishes, so this function stays pure with no
      git and no SQL.

      This is the conditional the INITIAL envelope cannot express: at step start
      no turn has run, so no thread has a list yet, and only recovery time knows
      the difference. A nudged thread with no list is explicitly asked to write
      one and work through it; one that already has a list is not nagged.

      An agent that produces a list and then freezes it still stalls correctly —
      absence of a list and a frozen list are both "no progress", which is the
      right reading of each. */
  readonly hasTodoList: boolean;
  /** The stage entry's total RECOVERIES so far (D5, re-pointed by T3O-12 D4),
      summed across its steps by the reactor. This recovery is one more, so the
      ceiling is checked against `stageEntryRecoveries + 1`. */
  readonly stageEntryRecoveries: number;
  /** The ceiling `stageEntryRecoveries` is checked against. Named for what it
      bounds; the settings key it is resolved from keeps the older, now
      imprecise name `maxInvocationsPerStageEntry` (T3O-12, D6). */
  readonly maxRecoveriesPerStageEntry: number;
  /** Whether the stopped turn ended with something the agent wanted a human to
      answer (t3o-34, D6), resolved by the reactor from the step thread's last
      assistant message — the same "reactor resolves, this function stays pure"
      split as `progressedSinceLastNudge`.

      This arm is UNATTENDED by construction: a human-in-the-loop run never
      reaches recovery. So the answer to the question is "you decide", and
      saying so is what stops the nudged agent asking it again on the next turn
      and marching itself up the stall ladder. */
  readonly endedWithQuestion: boolean;
}): BoardRecoveryDecision {
  const nextAttempt = input.stepState.attempt + 1;
  // Progress since the last nudge forgets the prior streak, so THIS stall is
  // the first of a new one (crit 1: two stalls with a progress note between them
  // leave `stallCount` at 1, not 2). No progress just extends the streak.
  const nextStallCount = (input.progressedSinceLastNudge ? 0 : input.stepState.stallCount) + 1;
  const nextStageRecoveries = input.stageEntryRecoveries + 1;
  const escalateManually = `How should I proceed: retry it again, switch to a different provider, or do you want to take it over manually?`;

  // Planned steps never reach here, which is the whole of T3O-12's D4.
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
        // Named as a step only when the stage HAS steps (t3o-19, D4): on every
        // other stage `stepLabel` is null and the escalation names the stage,
        // which is what a human reading the card recognises anyway. A row that
        // froze neither name (pre-020) is described without one rather than
        // quoting a literal "null" at the human being escalated to.
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
      hasTodoList: input.hasTodoList,
      endedWithQuestion: input.endedWithQuestion,
    }),
  };
}

/**
 * The words a recovery nudge sends into the step's thread.
 *
 * Split out of `recoveryDecision` because the two are no longer sent at the same
 * moment (T3O-22, D7): the decision is made when the turn ends and the ladder is
 * charged there, while the nudge itself goes minutes later, when the backoff
 * rung reaches its time and the governor re-admits the step. The delivery path
 * holds the step row, so it composes the text from the row rather than carrying
 * a string across a park, a restart and a queue.
 *
 * Pure, and every input is a scalar the reactor resolves — the same split
 * `recoveryDecision` itself keeps.
 */
export function boardRecoveryNudge(input: {
  /** The step's CONSECUTIVE stall count, already including this stall. The
      outstanding-work reminder appears from the third onward. */
  readonly stallCount: number;
  readonly hasTodoList: boolean;
  readonly endedWithQuestion: boolean;
}): string {
  const nudgeLines = [
    `Your previous turn ended without calling board_complete_step, so your work is not finished.`,
    `Continue where you left off and call board_complete_step when done; if you are blocked, ${BOARD_ENVELOPE_QUESTION_MECHANISM}.`,
  ];
  // The nudge asks again, CONDITIONALLY (t3o-18, D16). Only a thread with no
  // list is asked for one — a thread already keeping one needs no reminder, and
  // repeating the ask would read as noise exactly where the agent is doing the
  // right thing.
  if (!input.hasTodoList) {
    nudgeLines.push(
      `You are not keeping a todo list: write one now (your task/plan tool) and work through it, so progress is visible and this run is not escalated as stalled.`,
    );
  }
  if (input.stallCount >= 3) {
    nudgeLines.splice(
      1,
      0,
      `Summarise what is still outstanding before continuing, so nothing is dropped.`,
    );
  }
  // Answer the question the agent asked, with the only answer an unattended run
  // has (t3o-34, D6). Prepended AFTER the splice above, so it reads as a reply
  // to the question and the outstanding-work reminder keeps the position it has
  // always had relative to the "continue" instruction.
  //
  // Worded around the question rather than around the turn: recovery is reached
  // from the TIMEOUT SWEEP as well as from a completed turn, and there the
  // agent's last message is the newest thing it said while the turn is still
  // open. "You asked a question" is true on both paths; "your turn ended with a
  // question" is not.
  if (input.endedWithQuestion) {
    nudgeLines.unshift(
      `You asked a question, but this run is unattended and nobody will answer it: decide it yourself with your best judgement, record the decision, and continue.`,
    );
  }
  return nudgeLines.join(" ");
}

/**
 * What the board says to an agent when a provider's usage window reopens
 * (T3O-22, D9) — sent into the parked step's thread when the cooldown lifts.
 *
 * Deliberately not a recovery nudge: nothing stalled, nothing failed, and no
 * attempt was consumed (D12). The agent was refused by a provider that has since
 * come back, and the only thing it needs to know is that it may carry on.
 */
export const BOARD_STEP_USAGE_LIMIT_RESUME_NUDGE = [
  `Your provider's usage limit has reset and this work has been resumed automatically.`,
  `Continue from where you left off, and call board_complete_step when you are done.`,
].join(" ");

/**
 * What the board says to an agent when it resumes a step a human PAUSED
 * (T3O-23) — sent into the step's existing thread on admission, in place of the
 * full step prompt a fresh spawn would carry.
 *
 * Deliberately not a recovery nudge, and it must not read like one: nothing
 * stalled, nothing failed, and no attempt was consumed. The agent stopped
 * because a human told it to, and the only thing it needs to know is that it may
 * carry on.
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
 * What boot reconciliation does with a card found mid-step after a restart.
 * The server restarts mid-step routinely, and `ProviderSessionReaper` makes
 * "the thread I spawned is gone" a normal path, so this is control flow, not
 * error handling:
 *
 * - the step already succeeded while we were down → advance;
 * - a human paused it (T3O-23) → leave it parked;
 * - its thread is still alive → resume watching;
 * - a human-in-the-loop step whose thread is present but idle → park it on the
 *   human (t3o-34), the boot-time twin of `handleTurnCompleted`'s arm;
 * - awaiting a human answer with the thread still present → keep waiting;
 * - its thread is gone and it never completed → recover;
 * - queued/pending with no thread → reschedule (re-offer to the governor: it
 *   held no slot and never started, so it is placed, not recovered — D11);
 * - completing (agent reported done, settle never landed) → recover.
 *
 * `threadAlive` and `threadPresent` are deliberately two bits, not one. Alive
 * means a turn is running or a structured question is pending; present means
 * the thread still exists and a human could type in it. Everything a step
 * parked on a human needs sits in the gap between them — nothing is running,
 * yet the card is one reply away from moving.
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
    // Recovery gave up here (t3o-17, D3): the step is non-terminal so boot
    // reconciliation must keep re-reading it, but supervision does not drive it
    // — it stops until a human acts. Leave it exactly as it is (no recover, no
    // slot restore: a stalled step already released its slot, D4).
    return { kind: "resume-watch" };
  }
  if (input.status === "paused") {
    // A human stopped this step (T3O-23). Same shape as `stalled`: non-terminal,
    // so boot reconciliation keeps re-reading it, but supervision does not drive
    // it — it stays parked until somebody resumes it. And no slot restore: a
    // paused step released its slot when it parked, which the caller's
    // `state.slotHeld` gate already reflects.
    return { kind: "resume-watch" };
  }
  if (input.status === "awaiting-input") {
    // Keyed on PRESENT, not alive: since t3o-34 a step can be parked on a
    // question the agent asked in PROSE, which leaves no pending question on
    // the thread and so no liveness at all. Reading `threadAlive` here un-parked
    // every one of those on the next restart and nudged it as if it had died —
    // t3o-34's fix surviving right up until the server bounced. A gone thread is
    // still a recover: the question can no longer be answered there.
    return input.threadPresent ? { kind: "resume-watch" } : { kind: "recover" };
  }
  if (input.status === "running") {
    if (input.threadAlive) return { kind: "resume-watch" };
    // A human-in-the-loop step whose thread is merely idle is WAITING on the
    // human (t3o-34, D5), not dead — the same call `handleTurnCompleted` makes
    // on the live edge. Boot reconciliation used to recover it instead: it
    // nudged the waiting agent with the unattended "nobody will answer you"
    // text, burned an attempt, and left the step `running`, so the card kept
    // pulsing its blue "being worked" dot across every restart while the agent
    // sat there waiting for an answer. Parking is what turns the dot off.
    if (input.humanInLoop && input.threadPresent) return { kind: "park" };
    return { kind: "recover" };
  }
  if (input.status === "pending" || input.status === "queued") {
    // Never started, holds no slot — not a death to recover but work to place.
    // A fresh schedule pass re-offers it to the governor (re-admit if a slot is
    // now free, otherwise re-queue), so a step queued when the server went down
    // is not mistaken for a stall and never burns a recovery attempt (D11).
    return { kind: "reschedule" };
  }
  // completing: the agent reported done but settle did not land — re-drive.
  return { kind: "recover" };
}

// ── Concurrency governor (t3o-11, D11) ─────────────────────────────────────

/** One card's step competing for a slot. Everything the ordering branches on
    is a scalar off the read model (D8) — no thread shells, no SQL. */
export interface BoardQueueCandidate {
  readonly cardId: BoardCardId;
  readonly stepId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /** The card's stage position in board order (D2): the reactor resolves it
      from the read-model stage list, since stages are user-defined and no
      longer a compiled array. */
  readonly stageOrder: number;
  /** The card has already begun this stage's work (has a recorded completion),
      so it is "mid-stage waiting on a slot", not "not yet started". */
  readonly started: boolean;
  readonly orderKey: string;
}

/**
 * The governor's ordering (D11), applied as one total order:
 *
 *   1. **stage descending** — finishing beats starting; a card one step from
 *      merge outranks one about to begin, so new work never strangles
 *      nearly-done work and the board does not stall at 90%.
 *   2. **started before unstarted** — a card mid-stage waiting for a slot on a
 *      *different* provider outranks one that has not begun. This is the
 *      mitigation for the starvation that per-step slot acquisition creates: a
 *      half-done card is never indefinitely overtaken by fresh work.
 *   3. **drag order** (`orderKey`) — what dragging within Building is actually
 *      for: it chooses what starts next.
 *
 * Pure and total, so the reactor offers candidates to `acquire` in this order
 * and greedy allocation (the highest-priority candidate that fits a free slot
 * wins; a saturated provider is simply skipped, not a blocker) falls straight
 * out of iterating the result. Preemption is this same order re-evaluated at a
 * step boundary: a card dragged above another takes the freed slot next, while
 * nothing in flight is discarded.
 */
export function orderBoardQueue(
  candidates: ReadonlyArray<BoardQueueCandidate>,
): ReadonlyArray<BoardQueueCandidate> {
  return [...candidates].sort((a, b) => {
    const stageDelta = b.stageOrder - a.stageOrder;
    if (stageDelta !== 0) return stageDelta;
    if (a.started !== b.started) return a.started ? -1 : 1;
    return a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : 0;
  });
}

/**
 * Resolve the concurrency caps for a provider instance (D11). A per-instance
 * value of `null` — or an absent entry, which is observationally identical
 * (see `BoardConcurrencySettings`) — means "no instance-specific cap": bound
 * only by the global ceiling, expressed as a null per-instance limit so
 * `acquire` applies the global one alone.
 */
export function resolveBoardConcurrencyLimit(
  concurrency: BoardConcurrencySettings,
  providerInstanceId: ProviderInstanceId,
): { readonly perInstance: number | null; readonly global: number } {
  return {
    perInstance: concurrency.perInstance[providerInstanceId] ?? null,
    global: concurrency.globalMaxConcurrent,
  };
}

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
 * - **per-stage-entry invocations** (`stageEntryInvocations`, D5): the runaway
 *   detector above the per-step ladder — once a stage entry's total invocations
 *   cross `maxInvocationsPerStageEntry`, the stage stalls whatever the per-step
 *   ladder says, so t3o-16's rounds × phases × attempts compound is bounded and
 *   observable.
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
  /** The stage entry's total step invocations so far (D5), summed across its
      steps by the reactor. This recovery is one more, so the ceiling is checked
      against `stageEntryInvocations + 1`. */
  readonly stageEntryInvocations: number;
  readonly maxInvocationsPerStageEntry: number;
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
  const nextStageInvocations = input.stageEntryInvocations + 1;
  const escalateManually = `How should I proceed: retry it again, switch to a different provider, or do you want to take it over manually?`;

  // D5 ceiling first: a stage whose steps have, in total, been invoked past the
  // ceiling is a runaway regardless of the per-step ladder — the backstop that
  // makes the compound bound observable even when no single step wedged.
  if (nextStageInvocations > input.maxInvocationsPerStageEntry) {
    return {
      kind: "escalate",
      attempt: nextAttempt,
      stallCount: nextStallCount,
      question: [
        `This stage has now run ${nextStageInvocations} agent invocations this entry without completing, past the ${input.maxInvocationsPerStageEntry} allowed for one stage entry.`,
        escalateManually,
      ].join(" "),
    };
  }
  // D1 per-step ladder: `maxAttempts` consecutive unproductive stalls.
  if (nextStallCount >= input.stepState.maxAttempts) {
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
  if (nextStallCount >= 3) {
    nudgeLines.splice(
      1,
      0,
      `Summarise what is still outstanding before continuing, so nothing is dropped.`,
    );
  }
  // Answer the question the agent asked, with the only answer an unattended run
  // has (t3o-34, D6). Prepended AFTER the splice above, so it reads as a reply
  // to the turn that just ended and the outstanding-work reminder keeps the
  // position it has always had relative to the "continue" instruction.
  if (input.endedWithQuestion) {
    nudgeLines.unshift(
      `Your turn ended with a question, but this run is unattended and nobody will answer it: decide it yourself with your best judgement, record the decision, and continue.`,
    );
  }
  return {
    kind: "resume",
    attempt: nextAttempt,
    stallCount: nextStallCount,
    nudge: nudgeLines.join(" "),
  };
}

export type BoardReconcileDecision =
  | { readonly kind: "resume-watch" }
  | { readonly kind: "recover" }
  | { readonly kind: "reschedule" }
  | { readonly kind: "advance" };

/**
 * What boot reconciliation does with a card found mid-step after a restart.
 * The server restarts mid-step routinely, and `ProviderSessionReaper` makes
 * "the thread I spawned is gone" a normal path, so this is control flow, not
 * error handling:
 *
 * - the step already succeeded while we were down → advance;
 * - its thread is still alive → resume watching;
 * - awaiting a human answer with the thread still present → keep waiting
 *   (resume-watch — the pending question is intact);
 * - its thread is gone and it never completed → recover;
 * - queued/pending with no thread → reschedule (re-offer to the governor: it
 *   held no slot and never started, so it is placed, not recovered — D11);
 * - completing (agent reported done, settle never landed) → recover.
 */
export function reconcileStepDecision(input: {
  readonly status: BoardCardStepState["status"];
  readonly threadAlive: boolean;
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
  if (input.status === "awaiting-input") {
    // A live pending question is intact; a gone thread means the question can
    // no longer be answered there, so recover it into a fresh escalation.
    return input.threadAlive ? { kind: "resume-watch" } : { kind: "recover" };
  }
  if (input.status === "running") {
    return input.threadAlive ? { kind: "resume-watch" } : { kind: "recover" };
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

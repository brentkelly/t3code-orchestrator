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
 * - Prompt envelope (D5): provider-neutral preamble + body + postamble, with
 *   the question-mechanism wording chosen per provider instance.
 * - Step selection (D4): the next step of the card's recipe snapshot that has
 *   no successful completion yet.
 * - Recovery (D13): escalating nudges that never loop — resume, resume with an
 *   outstanding-work summary, then hand to the human.
 * - Boot reconciliation: given a persisted non-terminal step and the world's
 *   answer to "is its thread still alive / did it complete while we were
 *   down", decide resume / recover / advance.
 */
import type {
  BoardCard,
  BoardCardId,
  BoardCardStepState,
  BoardConcurrencySettings,
  ProviderInstanceId,
} from "@t3tools/contracts";

/**
 * The provider-specific wording for "ask through your question tool, never in
 * prose" (D5). The board assigned the step, so it knows which provider it is
 * talking to — this is the concrete payoff of envelopes over Claude-specific
 * skills. Unknown instances fall back to neutral phrasing.
 */
export function providerQuestionMechanism(providerInstanceId: ProviderInstanceId): string {
  const key = String(providerInstanceId).toLowerCase();
  if (key.includes("claude") || key.includes("anthropic")) {
    return "raise it as a Claude Code question so it surfaces as a real prompt";
  }
  if (key.includes("codex") || key.includes("openai")) {
    return "raise it through Codex's ask-for-input request";
  }
  if (key.includes("cursor")) {
    return "raise it through Cursor's user-input request";
  }
  if (key.includes("gemini") || key.includes("google")) {
    return "raise it through Gemini's user-input request";
  }
  if (key.includes("grok")) {
    return "raise it through Grok's user-input request";
  }
  if (key.includes("opencode")) {
    return "raise it through OpenCode's user-input request";
  }
  return "raise it through your runtime's user-input request";
}

/** The frozen execution config a spawn needs, read off the step-state run row
    (D12) — the single step per stage (D1) replaces the old multi-step recipe. */
export interface ComposeStepPromptStep {
  readonly stepLabel: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly prompt: string;
  readonly maxAttempts: number;
  /** Frozen human-in-the-loop stance (D5): governs the postamble. */
  readonly humanInLoop: boolean;
}

export interface ComposeStepPromptInput {
  readonly card: Pick<BoardCard, "key" | "title" | "stage">;
  readonly step: ComposeStepPromptStep;
  readonly attempt: number;
}

/**
 * The full step prompt (D5): preamble + body + postamble. The preamble is
 * short by design — a pointer to `board_get_card_context` exists so context is
 * pulled, not pushed. The postamble branches on human-in-the-loop (D5): an
 * unattended run carries the `/unattended` stance (`board_complete_step` is the
 * only way to finish, never end a turn with an unanswered question in prose); a
 * human-in-the-loop run is question-friendly (ask me directly, a turn that ends
 * waiting is fine). An empty body is a re-entry (D7) — a clean conversational
 * thread with just the orientation and the human-in-the-loop stance.
 */
export function composeStepPrompt(input: ComposeStepPromptInput): string {
  const { card, step, attempt } = input;
  const questionMechanism = providerQuestionMechanism(step.providerInstanceId);
  const preamble = [
    `You are working card ${card.key} — "${card.title}".`,
    `Stage: ${card.stage}. Step: ${step.stepLabel} (attempt ${attempt} of ${step.maxAttempts}).`,
    `Call board_get_card_context for the brief, plan, dependencies and prior progress.`,
  ].join("\n");
  const body = step.prompt;
  const postamble = step.humanInLoop
    ? [
        `This is a human-in-the-loop run: ask me anything you need directly, and it is fine to end a turn waiting on my answer.`,
        `When the work is done, call board_complete_step to finish the step.`,
      ].join("\n")
    : [
        `You are running unattended. Do not stop to ask permission; make every reasonable decision yourself and proceed.`,
        `When the step is finished, call board_complete_step — that is the ONLY way to complete it; ending your turn any other way is treated as a failure and recovered.`,
        `On long-running work, call board_report_progress periodically (and commit as you go) so the supervisor can see you are making progress; without it a productive long job looks the same as a wedged one and will be escalated.`,
        `If you are truly blocked and need a human decision, ${questionMechanism}; never end a turn with an unanswered question in prose.`,
      ].join("\n");
  const bodyBlock = body.trim().length > 0 ? `${body}\n\n` : "";
  return `${preamble}\n\n${bodyBlock}${postamble}`;
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
 * unattended postamble asks for progress reports); cure lives here.
 */
export function recoveryDecision(input: {
  readonly stepState: Pick<
    BoardCardStepState,
    "attempt" | "stallCount" | "maxAttempts" | "stepLabel"
  >;
  /** Resolved by the reactor (D2): a `board_report_progress` entry or a new
      commit on the card's branch since the last nudge. Resets `stallCount`. */
  readonly progressedSinceLastNudge: boolean;
  /** The stage entry's total step invocations so far (D5), summed across its
      steps by the reactor. This recovery is one more, so the ceiling is checked
      against `stageEntryInvocations + 1`. */
  readonly stageEntryInvocations: number;
  readonly maxInvocationsPerStageEntry: number;
  readonly questionMechanism: string;
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
        `Step "${input.stepState.stepLabel}" has now stalled ${nextStallCount} times in a row without making progress.`,
        escalateManually,
      ].join(" "),
    };
  }
  const nudgeLines = [
    `Your previous turn ended without calling board_complete_step, so the step is not finished.`,
    `Continue where you left off and call board_complete_step when done; if you are blocked, ${input.questionMechanism}.`,
  ];
  if (nextStallCount >= 3) {
    nudgeLines.splice(
      1,
      0,
      `Summarise what is still outstanding before continuing, so nothing is dropped.`,
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

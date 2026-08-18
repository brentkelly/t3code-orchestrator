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
  BoardCardStepState,
  BoardResolvedRecipe,
  BoardStep,
  BoardStepCompletion,
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

export interface ComposeStepPromptInput {
  readonly card: Pick<BoardCard, "key" | "title" | "stage">;
  readonly step: BoardStep;
  readonly attempt: number;
}

/**
 * The full step prompt (D5): preamble + body + postamble. The preamble is
 * short by design — a pointer to `board_get_card_context` exists so context is
 * pulled, not pushed, keeping a fresh small thread oriented from token zero
 * without bloating every prompt. The postamble carries the completion contract
 * and the per-provider question rule.
 */
export function composeStepPrompt(input: ComposeStepPromptInput): string {
  const { card, step, attempt } = input;
  const questionMechanism = providerQuestionMechanism(step.providerInstanceId);
  const preamble = [
    `You are working card ${card.key} — "${card.title}".`,
    `Stage: ${card.stage}. Step: ${step.label} (attempt ${attempt} of ${step.maxAttempts}).`,
    `Call board_get_card_context for the brief, plan, dependencies and prior progress.`,
  ].join("\n");
  const body = step.promptTemplate;
  const postamble = [
    `When the step is finished, call board_complete_step — that is the ONLY way to complete it; ending your turn any other way is treated as a failure and recovered.`,
    `If you need a human decision, ${questionMechanism}; never end a turn with an unanswered question in prose.`,
  ].join("\n");
  return `${preamble}\n\n${body}\n\n${postamble}`;
}

/**
 * The next step of a card's recipe to run: the first step in recipe order with
 * no recorded `succeeded` completion (D4). A step completed `blocked` or
 * `failed` is not "done" — recovery/gating owns it, so selection stops there
 * rather than skipping past an unresolved step. Returns null when every step
 * has succeeded (the stage's work is complete).
 */
export function selectNextStep(
  recipe: BoardResolvedRecipe,
  completions: ReadonlyArray<BoardStepCompletion>,
): BoardStep | null {
  for (const step of recipe.steps) {
    const completion = completions.find((entry) => entry.stepId === step.id);
    if (completion === undefined || completion.outcome !== "succeeded") {
      return step;
    }
  }
  return null;
}

export type BoardRecoveryDecision =
  | { readonly kind: "resume"; readonly attempt: number; readonly nudge: string }
  | { readonly kind: "escalate"; readonly attempt: number; readonly question: string };

/**
 * How a stalled or dead step recovers (D13) — escalating and bounded. The
 * step's current `attempt` and the recipe's `maxAttempts` decide it:
 *
 * - within budget → resume the thread with a nudge that grows an
 *   outstanding-work reminder on the second and later tries;
 * - budget exhausted → stop and ask the human (retry / switch provider / take
 *   it manually), which never loops.
 *
 * Prevention lives in the envelope; cure lives here. Both are needed.
 */
export function recoveryDecision(input: {
  readonly stepState: Pick<BoardCardStepState, "attempt" | "maxAttempts" | "stepLabel">;
  readonly questionMechanism: string;
}): BoardRecoveryDecision {
  const nextAttempt = input.stepState.attempt + 1;
  if (nextAttempt > input.stepState.maxAttempts) {
    return {
      kind: "escalate",
      attempt: nextAttempt,
      question: [
        `Step "${input.stepState.stepLabel}" has now failed ${input.stepState.maxAttempts} times without completing.`,
        `How should I proceed: retry it again, switch to a different provider, or do you want to take it over manually?`,
      ].join(" "),
    };
  }
  const nudgeLines = [
    `Your previous turn ended without calling board_complete_step, so the step is not finished.`,
    `Continue where you left off and call board_complete_step when done; if you are blocked, ${input.questionMechanism}.`,
  ];
  if (nextAttempt >= 3) {
    nudgeLines.splice(
      1,
      0,
      `Summarise what is still outstanding before continuing, so nothing is dropped.`,
    );
  }
  return { kind: "resume", attempt: nextAttempt, nudge: nudgeLines.join(" ") };
}

export type BoardReconcileDecision =
  | { readonly kind: "resume-watch" }
  | { readonly kind: "recover" }
  | { readonly kind: "advance" }
  | { readonly kind: "settle-abandoned" };

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
 * - queued/pending with no thread → recover (re-drive admission).
 */
export function reconcileStepDecision(input: {
  readonly status: BoardCardStepState["status"];
  readonly threadAlive: boolean;
  readonly hasSucceeded: boolean;
}): BoardReconcileDecision {
  if (input.hasSucceeded) return { kind: "advance" };
  if (input.status === "awaiting-input") {
    // A live pending question is intact; a gone thread means the question can
    // no longer be answered there, so recover it into a fresh escalation.
    return input.threadAlive ? { kind: "resume-watch" } : { kind: "recover" };
  }
  if (input.status === "running") {
    return input.threadAlive ? { kind: "resume-watch" } : { kind: "recover" };
  }
  // pending / queued / completing: no live thread to watch — re-drive.
  return { kind: "recover" };
}

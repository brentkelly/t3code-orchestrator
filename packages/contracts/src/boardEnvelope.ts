/**
 * T3o prompt envelope (D5) — the system-owned wrapper around every board step
 * prompt, in contracts so the server (which composes the real run prompt) and
 * the settings UI (which shows the user exactly what wraps their editable
 * prompt) can never drift.
 *
 * The envelope carries the protocol a step MUST follow — orientation, the
 * completion contract, progress reporting, the question mechanism and the
 * role-keyed deliverable segments (a `plan` stage records its plan with
 * `board_propose_plans`; no stage ever moves its own card). The editable
 * per-stage prompt carries only intent, so a user rewrite can slow a stage
 * down but never break the board.
 *
 * Everything here is pure string composition: no SQL, no git, no thread
 * handles — unit-testable without a server, and safe to import from the web.
 */
import type { BoardReviewPhaseId, BoardStageRole } from "./board.ts";
import { BOARD_REVIEW_PHASE_LABELS, reviewStepId } from "./board.ts";
import type { ProviderInstanceId } from "./providerInstance.ts";

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

/** The stance-independent guard appended to every postamble: `board_move_card`
    is agent-reachable, so the envelope — not the editable prompt — forbids it.
    Worded to hold on every stance: an auto-advancing stage moves the card
    itself, a paused or manual one waits for a human. */
export const BOARD_ENVELOPE_MOVE_GUARD =
  "Never move the card between stages yourself; complete your step and the board or a human moves it on.";

/** The `plan` role's deliverable contract (role-keyed so a user rewrite of the
    editable Planning prompt cannot break the plan pipeline). */
export const BOARD_ENVELOPE_PLAN_DELIVERABLE =
  "When the plan is agreed, record it with board_propose_plans.";

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
  readonly card: { readonly key: string; readonly title: string; readonly stage: string };
  readonly step: ComposeStepPromptStep;
  readonly attempt: number;
  /** The stage's effective role: keys the deliverable postamble segment. */
  readonly role: BoardStageRole | null;
}

/** The system preamble (D5) — short by design: a pointer to
    `board_get_card_context` exists so context is pulled, not pushed.
    `attempt` admits a string so a settings-side preview can show a
    `{{n}}` placeholder where a run interpolates the real counter. */
export function boardStepPreamble(
  input: Pick<ComposeStepPromptInput, "card"> & {
    readonly step: Pick<ComposeStepPromptStep, "stepLabel" | "maxAttempts">;
    readonly attempt: number | string;
  },
): string {
  const { card, step, attempt } = input;
  return [
    `You are working card ${card.key} — "${card.title}".`,
    `Stage: ${card.stage}. Step: ${step.stepLabel} (attempt ${attempt} of ${step.maxAttempts}).`,
    `Call board_get_card_context for the brief, plan, dependencies and prior progress.`,
  ].join("\n");
}

/** The system postamble (D5): branches on human-in-the-loop (an unattended run
    carries the `/unattended` stance; a human-in-the-loop run is
    question-friendly), then appends the role-keyed deliverable segment and the
    move guard. */
export function boardStepPostamble(input: {
  readonly humanInLoop: boolean;
  readonly providerInstanceId: ProviderInstanceId;
  readonly role: BoardStageRole | null;
}): string {
  const questionMechanism = providerQuestionMechanism(input.providerInstanceId);
  const stance = input.humanInLoop
    ? [
        // Human-in-the-loop envelopes carry no todo-list nudge (t3o-18 D16,
        // preserving t3o-17 AC 6's asymmetry): these steps are not
        // stall-supervised and the human is already in the conversation.
        `This is a human-in-the-loop run: ask me anything you need directly, and it is fine to end a turn waiting on my answer.`,
        `When the work is done, call board_complete_step to finish the step.`,
      ]
    : [
        `You are running unattended. Do not stop to ask permission; make every reasonable decision yourself and proceed.`,
        `When the step is finished, call board_complete_step — that is the ONLY way to complete it; ending your turn any other way is treated as a failure and recovered.`,
        // The todo-list line (t3o-18 D16) replaced t3o-17's
        // `board_report_progress` instruction: the supervisor's progress signal
        // watches the agent's own plan tool advance, so this nudges a behaviour
        // the agent already wants rather than an extra MCP call.
        `Keep a todo list current as you work (your task/plan tool) and commit as you go: the supervisor watches your list advance to tell a productive long job from a wedged one, and without it a working step looks the same as a stalled one and will be escalated.`,
        `If you are truly blocked and need a human decision, ${questionMechanism}; never end a turn with an unanswered question in prose.`,
      ];
  const deliverable = input.role === "plan" ? [BOARD_ENVELOPE_PLAN_DELIVERABLE] : [];
  return [...stance, ...deliverable, BOARD_ENVELOPE_MOVE_GUARD].join("\n");
}

/**
 * The full step prompt (D5): preamble + body + postamble. An empty body is a
 * re-entry (D7) — a clean conversational thread with just the orientation and
 * the human-in-the-loop stance.
 */
export function composeStepPrompt(input: ComposeStepPromptInput): string {
  const preamble = boardStepPreamble(input);
  const postamble = boardStepPostamble({
    humanInLoop: input.step.humanInLoop,
    providerInstanceId: input.step.providerInstanceId,
    role: input.role,
  });
  const body = input.step.prompt;
  const bodyBlock = body.trim().length > 0 ? `${body}\n\n` : "";
  return `${preamble}\n\n${bodyBlock}${postamble}`;
}

/** A review phase's system preamble (D6/D7): the round header, plus — for any
    phase past the very first review — the pointer to the prior phases'
    payloads. */
export function boardReviewPhasePreamble(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
  readonly rounds: number;
}): string {
  const { phase, round, rounds } = input;
  const header = `Code review — ${BOARD_REVIEW_PHASE_LABELS[phase]}, round ${round} of up to ${rounds}.`;
  const priorContext =
    round > 1 || phase !== "review"
      ? "Call board_get_card_context first and read the `steps` payloads: they carry every prior phase's findings, dispositions and verdicts for this card."
      : "";
  return priorContext.length > 0 ? `${header}\n${priorContext}` : header;
}

/** A review phase's system protocol (D6/D7) — the loop mechanics the executor
    owns: the round-scoped step id, the payload shape, how to read priors. Pure:
    it names the `git` commands but never runs them; the agent does, in its
    worktree. */
export function boardReviewPhaseProtocol(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
}): string {
  const stepId = reviewStepId(input.phase, input.round);
  switch (input.phase) {
    case "review":
      return [
        "Diff this card's branch against its base ref (its worktree base) and review only what changed.",
        "Record the exact commit you reviewed as `reviewedSha`.",
        "Report every problem as a finding with a stable `id`, a `severity` of `critical`, `improvement` or `nitpick`, the `file` and `line`, a `title` and a `detail`.",
        "Critical and improvement findings block the round; nitpicks never do — if there are no blocking findings the loop ends here.",
        `Complete this step by calling board_complete_step with stepId "${stepId}", a succeeded outcome, and a JSON payload { reviewedSha, findings: [...] }.`,
        "If you cannot produce a valid findings payload, complete the step with outcome failed instead — never complete succeeded with an empty or malformed payload.",
      ].join(" ");
    case "triage":
      return [
        "For each blocking finding from this round's review, either FIX it in the worktree or REJECT it with a specific reason.",
        "Make the smallest correct change and run the project's checks before finishing.",
        "Record the commit you produced as `fixedSha`.",
        `Complete this step by calling board_complete_step with stepId "${stepId}", a succeeded outcome, and a JSON payload { fixedSha, dispositions: [{ findingId, action: "fixed" | "rejected", note }] }.`,
      ].join(" ");
    case "adjudicate":
      return [
        "Rule on this round's triage. Scope yourself to exactly what changed between the review's `reviewedSha` and the triage's `fixedSha`.",
        "For each finding, decide whether a claimed fix holds and whether a rejection is justified.",
        "You cannot see problems a fix introduced — only the next review can — so do not re-review the whole branch.",
        `Complete this step by calling board_complete_step with stepId "${stepId}", a succeeded outcome, and a JSON payload { verdicts: [{ findingId, verdict, note }] } where verdict is one of fix-upheld, fix-incomplete, fix-absent, rejection-justified, rejection-unjustified.`,
      ].join(" ");
  }
}

/**
 * Compose a review phase's agent prompt (D6/D7): the phase preamble, the
 * user's per-phase intent prompt, then the protocol. The executor owns the
 * loop protocol and wraps the user's per-phase prompt with it.
 */
export function composeBoardReviewPhasePrompt(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
  readonly rounds: number;
  readonly prompt: string;
}): string {
  return [boardReviewPhasePreamble(input), input.prompt.trim(), boardReviewPhaseProtocol(input)]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

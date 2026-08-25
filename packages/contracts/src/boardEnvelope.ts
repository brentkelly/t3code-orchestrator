/**
 * T3o prompt envelope (D5) — the system-owned wrapper around every board run
 * prompt, in contracts so the server (which composes the real run prompt) and
 * the settings UI (which shows the user exactly what wraps their editable
 * prompt) can never drift.
 *
 * The envelope carries the protocol a run MUST follow — orientation, the
 * completion contract, progress reporting, the question mechanism and the
 * role-keyed deliverable segments (a `plan` stage records its plan with
 * `board_propose_plans`; no stage ever moves its own card). The editable
 * per-stage prompt carries only intent, so a user rewrite can slow a stage
 * down but never break the board.
 *
 * STEP VOCABULARY IS CONDITIONAL (t3o-19, D1/D4). Steps are the general unit —
 * the executor seam, the `(cardId, stepId)` completion ledger and
 * `completedStepIds` are all multi-step by construction — but every stage
 * except the review loop runs exactly one, whose id IS the stage id and whose
 * label IS the stage label. Rendering that produced a tautology
 * (`Stage: planning. Step: Planning.`), so a null `stepLabel` means "this stage
 * has no steps" and the envelope says nothing about them: no `Step:` line, and
 * a completion instruction that names no id. A stepped stage keeps the full
 * vocabulary and is told its `stepId` outright, which is what non-review stages
 * never were — they only ever completed because the tautological stage line
 * happened to print a string equal to their step id.
 *
 * Everything here is pure string composition: no SQL, no git, no thread
 * handles — unit-testable without a server, and safe to import from the web.
 */
import type { BoardReviewPhaseId, BoardStageRole } from "./board.ts";
import { BOARD_REVIEW_PHASE_LABELS } from "./board.ts";

/**
 * The wording for "ask through your question tool, never in prose" (D5).
 * Deliberately provider-NEUTRAL: the envelope is composed once and read by
 * whichever runtime the stage happens to run on, and naming one vendor's
 * mechanism ("Codex's ask-for-input request") is wrong for every other
 * provider — and reads as wrong even to the one it names, when the user has
 * pointed that stage at a different runtime.
 */
export const BOARD_ENVELOPE_QUESTION_MECHANISM =
  "raise it through your runtime's user-input request so it surfaces as a real prompt";

/** The stance-independent guard appended to every postamble: `board_move_card`
    is agent-reachable, so the envelope — not the editable prompt — forbids it.
    Worded to hold on every stance: an auto-advancing stage moves the card
    itself, a paused or manual one waits for a human. Step-neutral (t3o-19, D1),
    so it reads correctly on a stage with no steps. */
export const BOARD_ENVELOPE_MOVE_GUARD =
  "Never move the card between stages yourself; finish your work and the board or a human moves the card on.";

/** The `plan` role's deliverable contract (role-keyed so a user rewrite of the
    editable Planning prompt cannot break the plan pipeline). */
export const BOARD_ENVELOPE_PLAN_DELIVERABLE =
  "When the plan is agreed, record it with board_propose_plans.";

/** The frozen execution config a spawn needs, read off the step-state run row
    (D12). */
export interface ComposeStepPromptStep {
  /** The completion ledger key. Always present — the ledger needs it even for a
      stage with no steps — but stated to the agent only when `stepLabel` is
      non-null (t3o-19, D3/D4). */
  readonly stepId: string;
  /** The step's label, or null when this stage has no steps (t3o-19, D4). The
      presence of the identity IS the signal; there is no separate flag. */
  readonly stepLabel: string | null;
  readonly prompt: string;
  /** Frozen human-in-the-loop stance (D5): governs the postamble. */
  readonly humanInLoop: boolean;
}

export interface ComposeStepPromptInput {
  readonly card: { readonly key: string; readonly title: string; readonly stage: string };
  /** The stage's human label, frozen onto the run row at stage entry (t3o-19,
      D5). Null on a legacy row that predates the freeze, where the stage id is
      the only name available. */
  readonly stageLabel: string | null;
  readonly step: ComposeStepPromptStep;
  /** The stage's effective role: keys the deliverable postamble segment. */
  readonly role: BoardStageRole | null;
}

/** How the agent is told to name its step on the completion call (t3o-19, D3).
    A stage with no steps names none: `stepId` is optional on the tool and the
    board resolves the caller's live step from its thread. */
function completionCall(step: Pick<ComposeStepPromptStep, "stepId" | "stepLabel">): string {
  return step.stepLabel === null
    ? "board_complete_step"
    : `board_complete_step with stepId "${step.stepId}"`;
}

/** The system preamble (D5) — short by design: a pointer to
    `board_get_card_context` exists so context is pulled, not pushed.
    It carries NO attempt counter: the retry ladder is supervisor bookkeeping,
    and "attempt 3 of 5" tells an agent nothing it can act on (the reason the
    prior attempts ended is in `board_get_card_context`, not in the number) —
    on a human-in-the-loop stage it is not even a number the run will reach.

    The stage is named by its LABEL, not its id (t3o-19, D5): a custom stage's
    id is a UUID (`BoardPipelineSection` mints `randomUUID()`), so printing the
    id put `Stage: 3f2a1b9c-…` into that stage's system prompt. */
export function boardStepPreamble(
  input: Pick<ComposeStepPromptInput, "card" | "stageLabel"> & {
    readonly step: Pick<ComposeStepPromptStep, "stepLabel">;
  },
): string {
  const { card, step } = input;
  const stage = input.stageLabel ?? card.stage;
  return [
    `You are working card ${card.key}, titled "${card.title}".`,
    step.stepLabel === null ? `Stage: ${stage}.` : `Stage: ${stage}. Step: ${step.stepLabel}.`,
    `Call board_get_card_context for the brief, plan, dependencies and prior progress.`,
  ].join("\n");
}

/** The system postamble (D5): branches on human-in-the-loop (an unattended run
    carries the `/unattended` stance; a human-in-the-loop run is
    question-friendly), then appends the role-keyed deliverable segment and the
    move guard. The completion sentence names a `stepId` only on a stepped stage
    (t3o-19, D3/D6) — and it is the ONE place that names it, so a review agent
    is not told the same id twice. */
export function boardStepPostamble(input: {
  readonly humanInLoop: boolean;
  readonly role: BoardStageRole | null;
  readonly step: Pick<ComposeStepPromptStep, "stepId" | "stepLabel">;
}): string {
  const { step } = input;
  const call = completionCall(step);
  const stance = input.humanInLoop
    ? [
        // Human-in-the-loop envelopes carry no todo-list nudge (t3o-18 D16,
        // preserving t3o-17 AC 6's asymmetry): these runs are not
        // stall-supervised and the human is already in the conversation.
        `This is a human-in-the-loop run: ask me anything you need directly, and it is fine to end a turn waiting on my answer.`,
        `When the work is done, call ${call}.`,
      ]
    : [
        `You are running unattended. Do not stop to ask permission; make every reasonable decision yourself and proceed.`,
        step.stepLabel === null
          ? `When the work is done, call ${call}. That is the ONLY way to finish; ending your turn any other way is treated as a failure and recovered.`
          : `When this step is finished, call ${call}. That is the ONLY way to finish; ending your turn any other way is treated as a failure and recovered.`,
        // The todo-list line (t3o-18 D16) replaced t3o-17's
        // `board_report_progress` instruction: the supervisor's progress signal
        // watches the agent's own plan tool advance, so this nudges a behaviour
        // the agent already wants rather than an extra MCP call.
        `Keep a todo list current as you work (your task/plan tool) and commit as you go: the supervisor watches your list advance to tell a productive long job from a wedged one, and without it a working agent looks the same as a stalled one and will be escalated.`,
        `If you are truly blocked and need a human decision, ${BOARD_ENVELOPE_QUESTION_MECHANISM}; never end a turn with an unanswered question in prose.`,
      ];
  const deliverable = input.role === "plan" ? [BOARD_ENVELOPE_PLAN_DELIVERABLE] : [];
  return [...stance, ...deliverable, BOARD_ENVELOPE_MOVE_GUARD].join("\n");
}

/**
 * The full run prompt (D5): preamble + body + postamble. An empty body is a
 * re-entry (D7) — a clean conversational thread with just the orientation and
 * the human-in-the-loop stance.
 */
export function composeStepPrompt(input: ComposeStepPromptInput): string {
  const preamble = boardStepPreamble(input);
  const postamble = boardStepPostamble({
    humanInLoop: input.step.humanInLoop,
    role: input.role,
    step: input.step,
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
  const header = `Code review, ${BOARD_REVIEW_PHASE_LABELS[phase]} phase, round ${round} of up to ${rounds}.`;
  const priorContext =
    round > 1 || phase !== "review"
      ? "Call board_get_card_context first and read the `steps` payloads: they carry every prior phase's findings, dispositions and verdicts for this card."
      : "";
  return priorContext.length > 0 ? `${header}\n${priorContext}` : header;
}

/** A review phase's forced MACHINE CONTRACT (t3o-20, rebalanced) — the one
    t3o-specific thing the executor owns and the user must not edit away: the
    `board_complete_step` payload shape it parses to gate convergence (D4). The
    review CRAFT, the safety stance and the PR workflow are NOT here — they live
    in the user-editable phase prompt, so a user can reword any of it (including
    the untrusted-input wording) without breaking the loop. Pure text; it names
    no step id or completion tool (t3o-19, D6): the envelope's postamble states
    both for every stepped stage. */
export function boardReviewPhaseProtocol(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
}): string {
  switch (input.phase) {
    case "review":
      return [
        "To finish this phase, complete with a succeeded outcome and a JSON payload { reviewedSha, findings: [{ id, severity, file, line, title, detail }] }, where `severity` is `critical`, `improvement` or `nitpick`.",
        "Critical and improvement findings are blocking; nitpicks never are. Whether the loop runs another round is decided by the system from the severities you record, never by you — report what you found and stop.",
        "If you cannot produce a valid findings payload, complete with outcome failed instead. Never complete succeeded with an empty or malformed payload.",
      ].join(" ");
    case "triage":
      return 'To finish this phase, complete with a succeeded outcome and a JSON payload { fixedSha, dispositions: [{ findingId, action: "fixed" | "rejected", note }] }.';
    case "adjudicate":
      return "To finish this phase, complete with a succeeded outcome and a JSON payload { verdicts: [{ findingId, verdict, note }] }, where `verdict` is one of fix-upheld, fix-incomplete, fix-absent, rejection-justified, rejection-unjustified.";
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

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
import type {
  BoardCardPullRequest,
  BoardReviewCarriedFinding,
  BoardReviewFollowUpFinding,
  BoardReviewFollowUpPhase,
  BoardReviewPhaseId,
  BoardStageRole,
} from "./board.ts";
import {
  BOARD_REVIEW_STEP_PHASE_LABELS,
  parseReviewStepId,
  BOARD_CI_FIX_PAYLOAD_SHAPE,
  BOARD_CI_AGENT_PAYLOAD_SHAPE,
  BOARD_BUILD_SUMMARY_PAYLOAD_SHAPE,
  BOARD_REVIEW_PHASE_LABELS,
  DEFAULT_BOARD_SYNC_PHASE_PROMPT,
} from "./board.ts";

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

/** The decision log (T3O-32), stated on every planning run, attended or
    not, so the log exists however the plan was reached. */
export const BOARD_ENVELOPE_DECISION_LOG =
  "Before you call board_propose_plans, record every decision this planning session made with board_record_decisions: what was asked, what was decided, a one-line reason and who decided (agent, or human when the user answered). Flag a call you were not sure about as unclear, and a call that shapes the work as important.";

/** What an auto-planned run is told (T3O-32, T3O-38): no more questions.
    Rides the postamble of a fresh auto-plan run and is the steering turn sent
    into a live planning thread, followed by what happens to the plan — use
    `boardAutoPlanInstruction`. */
export const BOARD_AUTO_PLAN_INSTRUCTION =
  "Auto-plan: stop interviewing and do not ask any more questions. Decide every remaining question yourself, record each decision with board_record_decisions (flag any you are unsure of as unclear), propose the plan with board_propose_plans, then call board_complete_step.";

/** The full auto-plan instruction: with Auto-build on the plan is approved and
    built without a human; without it the plan waits for the user's approval. */
export function boardAutoPlanInstruction(autoBuild: boolean): string {
  return autoBuild
    ? `${BOARD_AUTO_PLAN_INSTRUCTION} Auto-build is on: the plan you propose is approved and built automatically, unclear decisions included, so make each call the way you would defend it in review.`
    : `${BOARD_AUTO_PLAN_INSTRUCTION} Your plan will be presented to the user for approval, so make each call the way you would defend it in review.`;
}

/** Sent into a planning thread when Auto-plan is turned off mid-run (T3O-38). */
export const BOARD_AUTO_PLAN_OFF_INSTRUCTION =
  "The user is back: Auto-plan is off. You may ask questions again, and it is fine to end a turn waiting on an answer. Your plan will be presented to the user for approval.";

/** The `plan` role's deliverable contract (role-keyed so a user rewrite of the
    editable Planning prompt cannot break the plan pipeline).

    T3o card 11: it also states what a SECOND plan means. The planning agent was
    never told that `board_propose_plans` is the card-splitting mechanism — the
    tool advertises an array with a dependency graph, so decomposition read as
    the expected output, and the cost (child cards behind a human approval gate
    that hard-blocks every forward move) was invisible at the point of call.
    Stating it here rather than in `DEFAULT_BOARD_PLANNING_PROMPT` is deliberate:
    a user who has already customised their Planning prompt still gets the rule,
    and no rewrite can delete it. */
export const BOARD_ENVELOPE_PLAN_DELIVERABLE = [
  BOARD_ENVELOPE_DECISION_LOG,
  "When the plan is agreed, record it with board_propose_plans, as ONE plan.",
  "Two or more plans is not a longer plan — it splits this card into that many child cards, each with its own branch, build and code review, and holds the card behind a human approval gate until someone approves it.",
  "Split only when this card is a large feature whose parts are worth building and reviewing one at a time, or whose parts could be built concurrently for a real speed-up; then pass splitRationale saying why.",
  "A bug fix, a contained change, or work that is merely long is one plan with several sections.",
  "In a split, mark each plan planned: true when it is a full implementation plan, or planned: false when it is a brief that still needs planning, and pass recommendedAutoBuild and recommendedMergeTarget: every child fully planned → auto-build on with its own branch; an epic breakdown → auto-build off, inherit; already inside a group with its own branch → prefer inherit.",
].join(" ");

/** The `build` role's deliverable contract (T3O-21): the structured payload
    the Summary pane renders. Forced here, not in the editable Build prompt, so
    no user rewrite can drop it — the completion handler refuses a succeeded
    build without it. */
export const BOARD_ENVELOPE_BUILD_DELIVERABLE = [
  `Complete a succeeded build with a JSON payload ${BOARD_BUILD_SUMMARY_PAYLOAD_SHAPE}, and put the same \`lead\` sentence in \`summary\`.`,
  "`lead` is one sentence covering what was built, the branch, the commit count and whether it is pushed.",
  "`notes` holds every plan change, unfinished item and shortcut — `kind` is plan_change, not_done or shortcut, with optional `detail` — and these never go in `areas`.",
  "`checks` lists every check or test suite you ran or deliberately skipped, with `status` pass, not_run, fail_preexisting or fail; use fail_preexisting only for a failure this card did not cause, and say why in `detail`.",
  "`areas` groups what was built under names like Data, API, Site core, Panel or Docs, each item one short line.",
  "Wrap code identifiers in backticks. If you cannot produce the payload, complete with outcome failed instead.",
].join(" ");

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
  /** An auto-planned planning run (T3O-32). */
  readonly autoPlan?: boolean;
  /** With `autoPlan`: Auto-build is on, so the plan is approved and built. */
  readonly autoBuild?: boolean;
  /** The plan review this step is running (plan review, T3O-39): set once a
      review has started, so a respawned or nudged thread resumes it. */
  readonly planReview?: { readonly instructions: string };
}

export interface ComposeStepPromptInput {
  readonly card: {
    readonly key: string;
    readonly title: string;
    readonly stage: string;
    /** The card's effective base branch (T3O-5, D9) — what its work branches
        off and merges back into, resolved through
        `resolveBoardCardEffectiveBase`. Null when it could not be resolved (no
        workspace, an unresolvable default), in which case the envelope says
        nothing rather than interpolating placeholder English as a branch name. */
    readonly baseBranch?: string | null;
    /** The card's pull request. Only an explicitly LINKED one (T3O-18) is
        stated: its head may be another branch than the card's own worktree,
        and the review prompt otherwise tells the agent to open a pull request
        on the card's branch. */
    readonly pullRequest?: Pick<BoardCardPullRequest, "number" | "headBranch" | "linked"> | null;
  };
  /** The stage's human label, frozen onto the run row at stage entry (t3o-19,
      D5). Null on a legacy row that predates the freeze, where the stage id is
      the only name available. */
  readonly stageLabel: string | null;
  readonly step: ComposeStepPromptStep;
  /** The stage's effective role: keys the deliverable postamble segment. */
  readonly role: BoardStageRole | null;
  /** The Code review stage's open-as-draft setting (T3O-12). Only a
      `build`-role step reads it: a build agent, or a skill it calls, may open
      the pull request before the review loop does. */
  readonly draftPullRequests?: boolean;
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
    readonly step: Pick<ComposeStepPromptStep, "stepLabel"> & {
      readonly stepId?: string | undefined;
    };
    /** The stage's effective role (T3O-5, D9): only a `plan`-role step gets the
        project-root caveat on the base-branch line. */
    readonly role?: BoardStageRole | null;
  },
): string {
  const { card, step } = input;
  const stage = input.stageLabel ?? card.stage;
  return [
    `You are working card ${card.key}, titled "${card.title}".`,
    step.stepLabel === null ? `Stage: ${stage}.` : `Stage: ${stage}. Step: ${step.stepLabel}.`,
    ...boardBaseBranchLines({ baseBranch: card.baseBranch ?? null, role: input.role ?? null }),
    ...boardLinkedPullRequestLines(card.pullRequest ?? null),
    // A review step reads with fresh eyes (T3O-51): earlier rounds' findings
    // and rulings are triage's and the adjudicator's to weigh, not the
    // reviewer's, so the pointer stops at the brief.
    parseReviewStepId(step.stepId ?? "")?.phase === "review"
      ? `Call board_get_card_context for the brief only. Do not read earlier review rounds: judge the code as it stands.`
      : `Call board_get_card_context for the brief, plan, dependencies and prior progress.`,
  ].join("\n");
}

/**
 * The base-branch orientation line (T3O-5, D9), stated on EVERY stage — one
 * sentence that answers all three of the brief's pipeline requirements at once.
 *
 * Code review needs it most: the shipped review prompt already says "opening one
 * against its base ref if none exists", and without this the agent has to dig
 * that out of the context JSON and hope. Building is already checked out on a
 * branch cut from it, so the line is harmless reinforcement there.
 *
 * A `plan`-role step gets a second clause. Plan-mode steps run in the PROJECT
 * WORKSPACE ROOT with no branch of their own (`admitPlanStep`), so the agent
 * reads whatever the root happens to have checked out — which may not be the
 * code the card will change.
 */
function boardBaseBranchLines(input: {
  readonly baseBranch: string | null;
  readonly role: BoardStageRole | null;
}): ReadonlyArray<string> {
  if (input.baseBranch === null) return [];
  const caveat =
    input.role === "plan"
      ? " You are reading the project workspace root, which may have a different branch checked out, so plan against that base rather than whatever is checked out here."
      : "";
  return [
    `This card's base branch is \`${input.baseBranch}\` — its work branches off and merges back into that.${caveat}`,
  ];
}

/**
 * The linked pull request line (T3O-18). A card linked to a pull request it
 * did not open (a review card per stack layer) is still given its own
 * `board/<key>` worktree, which may not be that pull request's branch, and the
 * shipped review prompt says to open a pull request if the card's branch has
 * none. This names the pull request the work is actually about.
 */
function boardLinkedPullRequestLines(
  pullRequest: Pick<BoardCardPullRequest, "number" | "headBranch" | "linked"> | null,
): ReadonlyArray<string> {
  if (pullRequest?.linked !== true) return [];
  return [
    `This card is linked to pull request #${pullRequest.number}, whose head branch is \`${pullRequest.headBranch}\`. That pull request is this card's work: read, review and push fixes to \`${pullRequest.headBranch}\` (your worktree may be on a different branch), and never open a new pull request for this card.`,
  ];
}

/** Regrouping needs a human (T3O-27): an unattended run has no one to confirm
    it, so it never regroups. */
export const BOARD_ENVELOPE_REGROUP_GUARD =
  "Do not regroup cards (move them between groups, indent, outdent, group them, or change a group's settings) without a human's explicit confirmation.";

/** The system postamble (D5): branches on human-in-the-loop (an unattended run
    carries the `/unattended` stance; a human-in-the-loop run is
    question-friendly), then appends the role-keyed deliverable segment and the
    move guard. The completion sentence names a `stepId` only on a stepped stage
    (t3o-19, D3/D6) — and it is the ONE place that names it, so a review agent
    is not told the same id twice. */
/** What a step does when it is truly blocked (T3O-55), as one sentence.
    Triage and adjudication never reach a human that way: triage fixes or
    rejects each finding, and only the adjudicator escalates one. */
export function boardBlockedInstruction(stepId: string): string {
  switch (parseReviewStepId(stepId)?.phase) {
    case "triage":
    case "retriage":
      return "Nobody will answer a question here: never raise a user-input request or complete blocked. Fix each finding, or reject it with your reasoning; the adjudicator decides whether a human is needed.";
    case "adjudicate":
    case "readjudicate":
      return "Nobody will answer a question here: never raise a user-input request or complete blocked. Rule on every finding yourself, and give the `escalated` verdict, with your reason, only to a finding that genuinely needs a human.";
    default:
      return `If you are truly blocked and need a human decision, ${BOARD_ENVELOPE_QUESTION_MECHANISM}; never end a turn with an unanswered question in prose.`;
  }
}

export function boardStepPostamble(input: {
  readonly humanInLoop: boolean;
  readonly role: BoardStageRole | null;
  readonly step: Pick<ComposeStepPromptStep, "stepId" | "stepLabel">;
  /** An auto-planned planning run (T3O-32). */
  readonly autoPlan?: boolean;
  /** With `autoPlan`: the plan is approved and built without a human. */
  readonly autoBuild?: boolean;
}): string {
  const { step } = input;
  const call = completionCall(step);
  const stance = input.humanInLoop
    ? [
        // Human-in-the-loop envelopes carry no progress instruction (t3o-17
        // AC 6's asymmetry): these runs are not stall-supervised and the human
        // is already in the conversation.
        `This is a human-in-the-loop run: ask me anything you need directly, and it is fine to end a turn waiting on my answer.`,
        `When the work is done, call ${call}.`,
      ]
    : [
        `You are running unattended. Do not stop to ask permission; make every reasonable decision yourself and proceed.`,
        step.stepLabel === null
          ? `When the work is done, call ${call}. That is the ONLY way to finish; ending your turn any other way is treated as a failure and recovered.`
          : `When this step is finished, call ${call}. That is the ONLY way to finish; ending your turn any other way is treated as a failure and recovered.`,
        // No todo-list ask (T3O-22): Claude Code dropped its todo tools on
        // Claude 5-era models, so asking for one made agents report a missing
        // tool. The supervisor still reads a plan tool when a provider emits one.
        `Commit as you go: the supervisor watches for new commits and activity to tell a productive long job from a wedged one, and a run that shows neither will be nudged and eventually escalated.`,
        boardBlockedInstruction(step.stepId),
        BOARD_ENVELOPE_REGROUP_GUARD,
      ];
  const deliverable =
    input.role === "plan"
      ? input.autoPlan === true
        ? [BOARD_ENVELOPE_PLAN_DELIVERABLE, boardAutoPlanInstruction(input.autoBuild === true)]
        : [BOARD_ENVELOPE_PLAN_DELIVERABLE]
      : input.role === "build"
        ? [BOARD_ENVELOPE_BUILD_DELIVERABLE]
        : [];
  return [...stance, ...deliverable, BOARD_ENVELOPE_MOVE_GUARD].join("\n");
}

/**
 * The full run prompt (D5): preamble + body + postamble. An empty body is a
 * re-entry (D7) — a clean conversational thread with just the orientation and
 * the human-in-the-loop stance.
 */
export function composeStepPrompt(input: ComposeStepPromptInput): string {
  const preamble = boardStepPreamble({ ...input, role: input.role });
  const postamble = boardStepPostamble({
    humanInLoop: input.step.humanInLoop,
    role: input.role,
    step: input.step,
    ...(input.step.autoPlan === true ? { autoPlan: true } : {}),
    ...(input.step.autoBuild === true ? { autoBuild: true } : {}),
  });
  // The build draft line (T3O-12) rides on the body, so an empty-body
  // re-entry (D7) stays the clean conversational thread it is.
  const body = input.step.prompt;
  const draftLine =
    input.role === "build" && input.draftPullRequests === true
      ? `\n\n${BOARD_DRAFT_PULL_REQUEST_BUILD}`
      : "";
  const bodyBlock = body.trim().length > 0 ? `${body}${draftLine}\n\n` : "";
  const reviewBlock =
    input.role === "plan" && input.step.planReview !== undefined
      ? `${input.step.planReview.instructions}\n\n`
      : "";
  return `${preamble}\n\n${bodyBlock}${reviewBlock}${postamble}`;
}

/** Substitute every `{rounds}` in a plan-review prompt. */
export function fillPlanReviewRounds(prompt: string, rounds: number): string {
  return prompt.replaceAll("{rounds}", String(rounds));
}

/** The fixed lead of the plan-review instructions (plan review, T3O-39). */
export function planReviewInstructionsLead(rounds: number): string {
  const roundWord = rounds === 1 ? "round" : "rounds";
  return `Plan review is on for this card: up to ${rounds} ${roundWord} of adversarial review, run inside this thread.`;
}

/** The fixed closing of the plan-review instructions: the board mechanics,
    after the user's prompt and taking precedence over it. */
export function planReviewInstructionsClosing(input: {
  readonly rounds: number;
  /** A human is in the loop and no auto-plan is pending. */
  readonly humanInLoop: boolean;
}): string {
  const finish = input.humanInLoop
    ? `With a human in the loop: if you need a human decision, ${BOARD_ENVELOPE_QUESTION_MECHANISM}. Then summarise the final plan in the thread, wait for the human's sign-off, and only then call board_complete_step.`
    : "This run is unattended: ask nothing. Decide every question yourself, flag a call you are unsure of as unclear with board_record_decisions, summarise the final plan in the thread, then call board_complete_step without waiting.";
  return [
    "Board rules for the plan review. These come after the text above and take precedence over it:",
    `- ${input.rounds} is a maximum. Stop as soon as a round produces no new substantive finding, and record that call (rounds run, converged or not) with board_record_decisions.`,
    "- Run the reviewers in the foreground and do not end your turn while waiting for them.",
    "- If your runtime cannot spawn subagents, run each reviewer pass yourself in turn, and say so in the thread.",
    "- Post each reviewer's findings in the thread, and record any new decisions with board_record_decisions.",
    "- If the plan changed, re-propose the final plan with board_propose_plans (that does not start another review). If board_propose_plans refuses because the plans are frozen, stop reviewing and summarise.",
    "- When you call board_complete_step, add `planReview: { roundsRun, converged }` to the payload.",
    `- ${finish}`,
    "- If an auto-plan instruction arrives during the review, it overrides this text: stop asking and finish.",
  ].join("\n");
}

/**
 * The plan-review instructions (plan review, T3O-39): a fixed lead, the user's
 * editable prompt with `{rounds}` filled in, and a fixed closing that comes
 * after it and wins over it. The closing carries the board mechanics, so no
 * rewrite of the prompt can remove them.
 */
export function composePlanReviewInstructions(input: {
  readonly prompt: string;
  readonly rounds: number;
  /** A human is in the loop and no auto-plan is pending: ask, then wait for
      sign-off. Otherwise the review finishes without asking anything. */
  readonly humanInLoop: boolean;
}): string {
  return [
    planReviewInstructionsLead(input.rounds),
    fillPlanReviewRounds(input.prompt, input.rounds),
    planReviewInstructionsClosing(input),
  ].join("\n\n");
}

/** Leads the turn sent when a human turns plan review on after the plan was
    posted (plan review, T3O-39). The review instructions follow it. */
export const BOARD_PLAN_REVIEW_LATE_START_LEAD =
  "Plan review was turned on after you posted the plan. Review the plan you proposed now, as below.";

/** Leads the turn sent when a human changes a running plan review's rounds
    (T3O-50). Only the agent knows how many it has run, so it decides. */
export function boardPlanReviewRoundsChangedLead(rounds: number): string {
  return `The plan review limit is now ${rounds} ${rounds === 1 ? "round" : "rounds"} in total. If you have already run ${rounds} or more, stop reviewing: summarise what the reviews found, re-propose the plan with board_propose_plans if it changed, and finish as normal. Otherwise continue until you reach ${rounds}, as below.`;
}

/** The turn sent into a planning thread when a human turns its running plan
    review off (plan review, T3O-39). */
export const BOARD_PLAN_REVIEW_STOP_INSTRUCTION =
  "Stop the plan review now: summarise what the reviews found so far, re-propose the plan with board_propose_plans if it changed, and finish as normal.";

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
  // The reviewer is fresh-eyes on every round (T3O-51): only triage and the
  // adjudicator read the history.
  const priorContext =
    phase !== "review"
      ? "Call board_get_card_context first and read the `steps` payloads: they carry every prior phase's findings, dispositions and verdicts for this card."
      : "";
  return priorContext.length > 0 ? `${header}\n${priorContext}` : header;
}

/** The rule that keeps the adjudicator consistent across rounds (T3O-51). */
export const BOARD_REVIEW_ADJUDICATOR_CONSISTENCY =
  "A finding ruled rejection-justified in an earlier round stays settled unless later commits changed the code it concerns; overturning it requires naming that change in your note.";

function boardReviewFindingLine(finding: {
  readonly id: string;
  readonly severity: string;
  readonly title: string;
  readonly file: string | null;
  readonly line: number | null;
}): string {
  const where =
    finding.file === null
      ? ""
      : ` (${finding.file}${finding.line === null ? "" : `:${finding.line}`})`;
  return `- \`${finding.id}\` [${finding.severity}] ${finding.title}${where}`;
}

/** The human's dismissals, listed to the reviewer, triage and the adjudicator
    as final rulings (T3O-51). Empty when there are none. */
export function boardReviewDismissalsBlock(input: {
  readonly phase: BoardReviewPhaseId | BoardReviewFollowUpPhase;
  readonly dismissals: ReadonlyArray<BoardReviewCarriedFinding & { readonly round: number }>;
}): string {
  if (input.dismissals.length === 0) return "";
  const lines = input.dismissals.map(
    (d) =>
      `${boardReviewFindingLine({ id: d.findingId, severity: d.severity, title: d.title, file: d.file, line: d.line })} — dismissed by a human in round ${d.round}`,
  );
  const rule =
    input.phase === "review"
      ? "A human ruled these are not issues. Do not raise them again."
      : input.phase === "triage" || input.phase === "retriage"
        ? "A human ruled these are not issues; the ruling is final. If one is raised again, reject it citing the human ruling."
        : "A human ruled these are not issues; the ruling is final. If one is raised again and triage rejected it, rule rejection-justified.";
  return [rule, ...lines].join("\n");
}

/** The carried "fix" findings a round must resolve (T3O-51), for triage and
    the adjudicator. The reviewer is not told: the board adds them itself. */
function boardReviewCarriedBlock(input: {
  readonly phase: BoardReviewPhaseId;
  readonly carried: ReadonlyArray<BoardReviewFollowUpFinding>;
}): string {
  if (input.carried.length === 0 || input.phase === "review") return "";
  const lines = input.carried.map((c) => {
    const detail = c.finding.detail.trim();
    return `${boardReviewFindingLine(c.finding)}${detail.length > 0 ? `\n  ${detail}` : ""}`;
  });
  const rule =
    input.phase === "triage"
      ? "A human ordered these findings fixed this round. They are blocking and must-fix: fix each one and give a disposition for every id below. Reject one only if it genuinely cannot be done, with a note saying why."
      : "A human ordered these findings fixed this round. Give a verdict for every id below; only fix-upheld, fix-incomplete or fix-absent apply to them.";
  return [rule, ...lines].join("\n");
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
      return [
        'To finish this phase, complete with a succeeded outcome and a JSON payload { fixedSha, dispositions: [{ findingId, action: "fixed" | "rejected", note }] }.',
        "You may reject a finding raised again by citing an earlier round's justified rejection or a human dismissal, unless later fixes changed the picture.",
        BOARD_REVIEW_TRIAGE_NEVER_ASKS,
      ].join(" ");
    case "adjudicate":
      return [
        "To finish this phase, complete with a succeeded outcome and a JSON payload { verdicts: [{ findingId, verdict, note }], anotherRound }, where `verdict` is one of fix-upheld, fix-incomplete, fix-absent, rejection-justified, rejection-unjustified, escalated.",
        BOARD_REVIEW_ADJUDICATOR_CONSISTENCY,
        "Set `anotherRound` to false only if this round raised nothing new beyond points already settled; otherwise true. The system ignores false if a blocking fix landed.",
        "A ruling against triage (rejection-unjustified, fix-absent or fix-incomplete) on a blocking finding sends it straight back to triage in this round for one more pass.",
        BOARD_REVIEW_ADJUDICATOR_ESCALATION,
      ].join(" ");
  }
}

/** A follow-up pass's forced machine contract (T3O-51). */
export function boardReviewFollowUpProtocol(phase: BoardReviewFollowUpPhase): string {
  return phase === "retriage"
    ? `To finish this step, complete with a succeeded outcome and a JSON payload { fixedSha, dispositions: [{ findingId, action: "fixed" | "rejected", note }] }, with a disposition for every listed id. ${BOARD_REVIEW_TRIAGE_NEVER_ASKS}`
    : `To finish this step, complete with a succeeded outcome and a JSON payload { verdicts: [{ findingId, verdict, note }], anotherRound }, with a verdict for every listed id, where \`verdict\` is one of fix-upheld, fix-incomplete, fix-absent, rejection-justified, rejection-unjustified, escalated. Set \`anotherRound\` to false only if this round raised nothing new beyond points already settled; the system ignores false if a blocking fix landed. ${BOARD_REVIEW_ADJUDICATOR_ESCALATION}`;
}

/** Triage's forced never-ask rule (T3O-55). It sits in the machine contract,
    not the editable prompt, so it holds for a custom prompt too. */
const BOARD_REVIEW_TRIAGE_NEVER_ASKS =
  "Triage never stops for a human: never ask a question, raise a user-input request, or complete blocked. Every finding is fixed or rejected. Reject a finding that falls outside this card's brief, or needs a product or scope decision, saying so; this outranks any instruction above to reject only with concrete evidence, and the adjudicator decides whether a human is needed. Complete failed only if your tooling is broken: failed re-runs the step.";

/** The adjudicator's escalation rule (T3O-55): the only way a review finding
    reaches a human. */
const BOARD_REVIEW_ADJUDICATOR_ESCALATION =
  "Rule on every finding yourself. The `escalated` verdict hands a finding to a human and stops the loop; it does not send the finding back to triage. Use it only on a rejected blocking finding, and only when there is a genuine reason you cannot decide — a product or scope call the card's brief does not settle, or a risk only the owner can accept. Uncertainty or difficulty is not a reason: weigh the evidence and rule. Its note must say why a human is needed. Judge a scope or product rejection against the card's brief, not the code. Escalation is the only way to reach a human: never ask a question, raise a user-input request, or complete blocked.";

/**
 * Compose a follow-up pass's prompt (T3O-51): re-triage or re-adjudicate,
 * inside the same round, on just the findings the adjudicator overruled. It
 * reuses the triage or adjudicate phase's own prompt, behind a fixed
 * preamble naming the findings.
 */
export function composeBoardReviewFollowUpPrompt(input: {
  readonly phase: BoardReviewFollowUpPhase;
  readonly round: number;
  readonly rounds: number;
  /** The triage (for re-triage) or adjudicate (for re-adjudicate) prompt. */
  readonly prompt: string;
  readonly findings: ReadonlyArray<BoardReviewFollowUpFinding>;
  readonly dismissals?: ReadonlyArray<BoardReviewCarriedFinding & { readonly round: number }>;
  readonly draftPullRequests?: boolean;
}): string {
  const header = `Code review, ${BOARD_REVIEW_STEP_PHASE_LABELS[input.phase]} step, round ${input.round} of up to ${input.rounds}.\nCall board_get_card_context first and read the \`steps\` payloads: they carry every prior phase's findings, dispositions and verdicts for this card.`;
  const listed = input.findings.map((f) => {
    const lines = [boardReviewFindingLine(f.finding)];
    if (f.finding.carried) lines.push("  A human ordered this fixed.");
    if (f.triageAction !== null) {
      lines.push(
        `  Triage: ${f.triageAction}${f.triageNote.trim() === "" ? "" : ` — ${f.triageNote.trim()}`}`,
      );
    }
    if (f.rulingVerdict !== null) {
      lines.push(
        `  Ruling: ${f.rulingVerdict}${f.rulingNote.trim() === "" ? "" : ` — ${f.rulingNote.trim()}`}`,
      );
    }
    if (f.retriageAction !== null) {
      lines.push(
        `  Re-triage: ${f.retriageAction}${f.retriageNote.trim() === "" ? "" : ` — ${f.retriageNote.trim()}`}`,
      );
    }
    return lines.join("\n");
  });
  const anyCarried = input.findings.some((f) => f.finding.carried);
  const preamble =
    input.phase === "retriage"
      ? [
          "The adjudicator overruled you on these findings. Fix each if you can. Reject again only with a reason that directly answers the ruling, not the same argument; the adjudicator rules last. Give a disposition for every listed id.",
          anyCarried
            ? "For a finding a human ordered fixed, your earlier fix was ruled incomplete: complete the fix, or reject it with a note saying why it cannot be done."
            : "",
        ]
      : [
          `This is the final ruling before a human is called. Triage answered your ruling on these findings; weigh the new argument on its merits, and give a verdict for every listed id. ${BOARD_REVIEW_ADJUDICATOR_CONSISTENCY}`,
          anyCarried
            ? "For a finding a human ordered fixed, only fix-upheld, fix-incomplete or fix-absent apply."
            : "",
        ];
  return [
    header,
    ...preamble,
    listed.join("\n"),
    boardReviewDismissalsBlock({ phase: input.phase, dismissals: input.dismissals ?? [] }),
    input.prompt.trim(),
    input.draftPullRequests === true ? BOARD_DRAFT_PULL_REQUEST_KEEP : "",
    boardReviewFollowUpProtocol(input.phase),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

/** How to open a draft on each forge, and what to do around it (T3O-12).
    Written per forge, because the agent — not the board — opens the pull
    request. */
const boardDraftPullRequestHow = (sayWhere: string) =>
  `\`gh pr create --draft\` on GitHub, \`glab mr create --draft\` on GitLab, and on Forgejo or Gitea a title that starts with \`WIP: \`. If the pull request already exists, leave its draft state alone. If the forge refuses a draft (some plans do not offer them), open a normal pull request instead and ${sayWhere}. Never mark the pull request ready for review yourself — the board does that once the review converges.`;

/** The review phase's open-as-draft instruction (T3O-12). It outranks any
    skill's own default (such as /pullrequest opening a ready one). */
export const BOARD_DRAFT_PULL_REQUEST_OPEN = `Open this card's pull request as a DRAFT, whatever any skill or workflow you use would do by default: ${boardDraftPullRequestHow("say so in your summary")}`;

/** The build stage's draft line (T3O-12). Conditional, because a build step
    need not open a pull request at all — the review phase opens one if it
    did not. */
export const BOARD_DRAFT_PULL_REQUEST_BUILD = `If you open this card's pull request, yourself or through a skill such as /pullrequest, open it as a DRAFT, whatever that skill would do by default: ${boardDraftPullRequestHow("record it as a `shortcut` note in your payload")}`;

/** The line every later loop step carries while drafts are on (T3O-12): the
    fix commits the loop pushes must not start the repository's full CI. */
export const BOARD_DRAFT_PULL_REQUEST_KEEP =
  "If the pull request is a draft, leave it as a draft — the board marks it ready. If it is not a draft, do not convert it to one.";

/** The draft text a review-loop step carries, or null when drafts are off.
    Only the review phase opens a pull request, so only it gets the open-as-
    draft instruction; every other step just leaves the draft alone. */
export function boardDraftPullRequestLine(input: {
  readonly draftPullRequests: boolean;
  readonly phase: BoardReviewPhaseId | "sync";
}): string | null {
  if (!input.draftPullRequests) return null;
  return input.phase === "review" ? BOARD_DRAFT_PULL_REQUEST_OPEN : BOARD_DRAFT_PULL_REQUEST_KEEP;
}

/**
 * Compose a review phase's agent prompt (D6/D7): the phase preamble, the
 * user's per-phase intent prompt, then the protocol. The executor owns the
 * loop protocol and wraps the user's per-phase prompt with it. The draft line
 * (T3O-12) sits after the user's prompt so it overrides whatever PR workflow
 * that prompt names.
 */
export function composeBoardReviewPhasePrompt(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
  readonly rounds: number;
  readonly prompt: string;
  readonly draftPullRequests?: boolean;
  /** The CI failure that sent the card back (T3O-44): a must-fix finding for
      the review and triage of the round that follows. */
  readonly ciFinding?: { readonly stepName: string | null; readonly finding: string } | null;
  /** Findings a human carried into this round as must-fix (T3O-51). */
  readonly carried?: ReadonlyArray<BoardReviewFollowUpFinding>;
  /** Findings a human ruled not issues, at or before this round (T3O-51). */
  readonly dismissals?: ReadonlyArray<BoardReviewCarriedFinding & { readonly round: number }>;
}): string {
  const ci =
    input.ciFinding == null || input.phase === "adjudicate"
      ? ""
      : [
          `CI sent this card back to review${input.ciFinding.stepName === null ? "" : ` after its "${input.ciFinding.stepName}" step failed`}. Treat this as a blocking, must-fix finding this round${input.phase === "review" ? ": report it as a critical finding" : ": fix it"}, whatever else you find:`,
          input.ciFinding.finding.trim(),
        ].join("\n\n");
  return [
    boardReviewPhasePreamble(input),
    input.prompt.trim(),
    ci,
    boardReviewCarriedBlock({ phase: input.phase, carried: input.carried ?? [] }),
    boardReviewDismissalsBlock({ phase: input.phase, dismissals: input.dismissals ?? [] }),
    boardDraftPullRequestLine({
      draftPullRequests: input.draftPullRequests === true,
      phase: input.phase,
    }) ?? "",
    boardReviewPhaseProtocol(input),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

/**
 * Compose the sync-base step's agent prompt (t3o-24, D2): a round header, the
 * compiled-in rebase instructions with the card's concrete base ref, then the
 * completion protocol. Entirely machinery — no user-editable part — which is
 * why it does not ride `composeBoardReviewPhasePrompt`'s preamble/prompt/
 * protocol split over a settings-owned prompt.
 */
export function composeBoardSyncPhasePrompt(input: {
  readonly round: number;
  /** The card's recorded base branch (`worktree.baseRefName`) — the parent's
      integration branch for a sub-board child. Null when the card carries no
      worktree slice: the sentence is omitted (the agent resolves the base from
      its own checkout) rather than interpolating placeholder English into the
      prompt as if it were a branch name. */
  readonly baseRefName: string | null;
  /** The base the card is now TARGETED at, when a human retargeted it (T3O-5,
      D10) and it differs from `baseRefName`. Absent/null is the t3o-24 case:
      the same base, whose tip merely moved. The rebase machinery is identical
      either way; only the opening sentence differs, because "a sibling card
      merged into it" is simply false for a retarget. */
  readonly retargetedTo?: string | null;
  /** Drafts are on (T3O-12): the rebase's force-push must leave the draft be. */
  readonly draftPullRequests?: boolean;
}): string {
  const retargeted =
    input.retargetedTo != null && input.retargetedTo !== input.baseRefName
      ? input.retargetedTo
      : null;
  const header =
    retargeted !== null
      ? `Code review, Sync base step, after round ${input.round}. This card's base branch is now \`${retargeted}\`.`
      : input.baseRefName === null
        ? `Code review, Sync base step, after round ${input.round}.`
        : `Code review, Sync base step, after round ${input.round}. This card's base branch is \`${input.baseRefName}\`.`;
  const opening =
    retargeted !== null
      ? `This card's base branch has CHANGED: it was cut from \`${input.baseRefName ?? "its previous base"}\` and has been retargeted at \`${retargeted}\`, so the diff that was reviewed is no longer the diff that would merge. Your whole job is to rebase this card's branch onto \`${retargeted}\`, in this worktree.`
      : null;
  return [
    header,
    opening === null ? DEFAULT_BOARD_SYNC_PHASE_PROMPT : `${opening} ${boardSyncPhaseMechanics()}`,
    retargeted === null ? null : boardSyncPhasePullRequestRetarget(retargeted),
    boardDraftPullRequestLine({
      draftPullRequests: input.draftPullRequests === true,
      phase: "sync",
    }),
    "To finish this step, complete with a succeeded outcome and a JSON payload { rebasedSha } naming the commit the rebased branch now points at. One review round then runs on the rebased diff before the card can merge — never skip the rebase or complete succeeded without having pushed it.",
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

/**
 * The retarget's SECOND half (T3O-5): move the pull request too.
 *
 * Only ever appended on a retarget. A pull request opened before the retarget
 * still names the branch it was created against, and nothing in the board moves
 * it — the board opens no pull requests itself (the review phase's agent does,
 * "opening one against its base ref if none exists"), and the retarget round
 * does not cross the Done boundary, so no fresh one is opened either. Left
 * alone, the review reads a diff against the old base while the branch sits on
 * the new one, and the merge lands these commits on a branch the card is no
 * longer based on. The merge gate refuses exactly that, which is what makes
 * skipping this visible rather than silent.
 */
function boardSyncPhasePullRequestRetarget(retargetedTo: string): string {
  return `If this card's branch already has an OPEN pull request, retarget it at \`${retargetedTo}\` as well, once the rebase has landed — \`gh pr edit --base ${retargetedTo}\` on GitHub, or the equivalent for this repository's forge. Its base still names the branch it was opened against, and nothing else moves it. The board refuses to merge a pull request whose base disagrees with the branch the card was rebased onto, so a pull request left pointing at the old base strands the card at Ready for merge.`;
}

/** The rebase MECHANICS half of `DEFAULT_BOARD_SYNC_PHASE_PROMPT` — fetch,
    rebase, resolve preserving both sides, verify what it resolved, force-with-lease,
    abort clean and complete `failed` if unsafe. Correct verbatim for both
    triggers, so a retarget swaps only the opening sentence rather than forking
    the prompt (T3O-5, D10). Split by locating the first sentence boundary: the
    default prompt opens with exactly one sentence of WHY. */
function boardSyncPhaseMechanics(): string {
  const marker = "Fetch the base branch";
  const at = DEFAULT_BOARD_SYNC_PHASE_PROMPT.indexOf(marker);
  return at < 0 ? DEFAULT_BOARD_SYNC_PHASE_PROMPT : DEFAULT_BOARD_SYNC_PHASE_PROMPT.slice(at);
}

/**
 * A CI agent step's body (T3O-49): the board's prefix — where the card is in
 * CI and what ran before — then the project's own prompt, then how to report.
 * Nothing is forbidden: the prompt decides whether the agent may change code.
 */
export function composeBoardCiAgentStepPrompt(input: {
  readonly cardKey: string;
  readonly cardTitle: string;
  readonly briefExcerpt: string | null;
  readonly branch: string | null;
  readonly baseBranch: string | null;
  readonly pullRequestUrl: string | null;
  readonly stepName: string;
  readonly pass: number;
  readonly fixAttempt: number;
  readonly maxFixAttempts: number;
  readonly earlier: ReadonlyArray<{ readonly name: string; readonly status: string }>;
  readonly remaining: ReadonlyArray<string>;
  readonly prompt: string;
}): string {
  const where = [
    `Card ${input.cardKey} · ${input.cardTitle}`,
    `CI step "${input.stepName}" · pass ${input.pass} · fix ${input.fixAttempt} of ${input.maxFixAttempts}`,
    ...(input.branch === null
      ? []
      : [
          `Branch \`${input.branch}\`${input.baseBranch === null ? "" : `, based on \`${input.baseBranch}\``}.`,
        ]),
    ...(input.pullRequestUrl === null ? [] : [`Pull request: ${input.pullRequestUrl}`]),
    ...(input.earlier.length === 0
      ? []
      : [
          `Earlier steps this pass: ${input.earlier.map((step) => `${step.name} (${step.status})`).join(", ")}.`,
        ]),
    ...(input.remaining.length === 0
      ? []
      : [`Steps after this one: ${input.remaining.join(", ")}.`]),
    ...(input.briefExcerpt === null || input.briefExcerpt.trim().length === 0
      ? []
      : ["", "The card's brief, in short:", input.briefExcerpt.trim()]),
  ];
  return [
    "You are a CI step on a board card. Work in the card's worktree.",
    ...where,
    "",
    input.prompt,
    "",
    "This step checks the branch; it does not change it. Leave the code as it is: if you find problems, report them, and the board hands them to a fix agent.",
    `When you're done, complete the step with outcome "succeeded" and a payload shaped ${BOARD_CI_AGENT_PAYLOAD_SHAPE}, whatever your verdict: "passed" when the check holds, "failed" with the failures you found (file and line where you can). Use outcome "failed" only when you could not do the check at all.`,
  ].join("\n");
}

/** A failed CI step, as the fix agent sees it (T3O-44/57). */
export interface BoardCiFixFailure {
  readonly stepName: string;
  readonly command: string;
  readonly status: "failed" | "timed-out";
  readonly exitCode: number | null;
  readonly tail: string;
  readonly logPath: string | null;
  /** What the step reported in its result file (T3O-49). */
  readonly result?: {
    readonly summary: string | null;
    readonly failures: ReadonlyArray<unknown>;
  } | null;
}

/** The output tail allowance shared by every failure in one fix prompt. */
export const BOARD_CI_FIX_TAIL_BUDGET = 16_000;

/** The last lines of `tail` that fit in `budget` characters. */
function lastLinesWithin(tail: string, budget: number): string {
  if (tail.length <= budget) return tail;
  const cut = tail.slice(-budget);
  const lineStart = cut.indexOf("\n");
  return lineStart === -1 ? cut : cut.slice(lineStart + 1);
}

/**
 * The CI fix agent's step body (T3O-44/57): the stage's fix prompt, every
 * issue the failed pass reported as a numbered list, each failed step's
 * output, the board's guard rails and the completion contract. The board
 * runs the steps; the agent only fixes, so it is told what failed rather
 * than asked to find out.
 */
export function composeBoardCiFixPrompt(input: {
  readonly prompt: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** Every failed step of the pass, in step order; at least one. */
  readonly failures: ReadonlyArray<BoardCiFixFailure>;
  readonly issues: ReadonlyArray<{
    readonly id: string;
    readonly stepName: string;
    readonly title: string;
    readonly file?: string;
    readonly line?: number;
    readonly detail?: string;
  }>;
}): string {
  const { failures, issues } = input;
  const tailBudget = Math.floor(BOARD_CI_FIX_TAIL_BUDGET / Math.max(1, failures.length));
  const where = (issue: { readonly file?: string; readonly line?: number }) =>
    issue.file === undefined
      ? ""
      : ` (${issue.file}${issue.line === undefined ? "" : `:${issue.line}`})`;
  const failedSteps =
    failures.length === 1
      ? `CI step "${failures[0]!.stepName}" failed.`
      : `${failures.length} CI steps failed: ${failures.map((failure) => `"${failure.stepName}"`).join(", ")}.`;
  const blocks = failures.flatMap((failure) => {
    const ended =
      failure.status === "timed-out"
        ? "timed out and was killed"
        : `exited with code ${failure.exitCode ?? "unknown"}`;
    const tail = lastLinesWithin(failure.tail, tailBudget);
    const summary = failure.result?.summary ?? null;
    return [
      "",
      `## ${failure.stepName}`,
      `\`${failure.command}\` ${ended}.`,
      ...(failure.logPath === null ? [] : [`The full log is at \`${failure.logPath}\`.`]),
      ...(summary === null ? [] : [`The step reported: ${summary}`]),
      "The last lines of its output:",
      "```",
      tail.length > 0 ? tail : "(no output)",
      "```",
    ];
  });
  return [
    input.prompt,
    "",
    `${failedSteps} This is fix attempt ${input.attempt} of ${input.maxAttempts}.`,
    "",
    `The issues to fix (${issues.length}):`,
    ...issues.map(
      (issue, index) =>
        `${index + 1}. [${issue.id}] ${issue.stepName}: ${issue.title}${where(issue)}${issue.detail === undefined ? "" : ` — ${issue.detail}`}`,
    ),
    ...blocks,
    "",
    ...(failures.length > 1
      ? ["Later failures may be caused by earlier ones. Work through them in order."]
      : []),
    "Updating a test that this card's change made out of date is fine. Never delete, skip or loosen a check to hide a real failure.",
    "If a failure also happens on the base branch, still fix it, but keep that fix minimal and in its own commit.",
    "",
    `Do not run the CI steps yourself to finish: the board re-runs every step from the top after you report. Complete with outcome "succeeded" and a payload shaped ${BOARD_CI_FIX_PAYLOAD_SHAPE}, giving every issue by its id. Use "fixed" once your fixes are committed and pushed (give \`fixedSha\`), or with nothing to commit when a failure looks transient and a re-run should clear it. Use "cannot-fix", with a \`finding\` saying why, when any issue can't be fixed from this worktree, or only by hiding it: still fix and push the others, and mark each issue "resolved" or "cannot-fix".`,
  ].join("\n");
}

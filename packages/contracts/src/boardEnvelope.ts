/**
 * The system-owned wrapper around every board run prompt, shared by the server and settings
 * UI so they cannot drift. The editable prompt carries only intent. A null `stepLabel` means
 * the stage has no steps, so the envelope names no step; a stepped stage gets its `stepId`.
 */
import type {
  BoardCardPullRequest,
  BoardReviewCarriedFinding,
  BoardReviewFollowUpFinding,
  BoardReviewFollowUpPhase,
  BoardReviewPhaseId,
  BoardReviewBarTier,
  BoardReviewRoundMode,
  BoardStageRole,
} from "./board.ts";
import {
  BOARD_REVIEW_STEP_PHASE_LABELS,
  boardCiHeadlineLead,
  parseReviewStepId,
  BOARD_CI_FIX_PAYLOAD_SHAPE,
  BOARD_CI_AGENT_PAYLOAD_SHAPE,
  BOARD_BUILD_SUMMARY_PAYLOAD_SHAPE,
  BOARD_REVIEW_PHASE_LABELS,
  DEFAULT_BOARD_SYNC_PHASE_PROMPT,
} from "./board.ts";

/** Provider-neutral on purpose: the envelope is composed once and read by whichever runtime
    the stage runs on. */
export const BOARD_ENVELOPE_QUESTION_MECHANISM =
  "raise it through your runtime's user-input request so it surfaces as a real prompt";

/** `board_move_card` is agent-reachable, so the envelope, not the editable prompt, forbids
    it. Holds on every stance and on a stage with no steps. */
export const BOARD_ENVELOPE_MOVE_GUARD =
  "Never move the card between stages yourself; finish your work and the board or a human moves the card on.";

/** The decision log, stated on every planning run, attended or
    not, so the log exists however the plan was reached. */
export const BOARD_ENVELOPE_DECISION_LOG =
  "Before you call board_propose_plans, record every decision this planning session made with board_record_decisions: what was asked, what was decided, a one-line reason and who decided (agent, or human when the user answered). Flag a call you were not sure about as unclear, and a call that shapes the work as important.";

/** What an auto-planned run is told: no more questions.
    Rides the postamble of a fresh auto-plan run and is the steering turn sent
    into a live planning thread, followed by what happens to the plan — use
    `boardAutoPlanInstruction`. */
export const BOARD_AUTO_PLAN_INSTRUCTION =
  "Auto-plan: stop interviewing and do not ask any more questions. Decide every remaining question yourself, record each decision with board_record_decisions (flag any you are unsure of as unclear), propose the plan with board_propose_plans, run any plan review this card has to the end, then call board_complete_step.";

/** Appended when turning Auto-plan on reopened a planning step the agent had
    already marked finished, so its next completion is the real finish. */
const BOARD_AUTO_PLAN_REOPENED_NOTE =
  "Planning had been marked finished and has been reopened. When your current work, including any plan review, is done, call board_complete_step again.";

const reopenedSuffix = (options: { readonly reopened?: boolean } | undefined) =>
  options?.reopened === true ? ` ${BOARD_AUTO_PLAN_REOPENED_NOTE}` : "";

/** The full auto-plan instruction: with Auto-build on the plan is approved and
    built without a human; without it the plan waits for the user's approval. */
export function boardAutoPlanInstruction(
  autoBuild: boolean,
  options?: { readonly reopened?: boolean },
): string {
  const base = autoBuild
    ? `${BOARD_AUTO_PLAN_INSTRUCTION} Auto-build is on: the plan you propose is approved and built automatically, unclear decisions included, so make each call the way you would defend it in review.`
    : `${BOARD_AUTO_PLAN_INSTRUCTION} Your plan will be presented to the user for approval, so make each call the way you would defend it in review.`;
  return `${base}${reopenedSuffix(options)}`;
}

/** Sent into a planning thread when Auto-plan is turned off mid-run. */
export const BOARD_AUTO_PLAN_OFF_INSTRUCTION =
  "The user is back: Auto-plan is off. You may ask questions again, and it is fine to end a turn waiting on an answer. Your plan will be presented to the user for approval.";

/** The off instruction, with the reopened note when the step is still reopened. */
export function boardAutoPlanOffInstruction(options?: { readonly reopened?: boolean }): string {
  return `${BOARD_AUTO_PLAN_OFF_INSTRUCTION}${reopenedSuffix(options)}`;
}

/** The `plan` role's deliverable, role-keyed so a rewritten Planning prompt cannot break it.
    It says what a second plan means here, not in the default prompt, so a customised prompt
    still gets the rule. */
export const BOARD_ENVELOPE_PLAN_DELIVERABLE = [
  BOARD_ENVELOPE_DECISION_LOG,
  "When the plan is agreed, record it with board_propose_plans, as ONE plan.",
  "To revise a plan you have already proposed, patch it with board_edit_plan rather than resending it.",
  "Two or more plans is not a longer plan: it splits this card into that many child cards, each with its own branch, build and code review, and holds the card behind a human approval gate until someone approves it.",
  "Split only when this card is a large feature whose parts are worth building and reviewing one at a time, or whose parts could be built concurrently for a real speed-up; then pass splitRationale saying why.",
  "A bug fix, a contained change, or work that is merely long is one plan with several sections.",
  "In a split, mark each plan planned: true when it is a full implementation plan, or planned: false when it is a brief that still needs planning, and pass recommendedAutoBuild and recommendedMergeTarget: every child fully planned → auto-build on with its own branch; an epic breakdown → auto-build off, inherit; already inside a group with its own branch → prefer inherit.",
].join(" ");

/** The `build` role's deliverable contract: the structured payload
    the Summary pane renders. Forced here, not in the editable Build prompt, so
    no user rewrite can drop it — the completion handler refuses a succeeded
    build without it. */
export const BOARD_ENVELOPE_BUILD_DELIVERABLE = [
  `Complete a succeeded build with a JSON payload ${BOARD_BUILD_SUMMARY_PAYLOAD_SHAPE}, and put the same \`lead\` sentence in \`summary\`.`,
  "`lead` is one sentence covering what was built, the branch, the commit count and whether it is pushed.",
  "`notes` holds every plan change, unfinished item and shortcut (`kind` is plan_change, not_done or shortcut, with optional `detail`), and these never go in `areas`.",
  "`checks` lists every check or test suite you ran or deliberately skipped, with `status` pass, not_run, fail_preexisting or fail; use fail_preexisting only for a failure this card did not cause, and say why in `detail`.",
  "`areas` groups what was built under names like Data, API, Site core, Panel or Docs, each item one short line.",
  "Wrap code identifiers in backticks. If you cannot produce the payload, complete with outcome failed instead.",
].join(" ");

/** The frozen execution config a spawn needs, read off the step-state run row. */
export interface ComposeStepPromptStep {
  /** The completion ledger key. Always present — the ledger needs it even for a
      stage with no steps — but stated to the agent only when `stepLabel` is
      non-null. */
  readonly stepId: string;
  /** The step's label, or null when this stage has no steps. The
      presence of the identity IS the signal; there is no separate flag. */
  readonly stepLabel: string | null;
  readonly prompt: string;
  /** Frozen human-in-the-loop stance: governs the postamble. */
  readonly humanInLoop: boolean;
  /** An auto-planned planning run. */
  readonly autoPlan?: boolean;
  /** With `autoPlan`: Auto-build is on, so the plan is approved and built. */
  readonly autoBuild?: boolean;
  /** The plan review this step is running (plan review): set once a
      review has started, so a respawned or nudged thread resumes it. */
  readonly planReview?: { readonly instructions: string };
}

export interface ComposeStepPromptInput {
  readonly card: {
    readonly key: string;
    readonly title: string;
    readonly stage: string;
    /** Null when it could not be resolved, so the envelope says nothing rather than
        interpolating placeholder English as a branch name. */
    readonly baseBranch?: string | null;
    /** The card's pull request. Only an explicitly LINKED one is
        stated: its head may be another branch than the card's own worktree,
        and the review prompt otherwise tells the agent to open a pull request
        on the card's branch. */
    readonly pullRequest?: Pick<BoardCardPullRequest, "number" | "headBranch" | "linked"> | null;
  };
  /** The stage's human label, frozen onto the run row at stage entry.
      Null on a legacy row that predates the freeze, where the stage id is
      the only name available. */
  readonly stageLabel: string | null;
  readonly step: ComposeStepPromptStep;
  /** The stage's effective role: keys the deliverable postamble segment. */
  readonly role: BoardStageRole | null;
  /** The Code review stage's open-as-draft setting. Only a
      `build`-role step reads it: a build agent, or a skill it calls, may open
      the pull request before the review loop does. */
  readonly draftPullRequests?: boolean;
}

/** How the agent is told to name its step on the completion call.
    A stage with no steps names none: `stepId` is optional on the tool and the
    board resolves the caller's live step from its thread. */
function completionCall(step: Pick<ComposeStepPromptStep, "stepId" | "stepLabel">): string {
  return step.stepLabel === null
    ? "board_complete_step"
    : `board_complete_step with stepId "${step.stepId}"`;
}

/** Short by design: context is pulled via `board_get_card_context`. No attempt counter, since
    an agent cannot act on it. The stage is named by label, since a custom stage's id is a
    UUID. */
export function boardStepPreamble(
  input: Pick<ComposeStepPromptInput, "card" | "stageLabel"> & {
    readonly step: Pick<ComposeStepPromptStep, "stepLabel"> & {
      readonly stepId?: string | undefined;
    };
    /** The stage's effective role: only a `plan`-role step gets the
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
    // A review step reads with fresh eyes: earlier rounds' findings
    // and rulings are triage's and the adjudicator's to weigh, not the
    // reviewer's, so the pointer stops at the brief.
    parseReviewStepId(step.stepId ?? "")?.phase === "review"
      ? `Call board_get_card_context for the brief only. Do not read earlier review rounds: judge the code as it stands.`
      : `Call board_get_card_context for the brief, plan, dependencies and prior progress.`,
  ].join("\n");
}

/**
 * Stated on every stage. A `plan`-role step adds a clause: plan steps run in the workspace
 * root with no branch of their own, so the checkout may not be the code the card changes.
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
    `This card's base branch is \`${input.baseBranch}\`. Its work branches off and merges back into that.${caveat}`,
  ];
}

/**
 * A card linked to a pull request it did not open still gets its own `board/<key>`
 * worktree, which may not be that PR's branch; this names the PR the work is about.
 */
function boardLinkedPullRequestLines(
  pullRequest: Pick<BoardCardPullRequest, "number" | "headBranch" | "linked"> | null,
): ReadonlyArray<string> {
  if (pullRequest?.linked !== true) return [];
  return [
    `This card is linked to pull request #${pullRequest.number}, whose head branch is \`${pullRequest.headBranch}\`. That pull request is this card's work: read, review and push fixes to \`${pullRequest.headBranch}\` (your worktree may be on a different branch), and never open a new pull request for this card.`,
  ];
}

/** Regrouping needs a human: an unattended run has no one to confirm
    it, so it never regroups. */
export const BOARD_ENVELOPE_REGROUP_GUARD =
  "Do not regroup cards (move them between groups, indent, outdent, group them, or change a group's settings) without a human's explicit confirmation.";

/** An unattended run carries the `/unattended` stance. The completion sentence is the only
    place a `stepId` is named, and only on a stepped stage. */
/** What a step does when it is truly blocked, as one sentence.
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
  /** An auto-planned planning run. */
  readonly autoPlan?: boolean;
  /** With `autoPlan`: the plan is approved and built without a human. */
  readonly autoBuild?: boolean;
}): string {
  const { step } = input;
  const call = completionCall(step);
  const stance = input.humanInLoop
    ? [
        // Human-in-the-loop envelopes carry no progress instruction:
        // these runs are not stall-supervised and the human
        // is already in the conversation.
        `This is a human-in-the-loop run: ask me anything you need directly, and it is fine to end a turn waiting on my answer.`,
        `When the work is done, call ${call}.`,
      ]
    : [
        `You are running unattended. Do not stop to ask permission; make every reasonable decision yourself and proceed.`,
        step.stepLabel === null
          ? `When the work is done, call ${call}. That is the ONLY way to finish; ending your turn any other way is treated as a failure and recovered.`
          : `When this step is finished, call ${call}. That is the ONLY way to finish; ending your turn any other way is treated as a failure and recovered.`,
        // No todo-list ask: Claude Code dropped its todo tools on
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
 * The full run prompt: preamble + body + postamble. An empty body is a
 * re-entry — a clean conversational thread with just the orientation and
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
  // The build draft line rides on the body, so an empty-body
  // re-entry stays the clean conversational thread it is.
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

/** The fixed lead of the plan-review instructions (plan review). */
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
    "- Patch plan changes in place with board_edit_plan. Re-propose with board_propose_plans only if titles, summaries or the set of plans changed; if you only edited bodies, do not re-propose (re-proposing does not start another review). If board_edit_plan or board_propose_plans refuses because the plans are frozen, stop reviewing and summarise.",
    "- When you call board_complete_step, add `planReview: { roundsRun, converged }` to the payload.",
    `- ${finish}`,
    "- If an auto-plan instruction arrives during the review, it overrides the human-in-the-loop rules above but not the review itself: run the remaining rounds as normal. Ask the user nothing further and never wait on them for any reason. Make every remaining decision yourself and record it with board_record_decisions, flagging a contentious or uncertain one as unclear. When the review is done, summarise the final plan in the thread and call board_complete_step without waiting for sign-off.",
  ].join("\n");
}

/**
 * The plan-review instructions (plan review): a fixed lead, the user's
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
    posted (plan review). The review instructions follow it. */
export const BOARD_PLAN_REVIEW_LATE_START_LEAD =
  "Plan review was turned on after you posted the plan. Review the plan you proposed now, as below.";

/** Leads the turn sent when a human changes a running plan review's rounds.
    Only the agent knows how many it has run, so it decides. */
export function boardPlanReviewRoundsChangedLead(rounds: number): string {
  return `The plan review limit is now ${rounds} ${rounds === 1 ? "round" : "rounds"} in total. If you have already run ${rounds} or more, stop reviewing: summarise what the reviews found, patch any plan changes in place with board_edit_plan (re-propose with board_propose_plans only if titles, summaries or the set of plans changed; if you only edited bodies, do not re-propose), and finish as normal. Otherwise continue until you reach ${rounds}, as below.`;
}

/** The turn sent into a planning thread when a human turns its running plan
    review off (plan review). */
export const BOARD_PLAN_REVIEW_STOP_INSTRUCTION =
  "Stop the plan review now: summarise what the reviews found so far, patch any plan changes in place with board_edit_plan (re-propose with board_propose_plans only if titles, summaries or the set of plans changed; if you only edited bodies, do not re-propose), and finish as normal.";

/** A review phase's system preamble: the round header, plus — for any
    phase past the very first review — the pointer to the prior phases'
    payloads. */
export function boardReviewPhasePreamble(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
  readonly rounds: number;
  readonly mode?: BoardReviewRoundMode;
  readonly barTier?: BoardReviewBarTier;
}): string {
  const { phase, round, rounds } = input;
  const header = `Code review, ${BOARD_REVIEW_PHASE_LABELS[phase]} phase, round ${round} of up to ${rounds}${boardReviewSettlingTag(input.mode)}${boardReviewBarTag(phase, input.barTier)}.`;
  // The reviewer is fresh-eyes on every round: only triage and the
  // adjudicator read the history.
  const priorContext =
    phase !== "review"
      ? "Call board_get_card_context first and read the `steps` payloads: they carry every prior phase's findings, dispositions and verdicts for this card."
      : "";
  return priorContext.length > 0 ? `${header}\n${priorContext}` : header;
}

/** The round header's settling suffix, empty for a full round. */
function boardReviewSettlingTag(mode: BoardReviewRoundMode | undefined): string {
  return mode?.kind === "settling"
    ? ` · settling round (changes since ${mode.sinceSha.slice(0, 7)})`
    : "";
}

/** The round header's raised-bar suffix, empty at tier 0 and for triage, whose rubric the
    ladder leaves alone. */
function boardReviewBarTag(
  phase: BoardReviewPhaseId | BoardReviewFollowUpPhase,
  tier: BoardReviewBarTier | undefined,
): string {
  return tier === undefined || tier === 0 || phase === "triage" || phase === "retriage"
    ? ""
    : ` · raised bar (level ${tier})`;
}

/** What still counts as an `improvement` at each raised level. */
const BOARD_REVIEW_BAR_TEXT: Record<Exclude<BoardReviewBarTier, 0>, string> = {
  1: "an `improvement` must be a real defect in this change: wrong behaviour on a path that can be reached, part of the card's brief left undone, or a data, security or concurrency fault. A missing test counts only when it is the sole proof that something the brief asks for works. Hardening ideas, guards for states that cannot happen, refactors, naming, docs, and test style or coverage of code that works are nitpicks",
  2: "an `improvement` must be a defect a user or operator would actually hit in normal use, or one that breaks something the card's brief asks for. Edge cases that need an unusual setup, hardening ideas, refactors, naming, docs and tests of code that works are nitpicks",
  3: "there are no improvements. Only `critical` blocks; anything short of an incident or broken existing behaviour is a nitpick",
};

const BOARD_REVIEW_STRICT_CRITICAL =
  "`critical` keeps its strict meaning: it would cause an incident or break existing behaviour, and never covers a hardening idea, a missing test or a rare edge case. Never raise a finding to critical to get it past the bar.";

/** The adjudicator's power to rule an improvement below the raised bar. */
const BOARD_REVIEW_BELOW_BAR_RULING =
  "For an `improvement` finding that does not meet this round's bar, add `belowBar: true` to its verdict and say why in the note; still give the normal verdict. It then counts as a nitpick: it does not force another round. Never set it on a critical, on a finding a human ordered fixed, on the CI finding, or on a concern from a human pull request comment, and never with `escalated`. Never escalate a finding that is below the bar; rule it `belowBar` instead.";

/** The raised bar for a full round past `convergeAfterRound`, compiled in after the user's
    prompt so it overrides that prompt's severity definitions. Empty at tier 0 and for triage. */
function boardReviewBarBlock(input: {
  readonly phase: BoardReviewPhaseId | BoardReviewFollowUpPhase;
  readonly round: number;
  readonly tier: BoardReviewBarTier | undefined;
}): string {
  const { tier } = input;
  if (tier === undefined || tier === 0) return "";
  const bar = `This is round ${input.round}; the bar for \`improvement\` is raised and overrides the severity definitions above: ${BOARD_REVIEW_BAR_TEXT[tier]}.`;
  const strict = tier === 3 ? BOARD_REVIEW_STRICT_CRITICAL : "";
  switch (input.phase) {
    case "review":
      return [
        bar,
        "Rate anything below it `nitpick`. The CI finding, findings a human ordered fixed, and concerns from unresolved human pull request comments keep their severity.",
        strict,
      ]
        .filter((part) => part.length > 0)
        .join(" ");
    case "triage":
    case "retriage":
      return "";
    case "adjudicate":
    case "readjudicate":
      return [bar, strict, BOARD_REVIEW_BELOW_BAR_RULING].filter((part) => part.length > 0).join(" ");
  }
}

/** What a settling round asks of each phase, compiled in beside the machine contract so a
    custom phase prompt cannot drop it. Empty for a full round. */
function boardReviewSettlingBlock(input: {
  readonly phase: BoardReviewPhaseId | BoardReviewFollowUpPhase;
  readonly mode: BoardReviewRoundMode | undefined;
}): string {
  const { mode } = input;
  if (mode?.kind !== "settling") return "";
  switch (input.phase) {
    case "review":
      return [
        `This is a settling round. Review only the changes this branch made since commit \`${mode.sinceSha}\` (\`git diff ${mode.sinceSha}..HEAD\`), including their direct callers and callees. Read other code only as context, and raise no findings about code outside that scope. If \`${mode.sinceSha}\` is missing, is not an ancestor of HEAD, or the range contains merge commits, review the whole branch instead. This scope limits only your own search: a CI failure, a finding this prompt marks must-fix, and an unresolved human comment on the pull request are still reported wherever their code is.`,
        'Add `scope: "delta"` to your payload, or `scope: "branch"` if you fell back to the whole branch.',
        "In a settling round only `critical` findings force another round; `improvement` findings are still fixed and verified. Rate honestly: `critical` means it would cause an incident or break existing behaviour, never a hardening idea or a missing test.",
      ].join(" ");
    case "triage":
    case "retriage":
      return "This is a settling round: only critical findings force another review round, but every finding is still fixed or rejected.";
    case "adjudicate":
    case "readjudicate":
      return "This is a settling round: your adjudication is binding for every finding, and only critical findings force another review round. `anotherRound` is recorded but has no effect.";
  }
}

/** The rule that keeps the adjudicator consistent across rounds. */
const BOARD_REVIEW_ADJUDICATOR_CONSISTENCY =
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
    as final rulings. Empty when there are none. */
function boardReviewDismissalsBlock(input: {
  readonly phase: BoardReviewPhaseId | BoardReviewFollowUpPhase;
  readonly dismissals: ReadonlyArray<BoardReviewCarriedFinding & { readonly round: number }>;
}): string {
  if (input.dismissals.length === 0) return "";
  const lines = input.dismissals.map(
    (d) =>
      `${boardReviewFindingLine({ id: d.findingId, severity: d.severity, title: d.title, file: d.file, line: d.line })}: dismissed by a human in round ${d.round}`,
  );
  const rule =
    input.phase === "review"
      ? "A human ruled these are not issues. Do not raise them again."
      : input.phase === "triage" || input.phase === "retriage"
        ? "A human ruled these are not issues; the ruling is final. If one is raised again, reject it citing the human ruling."
        : "A human ruled these are not issues; the ruling is final. If one is raised again and triage rejected it, rule rejection-justified.";
  return [rule, ...lines].join("\n");
}

/** The carried "fix" findings a round must resolve, for triage and
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

/** Only the `board_complete_step` payload shape the executor parses to gate convergence;
    review craft, safety stance and PR workflow live in the editable phase prompt. Names no
    step id or completion tool: the postamble states both. */
export function boardReviewPhaseProtocol(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
  readonly barTier?: BoardReviewBarTier;
}): string {
  const raised = (input.barTier ?? 0) > 0;
  switch (input.phase) {
    case "review":
      return [
        input.barTier === 3
          ? "To finish this phase, complete with a succeeded outcome and a JSON payload { reviewedSha, findings: [{ id, severity, file, line, title, detail }] }, where `severity` is `critical` or `nitpick`; only the CI finding and concerns from unresolved human pull request comments keep their own severity, which may be `improvement`."
          : "To finish this phase, complete with a succeeded outcome and a JSON payload { reviewedSha, findings: [{ id, severity, file, line, title, detail }] }, where `severity` is `critical`, `improvement` or `nitpick`.",
        "Critical and improvement findings are blocking; nitpicks never are. Whether the loop runs another round is decided by the system from the severities you record, never by you. Report what you found and stop.",
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
        `To finish this phase, complete with a succeeded outcome and a JSON payload { verdicts: [{ ${boardReviewVerdictFields(raised)} }], anotherRound }, where \`verdict\` is one of fix-upheld, fix-incomplete, fix-absent, rejection-justified, rejection-unjustified, escalated.`,
        BOARD_REVIEW_ADJUDICATOR_CONSISTENCY,
        `Set \`anotherRound\` to false only if this round raised nothing new beyond points already settled; otherwise true. ${boardReviewAnotherRoundIgnored(raised)}`,
        "A ruling against triage (rejection-unjustified, fix-absent or fix-incomplete) on a blocking finding sends it straight back to triage in this round for one more pass.",
        BOARD_REVIEW_ADJUDICATOR_ESCALATION,
      ].join(" ");
  }
}

function boardReviewVerdictFields(raised: boolean): string {
  return raised ? "findingId, verdict, note, belowBar?" : "findingId, verdict, note";
}

function boardReviewAnotherRoundIgnored(raised: boolean): string {
  return raised
    ? "The system ignores false if a blocking fix landed; fixes to findings you ruled below the bar don't count."
    : "The system ignores false if a blocking fix landed.";
}

/** A follow-up pass's forced machine contract. */
function boardReviewFollowUpProtocol(
  phase: BoardReviewFollowUpPhase,
  barTier: BoardReviewBarTier | undefined,
): string {
  const raised = (barTier ?? 0) > 0;
  const ignored = boardReviewAnotherRoundIgnored(raised);
  return phase === "retriage"
    ? `To finish this step, complete with a succeeded outcome and a JSON payload { fixedSha, dispositions: [{ findingId, action: "fixed" | "rejected", note }] }, with a disposition for every listed id. ${BOARD_REVIEW_TRIAGE_NEVER_ASKS}`
    : `To finish this step, complete with a succeeded outcome and a JSON payload { verdicts: [{ ${boardReviewVerdictFields(raised)} }], anotherRound }, with a verdict for every listed id, where \`verdict\` is one of fix-upheld, fix-incomplete, fix-absent, rejection-justified, rejection-unjustified, escalated. Set \`anotherRound\` to false only if this round raised nothing new beyond points already settled; ${ignored.charAt(0).toLowerCase()}${ignored.slice(1)} ${BOARD_REVIEW_ADJUDICATOR_ESCALATION}`;
}

/** Triage's forced never-ask rule. It sits in the machine contract,
    not the editable prompt, so it holds for a custom prompt too. */
const BOARD_REVIEW_TRIAGE_NEVER_ASKS =
  "Triage never stops for a human: never ask a question, raise a user-input request, or complete blocked. Every finding is fixed or rejected. Reject a finding that falls outside this card's brief, or needs a product or scope decision, saying so; this outranks any instruction above to reject only with concrete evidence, and the adjudicator decides whether a human is needed. Complete failed only if your tooling is broken: failed re-runs the step.";

/** The adjudicator's escalation rule: the only way a review finding
    reaches a human. */
const BOARD_REVIEW_ADJUDICATOR_ESCALATION =
  "Rule on every finding yourself. The `escalated` verdict hands a finding to a human and stops the loop; it does not send the finding back to triage. Use it only on a rejected blocking finding, and only when there is a genuine reason you cannot decide: a product or scope call the card's brief does not settle, or a risk only the owner can accept. Uncertainty or difficulty is not a reason: weigh the evidence and rule. Its note must say why a human is needed. Judge a scope or product rejection against the card's brief, not the code. Escalation is the only way to reach a human: never ask a question, raise a user-input request, or complete blocked.";

/**
 * Compose a follow-up pass's prompt: re-triage or re-adjudicate,
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
  readonly mode?: BoardReviewRoundMode;
  /** The round's raised bar; absent is 0. */
  readonly barTier?: BoardReviewBarTier;
}): string {
  const header = `Code review, ${BOARD_REVIEW_STEP_PHASE_LABELS[input.phase]} step, round ${input.round} of up to ${input.rounds}${boardReviewSettlingTag(input.mode)}${boardReviewBarTag(input.phase, input.barTier)}.\nCall board_get_card_context first and read the \`steps\` payloads: they carry every prior phase's findings, dispositions and verdicts for this card.`;
  const listed = input.findings.map((f) => {
    const lines = [boardReviewFindingLine(f.finding)];
    if (f.finding.carried) lines.push("  A human ordered this fixed.");
    if (f.triageAction !== null) {
      lines.push(
        `  Triage: ${f.triageAction}${f.triageNote.trim() === "" ? "" : `: ${f.triageNote.trim()}`}`,
      );
    }
    if (f.rulingVerdict !== null) {
      lines.push(
        `  Ruling: ${f.rulingVerdict}${f.rulingNote.trim() === "" ? "" : `: ${f.rulingNote.trim()}`}`,
      );
    }
    if (f.retriageAction !== null) {
      lines.push(
        `  Re-triage: ${f.retriageAction}${f.retriageNote.trim() === "" ? "" : `: ${f.retriageNote.trim()}`}`,
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
    boardReviewSettlingBlock({ phase: input.phase, mode: input.mode }),
    boardReviewBarBlock({ phase: input.phase, round: input.round, tier: input.barTier }),
    boardReviewFollowUpProtocol(input.phase, input.barTier),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

/** How to open a draft on each forge, and what to do around it.
    Written per forge, because the agent — not the board — opens the pull
    request. */
const boardDraftPullRequestHow = (sayWhere: string) =>
  `\`gh pr create --draft\` on GitHub, \`glab mr create --draft\` on GitLab, and on Forgejo or Gitea a title that starts with \`WIP: \`. If the pull request already exists, leave its draft state alone. If the forge refuses a draft (some plans do not offer them), open a normal pull request instead and ${sayWhere}. Never mark the pull request ready for review yourself. The board does that once the review converges.`;

/** The review phase's open-as-draft instruction. It outranks any
    skill's own default (such as /pullrequest opening a ready one). */
export const BOARD_DRAFT_PULL_REQUEST_OPEN = `Open this card's pull request as a DRAFT, whatever any skill or workflow you use would do by default: ${boardDraftPullRequestHow("say so in your summary")}`;

/** The build stage's draft line. Conditional, because a build step
    need not open a pull request at all — the review phase opens one if it
    did not. */
export const BOARD_DRAFT_PULL_REQUEST_BUILD = `If you open this card's pull request, yourself or through a skill such as /pullrequest, open it as a DRAFT, whatever that skill would do by default: ${boardDraftPullRequestHow("record it as a `shortcut` note in your payload")}`;

/** The line every later loop step carries while drafts are on: the
    fix commits the loop pushes must not start the repository's full CI. */
export const BOARD_DRAFT_PULL_REQUEST_KEEP =
  "If the pull request is a draft, leave it as a draft; the board marks it ready. If it is not a draft, do not convert it to one.";

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
 * The draft line sits after the user's prompt so it overrides whatever PR workflow that
 * prompt names.
 */
export function composeBoardReviewPhasePrompt(input: {
  readonly phase: BoardReviewPhaseId;
  readonly round: number;
  readonly rounds: number;
  readonly prompt: string;
  readonly draftPullRequests?: boolean;
  /** The CI failure that sent the card back: a must-fix finding for
      the review and triage of the round that follows. */
  readonly ciFinding?: { readonly stepName: string | null; readonly finding: string } | null;
  /** Findings a human carried into this round as must-fix. */
  readonly carried?: ReadonlyArray<BoardReviewFollowUpFinding>;
  /** Findings a human ruled not issues, at or before this round. */
  readonly dismissals?: ReadonlyArray<BoardReviewCarriedFinding & { readonly round: number }>;
  /** The round's mode; absent is full. */
  readonly mode?: BoardReviewRoundMode;
  /** The round's raised bar; absent is 0. */
  readonly barTier?: BoardReviewBarTier;
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
    boardReviewSettlingBlock({ phase: input.phase, mode: input.mode }),
    boardReviewBarBlock({ phase: input.phase, round: input.round, tier: input.barTier }),
    boardReviewPhaseProtocol(input),
  ]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

/**
 * The sync-base step's prompt: round header, the compiled-in rebase instructions
 * with the card's base ref, then the completion protocol. All machinery, with no
 * user-editable part, so it does not use the review phases' preamble/prompt split.
 */
export function composeBoardSyncPhasePrompt(input: {
  readonly round: number;
  /** Null when the card has no worktree slice: the base sentence is omitted rather than
      interpolating placeholder text into the prompt as if it were a branch name. */
  readonly baseRefName: string | null;
  /** Set when a human retargeted the card and it differs from `baseRefName`; null means
      the same base whose tip moved. Only the opening sentence differs between the two. */
  readonly retargetedTo?: string | null;
  /** Drafts are on: the rebase's force-push must leave the draft be. */
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
    "To finish this step, complete with a succeeded outcome and a JSON payload { rebasedSha } naming the commit the rebased branch now points at. One review round then runs on the rebased diff before the card can merge. Never skip the rebase or complete succeeded without having pushed it.",
  ]
    .filter((part): part is string => part !== null)
    .join("\n\n");
}

/**
 * Appended only on a retarget. Nothing else moves an open pull request's base, and the
 * merge gate refuses a pull request whose base disagrees with the card's rebased base.
 */
function boardSyncPhasePullRequestRetarget(retargetedTo: string): string {
  return `If this card's branch already has an OPEN pull request, retarget it at \`${retargetedTo}\` as well, once the rebase has landed: \`gh pr edit --base ${retargetedTo}\` on GitHub, or the equivalent for this repository's forge. Its base still names the branch it was opened against, and nothing else moves it. The board refuses to merge a pull request whose base disagrees with the branch the card was rebased onto, so a pull request left pointing at the old base strands the card at Ready for merge.`;
}

/** The rebase mechanics half of `DEFAULT_BOARD_SYNC_PHASE_PROMPT`, shared by both
    triggers so a retarget swaps only the opening sentence. Relies on the default
    prompt opening with exactly one sentence of why. */
function boardSyncPhaseMechanics(): string {
  const marker = "Fetch the base branch";
  const at = DEFAULT_BOARD_SYNC_PHASE_PROMPT.indexOf(marker);
  return at < 0 ? DEFAULT_BOARD_SYNC_PHASE_PROMPT : DEFAULT_BOARD_SYNC_PHASE_PROMPT.slice(at);
}

/**
 * A CI agent step's body: the board's prefix — where the card is in
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

/** A failed CI step, as the fix agent sees it. */
export interface BoardCiFixFailure {
  readonly stepName: string;
  readonly command: string;
  readonly status: "failed" | "timed-out";
  readonly exitCode: number | null;
  readonly tail: string;
  readonly logPath: string | null;
  /** What the step reported in its result file. */
  readonly result?: {
    readonly summary: string | null;
    readonly failures: ReadonlyArray<unknown>;
  } | null;
  /** What failed and why, as the runner read it. */
  readonly headline?: {
    readonly what: string;
    readonly why: string;
    readonly logLine: number | null;
  } | null;
}

/** The output tail allowance shared by every failure in one fix prompt. */
export const BOARD_CI_FIX_TAIL_BUDGET = 16_000;

/** Each issue's detail line in a fix prompt; the step's log has the rest. */
const BOARD_CI_FIX_ISSUE_DETAIL_MAX = 400;

const clipIssueDetail = (detail: string) =>
  detail.length <= BOARD_CI_FIX_ISSUE_DETAIL_MAX
    ? detail
    : `${detail.slice(0, BOARD_CI_FIX_ISSUE_DETAIL_MAX - 1)}…`;

/** The last lines of `tail` that fit in `budget` characters. */
function lastLinesWithin(tail: string, budget: number): string {
  if (tail.length <= budget) return tail;
  const cut = tail.slice(-budget);
  const lineStart = cut.indexOf("\n");
  return lineStart === -1 ? cut : cut.slice(lineStart + 1);
}

/**
 * The board-owned lines that close every CI fix prompt: guard rails
 * and the completion contract. Not editable; Settings shows them after the
 * project's fix prompt.
 */
export function boardCiFixPromptRules(failureCount: number): ReadonlyArray<string> {
  return [
    ...(failureCount > 1
      ? ["Later failures may be caused by earlier ones. Work through them in order."]
      : []),
    "Updating a test that this card's change made out of date is fine. Never delete, skip or loosen a check to hide a real failure.",
    "If a failure also happens on the base branch, still fix it, but keep that fix minimal and in its own commit.",
    "",
    `Do not run the CI steps yourself to finish: the board re-runs every step from the top after you report. Complete with outcome "succeeded" and a payload shaped ${BOARD_CI_FIX_PAYLOAD_SHAPE}, giving every issue by its id. Use "fixed" once your fixes are committed and pushed (give \`fixedSha\`), or with nothing to commit when a failure looks transient and a re-run should clear it. Use "cannot-fix", with a \`finding\` saying why, when any issue can't be fixed from this worktree, or only by hiding it: still fix and push the others, and mark each issue "resolved" or "cannot-fix".`,
  ];
}

/**
 * The CI fix agent's step body. The board runs the steps and the agent only fixes,
 * so it is told what failed rather than asked to find out.
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
      ...(failure.headline == null
        ? []
        : [`What failed: ${boardCiHeadlineLead(failure.headline)}`]),
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
        `${index + 1}. [${issue.id}] ${issue.stepName}: ${issue.title}${where(issue)}${issue.detail === undefined ? "" : `: ${clipIssueDetail(issue.detail)}`}`,
    ),
    ...blocks,
    "",
    ...boardCiFixPromptRules(failures.length),
  ].join("\n");
}

/**
 * T3o: the card sidebar's Plan review section (plan review), as data.
 * Pure, so the visibility, phase and clamp rules are tested without rendering.
 */
import {
  BOARD_PLAN_REVIEW_ROUNDS_MAX,
  BOARD_PLAN_REVIEW_ROUNDS_MIN,
  clampBoardPlanReviewRounds,
  compareBoardStages,
  effectiveBoardStageRole,
  resolveBoardCardPlanReview,
  resolveBoardStageExecution,
  type BoardCardPlanReview,
  type BoardSettings,
  type BoardPlanReviewSettings,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardProjectExecutionConfig,
} from "@t3tools/contracts";

/** Where the card's review stands, which decides the header and the controls. */
export type BoardCardPlanReviewPhase =
  | "off"
  /** On, with no plan posted yet: it starts on the first proposal. */
  | "waiting-for-plan"
  /** Turned on after the plan was posted: nothing is sent until Start review. */
  | "ready-to-start"
  /** Started, before the agent's first round report. */
  | "reviewing"
  | "round"
  /** The review ended; an attended run waits for the human's sign-off. */
  | "waiting-for-you"
  /** The planning step finished after the review: the collapsed summary row. */
  | "reviewed";

/** One progress-bar segment per target round. */
export type BoardPlanReviewSegment = "done" | "running" | "todo";

export interface BoardCardPlanReviewView {
  readonly phase: BoardCardPlanReviewPhase;
  readonly enabled: boolean;
  readonly rounds: number;
  readonly unattended: boolean;
  /** A review is running: started, not done. Rounds changes move its target. */
  readonly inProgress: boolean;
  /** The header text on the right of "Plan review". */
  readonly summary: string;
  readonly note: string;
  /** Where the card's setting came from, or null when there is nothing to say. */
  readonly provenance: string | null;
  readonly unattendedNote: string;
  /** The resolved Sign-off gate under the Unattended switch, or null when it is off. */
  readonly signOffNote: string | null;
  /** Null when no review has started. */
  readonly progress: ReadonlyArray<BoardPlanReviewSegment> | null;
  readonly canDecrease: boolean;
  readonly canIncrease: boolean;
}

/** The plan-role stage's execution config, where plan review settings live. */
export function boardPlanStageExecution(
  settings: BoardSettings,
  stages: ReadonlyArray<BoardStageDefinition>,
  projectConfig?: BoardProjectExecutionConfig | null,
): { readonly planReview?: BoardPlanReviewSettings | undefined } | null {
  const planStage = stages.find((stage) => effectiveBoardStageRole(stage) === "plan");
  if (planStage === undefined) return null;
  const execution = resolveBoardStageExecution(settings, planStage.stageId, projectConfig);
  return execution.kind === "simple" ? execution : null;
}

function roundsWord(rounds: number): string {
  return rounds === 1 ? "1 round" : `${rounds} rounds`;
}

function findingsWord(findings: number): string {
  return findings === 1 ? "1 finding" : `${findings} findings`;
}

/** Done rounds green, the running one blue, the rest neutral. A round not yet run is never
    green: before the first report every segment is still to come. */
function progressSegments(input: {
  readonly rounds: number;
  readonly round: number | undefined;
  readonly done: boolean;
}): ReadonlyArray<BoardPlanReviewSegment> {
  return Array.from({ length: input.rounds }, (_, index) => {
    const round = index + 1;
    if (input.round === undefined) return "todo";
    if (round < input.round) return "done";
    if (round === input.round) return input.done ? "done" : "running";
    return "todo";
  });
}

/** The section, or null where it is hidden: on a group, and after Planning. */
export function boardCardPlanReviewView(input: {
  readonly card: {
    readonly stage: BoardStageId;
    readonly planReview?: BoardCardPlanReview | undefined;
  };
  readonly isGroup: boolean;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly planStageExecution:
    | { readonly planReview?: BoardPlanReviewSettings | undefined }
    | null
    | undefined;
  readonly planReviewStarted?:
    | {
        readonly rounds: number;
        readonly round?: number | undefined;
        readonly doneAt?: string | undefined;
      }
    | undefined;
  /** Armed: turned on after the plan was posted. */
  readonly awaitingStart?: boolean | undefined;
  readonly hasPlan?: boolean | undefined;
  /** The review that finished on this stay in Planning, from the activity rail. */
  readonly finished?:
    | {
        readonly rounds: number;
        readonly roundsRun: number | null;
        readonly findings: number | null;
      }
    | null
    | undefined;
  readonly projectTitle?: string | undefined;
  /** The card's resolved Auto sign-off, with where it comes from. */
  readonly signOff?: { readonly on: boolean; readonly tag: string | null } | undefined;
}): BoardCardPlanReviewView | null {
  if (input.isGroup) return null;
  const ordered = [...input.stages].sort(compareBoardStages);
  const planIndex = ordered.findIndex((stage) => effectiveBoardStageRole(stage) === "plan");
  const cardIndex = ordered.findIndex((stage) => stage.stageId === input.card.stage);
  if (planIndex === -1 || cardIndex === -1 || cardIndex > planIndex) return null;
  const resolved = resolveBoardCardPlanReview(input.card, input.planStageExecution);
  const inPlanning = cardIndex === planIndex;
  // Mirrors the server: a started review runs until the card's own toggle stops it.
  const started =
    input.card.planReview?.enabled !== false && inPlanning ? input.planReviewStarted : undefined;
  const enabled = resolved.enabled || started !== undefined;
  const rounds = started?.rounds ?? resolved.rounds;
  const unattended = resolved.unattended === true;
  const done = started?.doneAt !== undefined;
  const phase: BoardCardPlanReviewPhase = !enabled
    ? "off"
    : started !== undefined
      ? done
        ? "waiting-for-you"
        : started.round === undefined
          ? "reviewing"
          : "round"
      : inPlanning && input.awaitingStart === true
        ? "ready-to-start"
        : inPlanning && input.finished != null
          ? "reviewed"
          : "waiting-for-plan";
  const finishedRounds = input.finished?.roundsRun ?? input.finished?.rounds ?? rounds;
  const summary = (() => {
    switch (phase) {
      case "off":
        return "Off";
      case "waiting-for-plan":
        return input.hasPlan === true ? roundsWord(rounds) : "Waiting for plan";
      case "ready-to-start":
        return "Ready to start";
      case "reviewing":
        return `Reviewing · up to ${roundsWord(rounds)}`;
      case "round":
        return `Round ${Math.min(started?.round ?? 1, rounds)} of ${rounds}`;
      case "waiting-for-you":
        return unattended ? "Reviewed" : "Reviewed, waiting for you";
      case "reviewed":
        return `Reviewed · ${roundsWord(finishedRounds)}${
          input.finished?.findings == null ? "" : ` · ${findingsWord(input.finished.findings)}`
        }`;
    }
  })();
  const note = (() => {
    switch (phase) {
      case "off":
        return "The plan comes straight to you for sign-off.";
      case "waiting-for-plan":
        return `When the plan is posted, the planning agent runs up to ${roundsWord(rounds)} of review. The number and focus of reviewing subagents launched each round is outlined in the plan review prompt.`;
      case "ready-to-start":
        return "Nothing is sent until you start.";
      case "reviewing":
      case "round":
        return `The planning agent is reviewing the plan, up to ${roundsWord(rounds)}. A rounds change moves the target; the agent picks it up at its next round.`;
      case "waiting-for-you":
        return unattended
          ? "The review is done."
          : "The review is done. The planning agent is waiting for your sign-off.";
      case "reviewed":
        return "The plan was reviewed before it came to you.";
    }
  })();
  const own = input.card.planReview;
  const provenance =
    own === undefined
      ? null
      : own.source === "default"
        ? own.enabled
          ? `On by default${input.projectTitle ? ` for ${input.projectTitle}` : ""} · ${roundsWord(own.rounds)}`
          : `Off by default${input.projectTitle ? ` for ${input.projectTitle}` : ""}`
        : own.enabled
          ? null
          : "Off for this card";
  const signOffTag = input.signOff?.tag == null ? "" : ` (${input.signOff.tag})`;
  return {
    phase,
    enabled,
    rounds,
    unattended,
    inProgress: started !== undefined && !done,
    summary,
    note,
    provenance,
    unattendedNote: unattended
      ? "Plan switches to auto from round 1"
      : "Off: the agent can stop to ask you about findings between rounds",
    signOffNote: !unattended
      ? null
      : input.signOff?.on === true
        ? `Auto sign-off is on${signOffTag}, so when round ${rounds} ends the plan signs off.`
        : `Auto sign-off is off${signOffTag}: the reviewed plan waits for you.`,
    progress:
      started === undefined ? null : progressSegments({ rounds, round: started.round, done }),
    canDecrease: rounds > BOARD_PLAN_REVIEW_ROUNDS_MIN,
    canIncrease: rounds < BOARD_PLAN_REVIEW_ROUNDS_MAX,
  };
}

/** The card's next setting after a change. Always an explicit value with no `source`:
    touching a control pins the card and ends "on by default". */
export function nextBoardCardPlanReview(
  view: Pick<BoardCardPlanReviewView, "enabled" | "rounds" | "unattended">,
  change:
    | { readonly enabled: boolean }
    | { readonly rounds: number }
    | { readonly unattended: boolean },
): BoardCardPlanReview {
  const base = {
    enabled: view.enabled,
    rounds: view.rounds,
    ...(view.unattended ? { unattended: true } : {}),
  };
  if ("enabled" in change) return { ...base, enabled: change.enabled };
  if ("rounds" in change) return { ...base, rounds: clampBoardPlanReviewRounds(change.rounds) };
  const { unattended: _unattended, ...rest } = base;
  return change.unattended ? { ...rest, unattended: true } : rest;
}

/** The finished review on the card's latest stay in Planning, read off its activity rail:
    the last `plan-review-finished` after the last `plan-review-started`. */
export function boardPlanReviewFinishedFromActivity(
  activity: ReadonlyArray<{
    readonly kind: string;
    readonly payload: {
      readonly planReviewRounds?: number | undefined;
      readonly planReviewRoundsRun?: number | null | undefined;
      readonly planReviewFindings?: number | null | undefined;
    };
  }>,
): {
  readonly rounds: number;
  readonly roundsRun: number | null;
  readonly findings: number | null;
} | null {
  let finished: (typeof activity)[number] | null = null;
  for (const entry of activity) {
    // A new review, or a move out of and back into Planning, starts the summary over.
    if (entry.kind === "plan-review-started" || entry.kind === "card-moved") finished = null;
    if (entry.kind === "plan-review-finished") finished = entry;
  }
  if (finished === null) return null;
  return {
    rounds: finished.payload.planReviewRounds ?? 1,
    roundsRun: finished.payload.planReviewRoundsRun ?? null,
    findings: finished.payload.planReviewFindings ?? null,
  };
}

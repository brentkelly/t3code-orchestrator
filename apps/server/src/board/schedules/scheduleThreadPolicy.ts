/**
 * T3o: what a schedule run's thread may do with board tools (T3O-117). Every run has full
 * access to its machine, so this is a guardrail against model mistakes and casual prompt
 * injection, not a security boundary. It covers nightly's flow: file a card in the
 * schedule's project, arm it with Auto-merge off, move it to Planning, or update its own.
 */
import {
  BOARD_SEED_STAGE_IDS,
  type BoardCard,
  type BoardState,
  type ProjectId,
} from "@t3tools/contracts";

export interface ScheduleCaller {
  readonly projectId: ProjectId;
  readonly fileId: string;
  /** Cards this schedule's runs created, whichever run made them. */
  readonly cards: ReadonlySet<string>;
}

export type ScheduleToolDecision =
  | { readonly kind: "allow"; readonly params?: Record<string, unknown> }
  | {
      readonly kind: "refuse";
      readonly code: "thread-not-linked" | "rejected" | "invalid-input";
      readonly message: string;
    };

/** Stages a schedule's card may be moved to or created in. */
const SCHEDULE_CARD_STAGES: ReadonlySet<string> = new Set([
  BOARD_SEED_STAGE_IDS.backlog,
  BOARD_SEED_STAGE_IDS.sprint,
  BOARD_SEED_STAGE_IDS.planning,
]);

/** Tools that act on the caller's own card, which a schedule run never has. */
const CARD_SCOPED_TOOLS: ReadonlySet<string> = new Set([
  "board_get_card_context",
  "board_complete_step",
  "board_get_plan",
  "board_propose_plans",
  "board_write_plan",
  "board_edit_plan",
  "board_plan_review_round",
  "board_record_decisions",
]);

const refuse = (message: string): ScheduleToolDecision => ({
  kind: "refuse",
  code: "rejected",
  message: `A scheduled run's board tools are limited to its own project and the cards its runs created. ${message}`,
});

export const findBoardCardRef = (board: BoardState, ref: unknown): BoardCard | undefined =>
  typeof ref !== "string"
    ? undefined
    : board.cards.find(
        (card) => card.id === ref || card.key.toLowerCase() === ref.trim().toLowerCase(),
      );

const ownCard = (
  board: BoardState,
  caller: ScheduleCaller,
  ref: unknown,
): BoardCard | ScheduleToolDecision => {
  const card = findBoardCardRef(board, ref);
  if (card === undefined || card.projectId !== caller.projectId) {
    return refuse(`'${String(ref)}' isn't a card in this schedule's project.`);
  }
  if (!caller.cards.has(card.id)) {
    return refuse(`'${card.key}' wasn't created by this schedule, so it can't change it.`);
  }
  return card;
};

const isDecision = (value: BoardCard | ScheduleToolDecision): value is ScheduleToolDecision =>
  "kind" in value;

/**
 * The one check at the board handler entry for a caller found among schedule runs. An
 * allowed call may come back with its params narrowed to the schedule's project.
 */
export function scheduleThreadPolicy(input: {
  readonly board: BoardState;
  readonly caller: ScheduleCaller;
  readonly tool: string;
  readonly params: Record<string, unknown>;
  /** For `board_set_automation`: whether the change resolves Auto-merge to on. */
  readonly turnsAutoMergeOn?: boolean;
}): ScheduleToolDecision {
  const { board, caller, tool, params } = input;
  if (CARD_SCOPED_TOOLS.has(tool)) {
    if (tool === "board_get_plan") return { kind: "allow" };
    return {
      kind: "refuse",
      code: "thread-not-linked",
      message:
        "This scheduled run isn't linked to a board card, so card-scoped tools can't resolve one. File a card with board_create_card instead.",
    };
  }
  switch (tool) {
    case "board_list_projects":
      return { kind: "allow" };
    case "board_list_cards": {
      if (params.projectId !== undefined && params.projectId !== caller.projectId) {
        return refuse(`List cards in project '${caller.projectId}' only.`);
      }
      return { kind: "allow", params: { ...params, projectId: caller.projectId } };
    }
    case "board_get_card": {
      const card = findBoardCardRef(board, params.card);
      if (card !== undefined && card.projectId !== caller.projectId) {
        return refuse(`'${card.key}' is in another project.`);
      }
      return { kind: "allow" };
    }
    case "board_create_card": {
      if (params.projectId !== undefined && params.projectId !== caller.projectId) {
        return refuse(`Create cards in project '${caller.projectId}' only.`);
      }
      if (params.stage !== undefined) {
        return refuse("Leave stage out: a scheduled run's cards start in Backlog.");
      }
      if (params.parentCardId !== undefined) {
        const parent = ownCard(board, caller, params.parentCardId);
        if (isDecision(parent)) return parent;
      }
      const dependsOn = Array.isArray(params.dependsOn) ? params.dependsOn : [];
      for (const ref of dependsOn) {
        const card = findBoardCardRef(board, ref);
        if (card !== undefined && card.projectId !== caller.projectId) {
          return refuse(`Dependency '${card.key}' is in another project.`);
        }
      }
      return { kind: "allow", params: { ...params, projectId: caller.projectId } };
    }
    case "board_update_card": {
      const card = ownCard(board, caller, params.cardId);
      if (isDecision(card)) return card;
      const added = Array.isArray(params.addDependsOn) ? params.addDependsOn : [];
      for (const ref of added) {
        const dependency = ownCard(board, caller, ref);
        if (isDecision(dependency)) return dependency;
      }
      return { kind: "allow" };
    }
    case "board_set_automation": {
      const card = ownCard(board, caller, params.cardId);
      if (isDecision(card)) return card;
      if (params.autoMerge === true || input.turnsAutoMergeOn === true) {
        return refuse(
          "Auto-merge can't be turned on from a scheduled run; a human reviews the merge.",
        );
      }
      return { kind: "allow" };
    }
    case "board_move_card": {
      const card = ownCard(board, caller, params.cardId);
      if (isDecision(card)) return card;
      if (params.parentCardId !== undefined) {
        return refuse("A scheduled run can't regroup cards.");
      }
      if (typeof params.toStage !== "string" || !SCHEDULE_CARD_STAGES.has(params.toStage)) {
        return refuse("Move this schedule's cards to Backlog, Sprint or Planning only.");
      }
      return { kind: "allow" };
    }
    default:
      return refuse(`${tool} isn't available to a scheduled run.`);
  }
}

/** A card a schedule run just created that must not stand: armed to merge, or past Planning. */
export const createdCardRefusal = (card: BoardCard, autoMergeOn: boolean): string | null =>
  autoMergeOn
    ? "It would inherit Auto-merge on, which would arm unreviewed work"
    : !SCHEDULE_CARD_STAGES.has(card.stage)
      ? "It would start past Planning, which would arm unreviewed work"
      : null;

/**
 * The card model-override popover's rows and fallbacks. Kept picker-free so the
 * kebab's summary renders eagerly while the popover stays lazily loaded.
 */
import {
  effectiveBoardStageRole,
  effectiveBoardRuntimeMode,
  isBoardReviewStageExecution,
  resolveBoardReviewTierModel,
  resolveBoardStageExecution,
  type BoardCard,
  type BoardCardStageModelOverride,
  type BoardCardModelOverrides,
  type BoardModelSelection,
  type BoardReviewLaterModel,
  type BoardSettings,
  type BoardStageDefinition,
  type BoardStageId,
  type RuntimeMode,
  type BoardProjectExecutionConfig,
} from "@t3tools/contracts";

/** One row of the popover: a stage the card can override, and the value it runs
    on today if it does not. */
export interface BoardCardModelRowSpec {
  readonly stageId: BoardStageId;
  readonly label: string;
  readonly note: string;
  /** The model this row inherits with no override set — the parent card's when
      it has one, else the workspace's. Null when nothing has named one. */
  readonly inheritedModel: BoardModelSelection | null;
  /** The parent card's key when the inherited value comes from the parent
      rather than the workspace, so the row can say so. */
  readonly inheritedFromCardKey: string | null;
  readonly inheritedRuntimeMode: RuntimeMode;
  /** Whether `inheritedRuntimeMode` is the parent override's own level rather than the stage's. */
  readonly inheritedRuntimeModeFromParent: boolean;
  /** The review row only: the later-rounds model Settings runs after `afterRound`, which any
      card or parent Review override replaces. `inheritedModel` is then the early rounds' model. */
  readonly laterRounds: BoardReviewLaterModel | null;
}

/** The label and note each role's row carries, from the prototype. */
const ROW_COPY = {
  plan: { label: "Planning", note: "Shapes the work into a plan" },
  build: { label: "Build", note: "Runs the plan in the worktree" },
  review: { label: "Review", note: "Adversarial review rounds" },
} as const;

/**
 * The popover's rows, resolved by role in pipeline order; a deleted role holder
 * yields no row. The review row reports the review phase's model, the one a
 * card-level override replaces.
 */
export function boardCardModelRows(input: {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly boardSettings: BoardSettings;
  readonly parentCard: Pick<BoardCard, "key" | "modelOverrides"> | null;
  /** The card's project's overrides. */
  readonly projectConfig?: BoardProjectExecutionConfig | null | undefined;
}): ReadonlyArray<BoardCardModelRowSpec> {
  const rows: BoardCardModelRowSpec[] = [];
  for (const role of ["plan", "build", "review"] as const) {
    // Matched on the EFFECTIVE role, so a legacy stage list — Planning and
    // Ready-for-merge were seeded before their roles existed and persist with a
    // null role — still reports its holder.
    const stage = input.stages.find((candidate) => effectiveBoardStageRole(candidate) === role);
    if (stage === undefined) continue;
    const exec = resolveBoardStageExecution(
      input.boardSettings,
      stage.stageId,
      input.projectConfig,
    );
    const review = isBoardReviewStageExecution(exec) ? exec : null;
    const workspaceModel =
      review === null ? exec.model : (resolveBoardReviewTierModel(review, 1) ?? review.model);
    const workspaceRuntimeMode =
      review === null
        ? exec.runtimeMode
        : effectiveBoardRuntimeMode(review.phases.review.runtimeMode, "build");
    // The parent's override outranks the workspace for a child that has none of
    // its own, so it is what the row must NAME as the inherited value — telling
    // a child it will run the workspace model when it will actually run its
    // parent's is the exact confusion this row exists to prevent.
    const inherited = input.parentCard?.modelOverrides?.[stage.stageId];
    rows.push({
      stageId: stage.stageId,
      label: ROW_COPY[role].label,
      note: ROW_COPY[role].note,
      inheritedModel:
        inherited === undefined
          ? workspaceModel
          : { instanceId: inherited.instanceId, model: inherited.model },
      inheritedFromCardKey: inherited === undefined ? null : (input.parentCard?.key ?? null),
      inheritedRuntimeMode: inherited?.runtimeMode ?? workspaceRuntimeMode,
      inheritedRuntimeModeFromParent: inherited?.runtimeMode !== undefined,
      laterRounds: review?.laterReviewModel ?? null,
    });
  }
  return rows;
}

/** Where a review round with no model of its own gets one. */
export type BoardReviewRoundModelSource = "card" | "parent" | "later" | "stage";

export interface BoardReviewRoundInheritedModel {
  readonly model: BoardModelSelection | null;
  readonly source: BoardReviewRoundModelSource;
  readonly runtimeMode: RuntimeMode;
}

/** The model a review round with no per-round override runs on, from the review row and the
    card's own Review override. Null model means the workspace default. Mirrors the
    executor's ladder below the round override. */
export function boardReviewRoundInheritedModel(input: {
  readonly row: BoardCardModelRowSpec;
  readonly cardOverride: BoardCardStageModelOverride | null | undefined;
  readonly round: number;
}): BoardReviewRoundInheritedModel {
  const { row, cardOverride, round } = input;
  const later =
    row.laterRounds !== null && round > row.laterRounds.afterRound ? row.laterRounds : null;
  // The access level resolves independently of the model, as the executor does: a rung
  // naming a model but no level falls through to the round's tier level.
  const tierRuntimeMode =
    (row.inheritedRuntimeModeFromParent ? undefined : later?.runtimeMode) ??
    row.inheritedRuntimeMode;
  if (cardOverride != null) {
    return {
      model: { instanceId: cardOverride.instanceId, model: cardOverride.model },
      source: "card",
      runtimeMode: cardOverride.runtimeMode ?? tierRuntimeMode,
    };
  }
  if (row.inheritedFromCardKey !== null) {
    return { model: row.inheritedModel, source: "parent", runtimeMode: tierRuntimeMode };
  }
  if (later !== null) return { model: later.model, source: "later", runtimeMode: tierRuntimeMode };
  return { model: row.inheritedModel, source: "stage", runtimeMode: tierRuntimeMode };
}

/** The kebab item's right-aligned summary: which of the rows this card has
    actually overridden. Only the card's OWN overrides count — an inherited
    value is not something this card set. */
export function boardCardModelOverrideSummary(
  rows: ReadonlyArray<BoardCardModelRowSpec>,
  overrides: BoardCardModelOverrides | null,
): string {
  const touched = rows.filter((row) => overrides?.[row.stageId] !== undefined);
  return touched.length === 0 ? "Default" : touched.map((row) => row.label).join(" · ");
}

/** Whether this card sets any override at all — what gates the header pill and
    the popover's Reset button. */
export function hasBoardCardModelOverride(
  rows: ReadonlyArray<BoardCardModelRowSpec>,
  overrides: BoardCardModelOverrides | null,
): boolean {
  return rows.some((row) => overrides?.[row.stageId] !== undefined);
}

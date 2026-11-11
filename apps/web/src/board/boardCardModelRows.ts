/**
 * The card model-override popover's rows and fallbacks. Kept picker-free so the
 * kebab's summary renders eagerly while the popover stays lazily loaded.
 */
import {
  effectiveBoardStageRole,
  effectiveBoardRuntimeMode,
  isBoardReviewStageExecution,
  resolveBoardStageExecution,
  type BoardCard,
  type BoardCardModelOverrides,
  type BoardModelSelection,
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
      review === null ? exec.model : (review.phases.review.model ?? review.model);
    const workspaceRuntimeMode =
      review === null
        ? exec.runtimeMode
        : effectiveBoardRuntimeMode(review.phases.review.runtimeMode, "build");
    // The parent's override outranks the workspace for a child that has none of
    // its own, so it is what the row must NAME as the inherited value — telling
    // a child it will run the workspace model when it will actually run its
    // parent's is the exact confusion D5 exists to prevent.
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
    });
  }
  return rows;
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

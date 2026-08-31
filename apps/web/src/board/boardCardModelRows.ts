/**
 * What the card's model-override popover offers, and what each row falls back
 * to when the card says nothing (t3o-29, D1/D5).
 *
 * Pure and picker-free on purpose. The popover itself drags the model list, the
 * traits menu and the access picker, so it is lazily loaded — but the kebab
 * needs this card's summary ("Default" / "Build · Review") to render the menu
 * item, before anyone has opened anything. Splitting the derivation out is what
 * lets the summary be eager and the pickers not.
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
} from "@t3tools/contracts";

/** One row of the popover: a stage the card can override, and the value it runs
    on today if it does not. */
export interface BoardCardModelRowSpec {
  readonly stageId: BoardStageId;
  readonly label: string;
  readonly note: string;
  /** The model this row inherits with no override set — the parent card's when
      it has one (D4), else the workspace's. Null when nothing has named one. */
  readonly inheritedModel: BoardModelSelection | null;
  /** The parent card's key when the inherited value comes from the parent
      rather than the workspace, so the row can say so (D5). */
  readonly inheritedFromCardKey: string | null;
  readonly inheritedRuntimeMode: RuntimeMode;
}

/** The label and note each role's row carries, from the prototype. */
const ROW_COPY = {
  build: { label: "Build", note: "Runs the plan in the worktree" },
  review: { label: "Review", note: "Adversarial review rounds" },
} as const;

/**
 * The two rows the popover offers, resolved by ROLE — the stages holding the
 * `build` and `review` roles. A board whose role-holder was deleted simply
 * yields one row, rather than offering an override nothing would ever read.
 *
 * Only the REVIEW PHASE's model is reported for the review row: that is what a
 * card-level review override re-points (D3), so showing the stage's fallback
 * here would name a model the override does not actually replace.
 */
export function boardCardModelRows(input: {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly boardSettings: BoardSettings;
  readonly parentCard: Pick<BoardCard, "key" | "modelOverrides"> | null;
}): ReadonlyArray<BoardCardModelRowSpec> {
  const rows: BoardCardModelRowSpec[] = [];
  for (const role of ["build", "review"] as const) {
    // Matched on the EFFECTIVE role, so a legacy stage list — Planning and
    // Ready-for-merge were seeded before their roles existed and persist with a
    // null role — still reports its holder.
    const stage = input.stages.find((candidate) => effectiveBoardStageRole(candidate) === role);
    if (stage === undefined) continue;
    const exec = resolveBoardStageExecution(input.boardSettings, stage.stageId);
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

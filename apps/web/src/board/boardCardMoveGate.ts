/**
 * The pre-build dependency gate (T3O-24, D7) — pure, so the decision is
 * testable without rendering a modal.
 *
 * `BoardCard.blocked` is derived from the BUILD ROLE ONWARD (D11/D18,
 * `deriveBoardCardBlocked`), so a card waiting at Ready always carries
 * `blocked === false` — and the detail's forward button, which disables on
 * that flag, would be live at the one gate where the dependency rule actually
 * bites. The detail already resolves every dependency, so it asks here.
 */
import {
  isBoardStageAtOrAfterBuild,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
} from "@t3tools/contracts";

/** A `BoardState` view over a bare stage list, so the read-model stage helpers
    apply to the stage list the detail holds. */
const stageStateOf = (stages: ReadonlyArray<BoardStageDefinition>): BoardState => ({
  cards: [],
  stages,
  nextCardNumberByProject: {},
});

/**
 * Whether the forward button would be refused by the dependency gate, so it
 * must be disabled and the blocker callout must render. Mirrors the decider's
 * move arm exactly: a CROSSING into the build-or-after zone with something
 * unmet. A move that stays before build, or that is already inside the zone,
 * is not a crossing.
 */
export function boardCardMoveBlocked(input: {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  /** Where the card is now. */
  readonly stage: BoardStageId;
  /** Where the forward button would move it, or null when it offers no move. */
  readonly toStage: BoardStageId | null;
  /** How many of the card's dependencies are still outstanding. */
  readonly unmetCount: number;
}): boolean {
  const state = stageStateOf(input.stages);
  const crossesIntoBuild =
    input.toStage !== null &&
    !isBoardStageAtOrAfterBuild(state, input.stage) &&
    isBoardStageAtOrAfterBuild(state, input.toStage);
  return crossesIntoBuild && input.unmetCount > 0;
}

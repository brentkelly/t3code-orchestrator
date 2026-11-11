/**
 * The pre-build dependency gate. `BoardCard.blocked` only applies from the build
 * role onward, so a card at Ready reads unblocked; the detail resolves its
 * dependencies and asks here instead.
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
 * Whether the dependency gate would refuse the forward button. Mirrors the
 * decider: only a crossing into the build-or-after zone with something unmet.
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

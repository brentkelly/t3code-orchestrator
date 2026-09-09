/**
 * The auto-start control and the dependency gate it sits under (T3O-24) —
 * pure, so both decisions are testable without rendering a modal.
 *
 * Two halves of one truth. `BoardCard.blocked` is derived from the BUILD ROLE
 * ONWARD (D11/D18, `deriveBoardCardBlocked`), so a card waiting at Ready always
 * carries `blocked === false` — and the detail's forward button, which disables
 * on that flag, is live at the one gate where the dependency rule actually
 * bites. The decider refuses the move and prints a raw invariant into the
 * modal. That is the reported bug, and D7 fixes it here rather than by changing
 * the stored derivation: the detail already resolves every dependency, so it
 * has what it needs to tell the truth; it just never asked.
 *
 * The arm is the same reading with the outcome inverted — the card that would
 * be refused is exactly the card worth arming.
 */
import {
  isBoardStageAtOrAfterBuild,
  type BoardCardId,
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

export interface BoardCardAutoStartGateInput {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  /** Where the card is now. */
  readonly stage: BoardStageId;
  /** Where the forward button would move it, or null when it offers no move
      (an archived card, a merge button, a card at the end of the pipeline). */
  readonly toStage: BoardStageId | null;
  /** Sub-board children are out of scope: they already start themselves off
      their siblings (`cascadeUnblockedChildren`, t3o-28 D3). */
  readonly parentCardId: BoardCardId | null;
  readonly archived: boolean;
  /** How many of the card's dependencies are still outstanding, by the
      contracts' definition — the count the detail already computes. */
  readonly unmetCount: number;
}

export interface BoardCardAutoStartGate {
  /** Whether the forward button would be refused by the dependency gate, so it
      must be disabled and the blocker callout must render. Mirrors the
      decider's move arm exactly: a CROSSING into the build-or-after zone with
      something unmet. A move that stays before build, or that is already
      inside the zone, is not a crossing. */
  readonly moveBlocked: boolean;
  /** Whether the auto-start switch may be offered (D2) — the client's reading
      of `boardCardCanArmAutoStart`, which the decider enforces on the way in.
      Deliberately keyed on the FORWARD ACTION crossing into build rather than
      on the stage's name: a board that renamed or reordered its pipeline is
      still armable wherever "the stage before the build stage" ended up. */
  readonly canArm: boolean;
}

export function boardCardAutoStartGate(input: BoardCardAutoStartGateInput): BoardCardAutoStartGate {
  const state = stageStateOf(input.stages);
  const crossesIntoBuild =
    input.toStage !== null &&
    !isBoardStageAtOrAfterBuild(state, input.stage) &&
    isBoardStageAtOrAfterBuild(state, input.toStage);
  const moveBlocked = crossesIntoBuild && input.unmetCount > 0;
  return {
    moveBlocked,
    canArm: moveBlocked && !input.archived && input.parentCardId === null,
  };
}

export interface BoardCardAutoStartCopy {
  readonly label: string;
  readonly hint: string;
}

/**
 * The switch row's two states (D9), per the brief's mockups. Off states the
 * consequence of leaving it off, because the whole point of the feature is
 * that the alternative is coming back to check; on states what will happen and
 * when.
 */
export function boardCardAutoStartCopy(armed: boolean): BoardCardAutoStartCopy {
  return armed
    ? {
        label: "Will start automatically",
        hint: "Moves to Building the moment the last dependency is done.",
      }
    : {
        label: "Start automatically when unblocked",
        hint: "Otherwise this card waits here until you come back and start it.",
      };
}

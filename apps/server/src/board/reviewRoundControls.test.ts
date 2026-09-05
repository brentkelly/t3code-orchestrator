/**
 * The reactor's re-plan-on-edit tail (t3o-22, D6), against the LIVE reactor.
 *
 * The tail exists so that raising a held review loop's round budget makes it
 * plan the next round — `continueStage` only ever runs off a step settling, and
 * a loop held at its cap has already settled, so without this nothing would ask
 * the executor again.
 *
 * It is deliberately role-AGNOSTIC (an `if (stage.role === "review")` would be
 * the first leak of review logic into the reactor, breaking t3o-16 AC10), which
 * means it runs on EVERY card edit at EVERY stage — a title, a label, a
 * dependency. These tests pin the blast radius of that: an edit may resume work
 * the executor genuinely has left, and must do nothing at all otherwise.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  type BoardCard,
  type BoardCardStepState,
  type OrchestrationEvent,
} from "@t3tools/contracts";

import {
  buildingCard,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  NOW,
  settingsWith,
  stepCompleted,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");

/** A card edit — the event the re-plan tail hangs off. Any field will do; the
    tail never looks at which one changed, which is the point. */
const cardUpdated = (card: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-updated",
    sequence,
    payload: { cardId: card.id, card },
  }) as unknown as OrchestrationEvent;

/** A settled-but-unsuccessful step left on a card at an auto-executing stage —
    what `handleCardMoved` stamps on an outgoing step it abandons. */
const abandonedStep = (stage: string): BoardCardStepState => ({
  cardId,
  stepId: String(BoardStageId.make(stage)),
  stepLabel: null,
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question" as const,
  prompt: "do it",
  providerInstanceId: codexStep.providerInstanceId,
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 600_000,
  threadId: null,
  status: "abandoned",
  slotHeld: false,
  forceStart: false,
  startedAt: null,
  updatedAt: NOW,
});

it.effect("t3o-22 D6: a card edit does NOT resurrect an abandoned step at an auto-exec stage", () =>
  withGovernor(
    {
      board: {
        cards: [buildingCard("card-1", "m")],
        stepStates: [abandonedStep("building")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, board, decided }) =>
      Effect.gen(function* () {
        // `SimpleStageExecutor` decides from SUCCEEDED completions alone, so it
        // sees no completion for this stage's step and plans a fresh `run` —
        // even though the card is carrying an abandoned step, which is exactly
        // the state a human's manually adopted thread leaves behind. Renaming
        // the card must not spawn an agent beside them.
        yield* pumpDomain(cardUpdated({ ...buildingCard("card-1", "m"), title: "Renamed" }, 2));

        const selects = (yield* decided).filter(
          (event) => event.type === "board.card-step-selected",
        );
        assert.strictEqual(selects.length, 0);
        assert.strictEqual(yield* slots.heldTotal, 0);
        // The abandoned step is left exactly as it was.
        assert.strictEqual(stepStatus(yield* board, cardId), "abandoned");
      }),
  ),
);

it.effect("t3o-22 D6: a card edit is a no-op for a stage whose step already succeeded", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("card-1", "m")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(buildingCard("card-1", "m"), 1));
        // The build succeeds and the card auto-advances out of Building.
        yield* pumpDomain(stepCompleted(cardId, "succeeded", 2));
        // The one automatic crossing (D18) has happened.
        assert.strictEqual((yield* board).cards[0]?.stage, BOARD_SEED_STAGE_IDS.review);

        yield* pumpDomain(
          cardUpdated(
            { ...(yield* board).cards[0]!, title: "Renamed after the build" } as BoardCard,
            3,
          ),
        );

        // `SimpleStageExecutor` reports `complete` for the settled Building
        // step, and a `complete` plan must stay a no-op here — routing it back
        // into `advanceStage` would let any card edit walk a card one more
        // stage down the pipeline every time someone renamed it.
        assert.strictEqual((yield* board).cards[0]?.stage, BOARD_SEED_STAGE_IDS.review);
      }),
  ),
);

it.effect("t3o-22 D6: an edit at a manual (non-auto-exec) stage starts nothing", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "card-1", stage: BOARD_SEED_STAGE_IDS.sprint, orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, decided }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardUpdated(
            {
              ...makeBoardCard({
                id: "card-1",
                stage: BOARD_SEED_STAGE_IDS.sprint,
                orderKey: "m",
              }),
              title: "Renamed",
            },
            2,
          ),
        );
        assert.strictEqual(
          (yield* decided).filter((event) => event.type === "board.card-step-selected").length,
          0,
        );
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

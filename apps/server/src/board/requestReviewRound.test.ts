/**
 * "Another review round" / "Request review" at the assembled reactor (T3O-39).
 *
 * The pure half — a converged loop planning `review@N+1` once the card carries
 * `runThroughRound` — lives in `reviewLoopExecutor.test.ts`. What is proved
 * here is the thing the RPC exists for: the ORDERING. The override is written
 * before the card moves, because a move that landed first would have the
 * executor re-plan a converged loop, complete `succeeded`, and bounce the card
 * straight back to Ready for merge.
 *
 * The refusals are asserted the same way the merge and submit ones are: each is
 * a sentence the card shows, and a button that silently does nothing is what
 * this whole feature replaces.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  type BoardCard,
  type BoardCardStepState,
  type BoardStageDefinition,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  NOW,
  cardStage,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const cardId = BoardCardId.make("card-1");

const card = (stage: string, patch: Partial<BoardCard> = {}): BoardCard => ({
  ...makeBoardCard({
    id: "card-1",
    stage,
    orderKey: "m",
    worktree: readyWorktree("card-1"),
  }),
  ...patch,
});

/** The settled last step of a loop that CONVERGED — recorded at "main", which
    the harness's rev-parse stub answers, so the base reads fresh and nothing
    plans a sync step instead. */
const settledReviewStep = (
  stepId = "review@1",
  patch: Partial<BoardCardStepState> = {},
): BoardCardStepState => ({
  cardId,
  stepId,
  stepLabel: "Review · round 1",
  stageLabel: "Code review",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: "main",
  lastError: null,
  awaitingReason: "question" as const,
  stalledReason: "gave-up" as const,
  retryAt: null,
  prompt: "review it",
  providerInstanceId: codexStep.providerInstanceId,
  model: "gpt-5-codex",
  mode: "build" as const,
  runtimeMode: "auto" as const,
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 600_000,
  threadId: null,
  status: "succeeded" as const,
  slotHeld: false,
  forceStart: false,
  startedAt: null,
  updatedAt: NOW,
  ...patch,
});

/** A clean round 1: the review raised nothing blocking, so the loop converged
    and would complete `succeeded` on every re-plan. */
const convergedRound = {
  cardId,
  stepId: "review@1",
  outcome: "succeeded" as const,
  summary: "clean",
  payload: JSON.stringify({ reviewedSha: "sha-reviewed", findings: [] }),
  threadId: null,
  completedAt: NOW,
};

const settings = () => settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });

/** The card-moved event the RPC's move produces once it streams back through
    the engine — the harness's double does not feed decided events back in. */
const cardMovedBack = (moved: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-moved",
    sequence,
    payload: {
      cardId: moved.id,
      card: moved,
      fromStage: String(BOARD_SEED_STAGE_IDS.merge),
      toStage: String(BOARD_SEED_STAGE_IDS.review),
    },
  }) as unknown as OrchestrationEvent;

/** The card-updated event the override write produces, likewise. */
const cardUpdated = (updated: BoardCard, sequence: number): OrchestrationEvent =>
  ({
    type: "board.card-updated",
    sequence,
    payload: { cardId: updated.id, card: updated },
  }) as unknown as OrchestrationEvent;

const cardOf = (board: { readonly cards: ReadonlyArray<BoardCard> }): BoardCard =>
  board.cards.find((candidate) => candidate.id === cardId)!;

// ── D6: the write-then-move ordering, from Ready for merge ───────────────────

it.effect("D6: a converged card at merge gets the override written BEFORE it moves", () =>
  withGovernor(
    {
      board: {
        cards: [card(String(BOARD_SEED_STAGE_IDS.merge))],
        stepStates: [settledReviewStep()],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor, board, commands }) =>
      Effect.gen(function* () {
        const result = yield* reactor.requestReviewRound(cardId);
        yield* reactor.drain;
        assert.deepStrictEqual(result, { outcome: "started", round: 2 });

        // The card carries the request AND has landed back in Code review.
        const moved = cardOf(yield* board);
        assert.strictEqual(moved.reviewOverrides?.runThroughRound, 2);
        assert.strictEqual(cardStage(yield* board, cardId), String(BOARD_SEED_STAGE_IDS.review));

        // The ordering itself, which is the whole reason this is an RPC: the
        // update is dispatched before the move. Reversed, the executor would
        // re-plan a loop that still reads converged and bounce the card back.
        const relevant = (yield* commands)
          .filter(
            (command) => command.type === "board.card.update" || command.type === "board.card.move",
          )
          .map((command) => command.type);
        assert.deepStrictEqual(relevant, ["board.card.update", "board.card.move"]);
      }),
  ),
);

it.effect("D6: the card arriving back in review runs round 2, and does not bounce", () =>
  withGovernor(
    {
      board: {
        cards: [card(String(BOARD_SEED_STAGE_IDS.merge))],
        stepStates: [settledReviewStep()],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor, board, pumpDomain }) =>
      Effect.gen(function* () {
        yield* reactor.requestReviewRound(cardId);
        yield* reactor.drain;

        // The move's own arrival (in production it streams back through the
        // engine) re-enters the review stage. With the override already on the
        // card the executor plans round 2; without it the loop would read
        // converged, complete `succeeded`, and `advanceStage` would send the
        // card straight back to Ready for merge.
        yield* pumpDomain(cardMovedBack(cardOf(yield* board), 20));

        assert.strictEqual(boardCardStepState(yield* board, cardId)?.stepId, "review@2");
        assert.strictEqual(cardStage(yield* board, cardId), String(BOARD_SEED_STAGE_IDS.review));
      }),
  ),
);

// ── D6: the converged-in-place case is the same call, minus the move ─────────

it.effect("D6: a converged card already in review is not moved, and replans in place", () =>
  withGovernor(
    {
      board: {
        cards: [card(String(BOARD_SEED_STAGE_IDS.review))],
        stepStates: [settledReviewStep()],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor, board, commands, pumpDomain }) =>
      Effect.gen(function* () {
        const result = yield* reactor.requestReviewRound(cardId);
        yield* reactor.drain;
        assert.deepStrictEqual(result, { outcome: "started", round: 2 });

        // No move: the card is already where the round runs, and a move to the
        // stage it is on would be refused anyway.
        assert.strictEqual(
          (yield* commands).filter((command) => command.type === "board.card.move").length,
          0,
        );

        // The edit's own arrival is what re-plans a settled stage (t3o-22, D6).
        yield* pumpDomain(cardUpdated(cardOf(yield* board), 20));
        assert.strictEqual(boardCardStepState(yield* board, cardId)?.stepId, "review@2");
      }),
  ),
);

// ── D7: "Request review" is the same verb with an empty ledger ───────────────

it.effect("D7: a card at merge with no review history is sent to round 1", () =>
  withGovernor(
    {
      board: {
        cards: [card(String(BOARD_SEED_STAGE_IDS.merge))],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor, board, pumpDomain }) =>
      Effect.gen(function* () {
        const result = yield* reactor.requestReviewRound(cardId);
        yield* reactor.drain;
        assert.deepStrictEqual(result, { outcome: "started", round: 1 });
        assert.strictEqual(cardOf(yield* board).reviewOverrides?.runThroughRound, 1);

        yield* pumpDomain(cardMovedBack(cardOf(yield* board), 20));
        assert.strictEqual(boardCardStepState(yield* board, cardId)?.stepId, "review@1");
      }),
  ),
);

// ── D10: the row that says WHY the card walked back ─────────────────────────

it.effect("D10: the request writes an activity note naming the round", () =>
  withGovernor(
    {
      board: {
        cards: [card(String(BOARD_SEED_STAGE_IDS.merge))],
        stepStates: [settledReviewStep()],
        stepCompletions: [convergedRound],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor, decided }) =>
      Effect.gen(function* () {
        yield* reactor.requestReviewRound(cardId);
        yield* reactor.drain;

        // `card-moved` says where, never why. Without this row a card jumping
        // from Ready for merge back to Code review reads as a drag that
        // silently snapped back.
        const notes = (yield* decided).filter(
          (event) =>
            event.type === "board.card-note-recorded" &&
            JSON.stringify(event).includes("card-review-round-requested"),
        );
        assert.strictEqual(notes.length, 1);
        assert.include(JSON.stringify(notes[0]), "review round 2");
      }),
  ),
);

// ── D8/D9: every refusal the button's guards mirror ─────────────────────────

it.effect("refuses a card on neither the review nor the merge stage", () =>
  withGovernor(
    {
      board: {
        cards: [card(String(BOARD_SEED_STAGE_IDS.building))],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.requestReviewRound(cardId), {
          outcome: "wrong-stage",
        });
        yield* reactor.drain;
        // And nothing was written: a refusal must not leave half a request.
        assert.strictEqual(cardOf(yield* board).reviewOverrides, null);
      }),
  ),
);

it.effect("D12: refuses a card at Done, whose pull request has already retired", () =>
  withGovernor(
    {
      board: {
        cards: [card(String(BOARD_SEED_STAGE_IDS.done))],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.requestReviewRound(cardId), {
          outcome: "wrong-stage",
        });
      }),
  ),
);

it.effect("refuses a board with no review-role stage to run the round in", () =>
  withGovernor(
    {
      board: {
        cards: [card("merge")],
        stages: BOARD_SEED_STAGES.filter(
          (stage: BoardStageDefinition) => stage.stageId !== BOARD_SEED_STAGE_IDS.review,
        ),
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.requestReviewRound(cardId), {
          outcome: "no-review-stage",
        });
      }),
  ),
);

it.effect("refuses a card with no branch to review", () =>
  withGovernor(
    {
      board: {
        cards: [{ ...card(String(BOARD_SEED_STAGE_IDS.merge)), worktree: null }],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.requestReviewRound(cardId), {
          outcome: "no-branch",
        });
      }),
  ),
);

it.effect("D9: refuses while a step is live, rather than superseding it", () =>
  withGovernor(
    {
      board: {
        cards: [card(String(BOARD_SEED_STAGE_IDS.merge))],
        // A merge-conflict fix mid-rebase is exactly this: a live step on the
        // card. Killing it to start a review round would abandon a rebase
        // somebody is halfway through.
        stepStates: [
          settledReviewStep(String(BOARD_SEED_STAGE_IDS.merge), {
            status: "running",
            stepLabel: "Resolve merge conflicts",
          }),
        ],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.requestReviewRound(cardId), {
          outcome: "step-running",
        });
        yield* reactor.drain;
        assert.strictEqual(cardStage(yield* board, cardId), String(BOARD_SEED_STAGE_IDS.merge));
      }),
  ),
);

it.effect("refuses an archived card", () =>
  withGovernor(
    {
      board: {
        cards: [{ ...card(String(BOARD_SEED_STAGE_IDS.merge)), archivedAt: NOW }],
        nextCardNumberByProject: {},
      },
      settings: settings(),
    },
    ({ reactor }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.requestReviewRound(cardId), {
          outcome: "unknown-card",
        });
      }),
  ),
);

it.effect("refuses a card that does not exist", () =>
  withGovernor(
    { board: { cards: [], nextCardNumberByProject: {} }, settings: settings() },
    ({ reactor }) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reactor.requestReviewRound(BoardCardId.make("nope")), {
          outcome: "unknown-card",
        });
      }),
  ),
);

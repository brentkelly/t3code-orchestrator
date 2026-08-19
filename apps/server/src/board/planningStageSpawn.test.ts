/**
 * t3o-14 — Planning stage auto-spawn acceptance suite.
 *
 * Entering Planning starts the planning conversation by itself: the board
 * creates a thread, links it to the card, and sends the settings prompt in the
 * planning envelope. These tests run the LIVE reactor through the shared
 * `withGovernor` harness (real decider + projector over a stateful engine
 * double), so every assertion is over the board state a real dispatch produces.
 *
 * The link IS the observable. The engine double applies board commands, and
 * `thread.turn.start` is not one — so a spawn shows up as a live
 * `board.card.link-thread` on the card, which is also the thing that makes the
 * agent's `board_get_card_context` resolve its card at all (D3).
 *
 * The load-bearing invariants, asserted directly rather than by comment:
 *   - D1: planning enters NONE of the step machine — no step state, no worktree,
 *     no governor slot. A planning conversation is human-paced; holding a build
 *     slot or being "recovered" every time it waits for a reply would be wrong.
 *   - D5: any live link of any role suppresses the spawn; a tombstoned one does not.
 *   - D6: created-into-Planning spawns exactly like moved-into-Planning.
 *   - D18 still holds: nothing here moves a card across a stage boundary.
 */
import { BoardCardId, DEFAULT_BOARD_PLANNING_STEP } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  NOW,
  cardCreated,
  cardMoved,
  cardStage,
  codexStep,
  liveThreadLinks,
  makeBoardCard,
  movedToPlanning,
  settingsWith,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const planningCard = (
  id: string,
  threadLinks?: Parameters<typeof makeBoardCard>[0]["threadLinks"],
) =>
  makeBoardCard({ id, stage: "planning", orderKey: "m", ...(threadLinks ? { threadLinks } : {}) });

const planningSettings = settingsWith({
  building: [codexStep],
  globalMaxConcurrent: 3,
  planning: [DEFAULT_BOARD_PLANNING_STEP],
});

// ── The spawn ────────────────────────────────────────────────────────────────
it.effect("a card moved into Planning gets a planning thread, linked with the step's id", () =>
  withGovernor(
    {
      board: { cards: [planningCard("card-1")], nextCardNumberByProject: {} },
      settings: planningSettings,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(movedToPlanning(planningCard("card-1"), 1));

        const links = liveThreadLinks(yield* board, id);
        assert.strictEqual(links.length, 1);
        assert.strictEqual(links[0]!.role, DEFAULT_BOARD_PLANNING_STEP.id);
      }),
  ),
);

// ── D1: none of the step machine ─────────────────────────────────────────────
it.effect("D1: planning takes no step state, no worktree and no governor slot", () =>
  withGovernor(
    {
      board: { cards: [planningCard("card-1")], nextCardNumberByProject: {} },
      settings: planningSettings,
    },
    ({ pumpDomain, board, slots }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(movedToPlanning(planningCard("card-1"), 1));

        const state = yield* board;
        const card = state.cards.find((candidate) => candidate.id === id);
        // The thread exists…
        assert.strictEqual(liveThreadLinks(state, id).length, 1);
        // …and nothing else does. A grill session that held a build slot, or was
        // nudged for "dying" every time it waited on a human, is the failure this
        // guards against.
        assert.strictEqual(stepStatus(state, id), null);
        assert.strictEqual(card?.worktree ?? null, null);
        assert.strictEqual(card?.recipeSnapshot ?? null, null);
        assert.strictEqual(yield* slots.heldTotal, 0);
        // D18: the card is still in Planning. The board never advances it.
        assert.strictEqual(cardStage(state, id), "planning");
      }),
  ),
);

// ── D5: suppression ──────────────────────────────────────────────────────────
it.effect("D5: a card that already carries a live thread gets no second one", () =>
  withGovernor(
    {
      board: {
        cards: [
          planningCard("card-1", [
            {
              threadId: "thread-existing" as never,
              role: "build",
              linkedAt: NOW,
              tombstonedAt: null,
            },
          ]),
        ],
        nextCardNumberByProject: {},
      },
      settings: planningSettings,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(movedToPlanning(planningCard("card-1"), 1, "building"));

        // Any live link of any role suppresses — which is exactly why a card
        // dragged back from Building for rework gets nothing new, and why the
        // "+ → restart planning" menu item exists as the escape hatch.
        const links = liveThreadLinks(yield* board, id);
        assert.strictEqual(links.length, 1);
        assert.strictEqual(links[0]!.role, "build");
      }),
  ),
);

it.effect("D5: a tombstoned link does not suppress — the deleted thread is replaced", () =>
  withGovernor(
    {
      board: {
        cards: [
          planningCard("card-1", [
            { threadId: "thread-dead" as never, role: "plan", linkedAt: NOW, tombstonedAt: NOW },
          ]),
        ],
        nextCardNumberByProject: {},
      },
      settings: planningSettings,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(movedToPlanning(planningCard("card-1"), 1));

        const links = liveThreadLinks(yield* board, id);
        assert.strictEqual(links.length, 1);
        assert.notStrictEqual(String(links[0]!.threadId), "thread-dead");
      }),
  ),
);

// ── D6: created into Planning counts as entering Planning ────────────────────
it.effect("D6: a card created straight into Planning spawns too", () =>
  withGovernor(
    {
      board: { cards: [planningCard("card-1")], nextCardNumberByProject: {} },
      settings: planningSettings,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(cardCreated(planningCard("card-1"), 1));

        assert.strictEqual(liveThreadLinks(yield* board, id).length, 1);
      }),
  ),
);

it.effect("a card created into Backlog spawns nothing", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "card-1", stage: "backlog", orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: planningSettings,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardCreated(makeBoardCard({ id: "card-1", stage: "backlog", orderKey: "m" }), 1),
        );
        assert.strictEqual(liveThreadLinks(yield* board, BoardCardId.make("card-1")).length, 0);
      }),
  ),
);

// ── Settings govern it ───────────────────────────────────────────────────────
it.effect("clearing every planning step in settings switches the spawn off", () =>
  withGovernor(
    {
      board: { cards: [planningCard("card-1")], nextCardNumberByProject: {} },
      // No `planning` key at all: the stage has no steps.
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(planningCard("card-1"), 1));
        assert.strictEqual(liveThreadLinks(yield* board, BoardCardId.make("card-1")).length, 0);
      }),
  ),
);

// ── Other stages are untouched ───────────────────────────────────────────────
it.effect("moving a card into Ready spawns nothing — Ready is a resting state", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "card-1", stage: "ready", orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: planningSettings,
    },
    ({ pumpDomain, board, slots }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({ id: "card-1", stage: "ready", orderKey: "m" }),
            "planning",
            "ready",
            1,
          ),
        );
        assert.strictEqual(liveThreadLinks(yield* board, BoardCardId.make("card-1")).length, 0);
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

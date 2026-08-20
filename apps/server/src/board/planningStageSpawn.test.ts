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
import {
  BOARD_PLANNING_THREAD_INTERACTION_MODE,
  BOARD_PLANNING_THREAD_RUNTIME_MODE,
  BoardCardId,
  DEFAULT_BOARD_PLANNING_STEP,
  boardPlanningThreadTitle,
  composeBoardPlanningPrompt,
} from "@t3tools/contracts";
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

// ── The bootstrap: what KIND of thread a spawn produces ─────────────────────
// The web client's "restart planning" builds the same payload
// (`apps/web/src/board/boardCardThreadSpawn.ts`, covered by its own test). These
// two suites are the cross-check: the fields are stated in both places, so both
// places assert them. The shared pieces — prompt, title, and the two modes —
// are compared against their contracts composers rather than against literals,
// so a change there fails on whichever side forgot to follow.
it.effect("spawns onto the project workspace, read-only, with the shared envelope", () =>
  withGovernor(
    {
      board: { cards: [planningCard("card-1")], nextCardNumberByProject: {} },
      settings: planningSettings,
    },
    ({ pumpDomain, threadCommands }) =>
      Effect.gen(function* () {
        const card = planningCard("card-1");
        yield* pumpDomain(movedToPlanning(card, 1));

        const started = (yield* threadCommands).find(
          (command) => (command as { readonly type: string }).type === "thread.turn.start",
        ) as
          | {
              readonly message: { readonly text: string };
              readonly runtimeMode: string;
              readonly interactionMode: string;
              readonly bootstrap?: { readonly createThread?: Record<string, unknown> };
            }
          | undefined;
        assert.isDefined(started);

        const created = started!.bootstrap?.createThread;
        assert.isDefined(created);
        // No worktree and no branch: planning is a conversation about a card that
        // may never be built.
        assert.strictEqual(created!["worktreePath"], null);
        assert.strictEqual(created!["branch"], null);
        assert.strictEqual(created!["projectId"], card.projectId);
        assert.strictEqual(
          created!["title"],
          boardPlanningThreadTitle(card, DEFAULT_BOARD_PLANNING_STEP),
        );
        assert.deepStrictEqual(created!["modelSelection"], {
          instanceId: DEFAULT_BOARD_PLANNING_STEP.providerInstanceId,
          model: DEFAULT_BOARD_PLANNING_STEP.model,
        });
        // It runs on the SHARED working tree with nothing human-gating its start,
        // so it must not be able to write unattended — `full-access` here would be
        // Codex's danger-full-access sandbox on the user's real checkout.
        assert.strictEqual(BOARD_PLANNING_THREAD_RUNTIME_MODE, "approval-required");
        assert.strictEqual(started!.runtimeMode, BOARD_PLANNING_THREAD_RUNTIME_MODE);
        assert.strictEqual(created!["runtimeMode"], BOARD_PLANNING_THREAD_RUNTIME_MODE);
        assert.strictEqual(started!.interactionMode, BOARD_PLANNING_THREAD_INTERACTION_MODE);
        assert.strictEqual(created!["interactionMode"], BOARD_PLANNING_THREAD_INTERACTION_MODE);
        // The prompt is the shared envelope, not something composed here.
        assert.strictEqual(
          started!.message.text,
          composeBoardPlanningPrompt({ card, step: DEFAULT_BOARD_PLANNING_STEP }),
        );
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
      // An explicitly persisted empty array — what the settings UI writes when
      // you remove a stage's last step. This, not an absent key, is "off".
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3, planning: [] }),
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToPlanning(planningCard("card-1"), 1));
        assert.strictEqual(liveThreadLinks(yield* board, BoardCardId.make("card-1")).length, 0);
      }),
  ),
);

it.effect("an upgrade whose settings predate Planning still spawns the compiled-in step", () =>
  withGovernor(
    {
      board: { cards: [planningCard("card-1")], nextCardNumberByProject: {} },
      // No `planning` key at all — the shape every install has that ever edited
      // the Building prompt, since settings are stripped per key. Absent means
      // "never configured", so the compiled-in default applies; the feature must
      // not be silently off for exactly the users who tuned the board.
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
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

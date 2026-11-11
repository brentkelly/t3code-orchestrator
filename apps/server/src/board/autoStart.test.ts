/**
 * Auto-start: a card waiting at Ready moves into Building the moment its last dependency
 * reaches Done. Driven through the live reactor and the engine double, which decides with the
 * production decider; the sweep runs by calling the reactor's own `startArmed` hook.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  BoardPlanId,
  type BoardCard,
  type BoardPlan,
  type BoardState,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { projectBoardEvent } from "./projector.ts";
import {
  cardArchived,
  cardMoved,
  cardTitleUpdated,
  codexStep,
  makeBoardCard,
  settingsWith,
  stepStatus,
  withGovernor,
  type Harness,
  type HarnessCommand,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";

/**
 * Fold an event into the read model, then deliver it, in production order. Needed here because
 * the asserted card is not the one that moved, so the dependency must change under the reactor.
 */
const deliver = (h: Pick<Harness, "model" | "pumpDomain">, event: HarnessEvent) =>
  Ref.get(h.model).pipe(
    // The harness's own event helpers build board events by assertion (they
    // carry only the fields a handler reads), so the projector's narrower
    // `BoardEvent` needs the same assertion here.
    Effect.flatMap((model) =>
      projectBoardEvent(model, event as Parameters<typeof projectBoardEvent>[1]),
    ),
    Effect.flatMap((next) => Ref.set(h.model, next)),
    Effect.orDie,
    Effect.andThen(h.pumpDomain(event)),
  );

/**
 * Deliver the move a reactor DISPATCH produced: the engine double does not feed dispatched
 * events back into the domain queue, so a suite that needs the downstream hands it over.
 */
const deliverAutoStart = (
  h: Pick<Harness, "model" | "pumpDomain" | "board">,
  id: string,
  sequence: number,
) =>
  Effect.gen(function* () {
    const card = (yield* h.board).cards.find((candidate) => candidate.id === BoardCardId.make(id));
    assert.isDefined(card);
    yield* deliver(h, cardMoved(card!, READY, BUILDING, sequence));
  });

const READY = String(BOARD_SEED_STAGE_IDS.ready);
const BUILDING = String(BOARD_SEED_STAGE_IDS.building);
const DONE = String(BOARD_SEED_STAGE_IDS.done);

/** One hour after the TestClock epoch — a schedule that is decisively not due,
    for the composition case. */
const FUTURE = "1970-01-01T01:00:00.000Z";

/** The card under test: armed, waiting at Ready on the blockers named. */
const armedCard = (input: {
  readonly id?: string;
  readonly dependsOn: ReadonlyArray<string>;
  readonly autoStart?: boolean;
  readonly parentCardId?: string;
  readonly scheduledStartAt?: string;
}): BoardCard =>
  makeBoardCard({
    id: input.id ?? "waiter",
    stage: READY,
    orderKey: "m",
    autoStart: input.autoStart ?? true,
    dependsOn: input.dependsOn,
    ...(input.parentCardId === undefined ? {} : { parentCardId: input.parentCardId }),
    ...(input.scheduledStartAt === undefined ? {} : { scheduledStartAt: input.scheduledStartAt }),
  });

/** A blocker card, wherever the test needs it to be. */
const blocker = (id: string, stage: string) => makeBoardCard({ id, stage, orderKey: "b" });

const boardOf = (
  cards: ReadonlyArray<BoardCard>,
  plans?: ReadonlyArray<BoardPlan>,
): BoardState => ({
  cards,
  nextCardNumberByProject: {},
  ...(plans === undefined ? {} : { plans }),
});

const setup = (cards: ReadonlyArray<BoardCard>, plans?: ReadonlyArray<BoardPlan>) => ({
  board: boardOf(cards, plans),
  settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
});

/** Where a card ended up, read off the model the reactor's own dispatches
    updated — the honest assertion, because the move goes through the real
    decider and a refused one leaves the card where it was. */
const stageOf = (board: BoardState, id: string): string | null =>
  String(board.cards.find((card) => card.id === BoardCardId.make(id))?.stage ?? "") || null;

const armOf = (board: BoardState, id: string): boolean | null =>
  board.cards.find((card) => card.id === BoardCardId.make(id))?.autoBuildSetting ?? null;

const moveTypes = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.filter((command) => command.type === "board.card.move");

// ── The fire path ─────────────────────────────────────────────────────────

it.effect("starts an armed card when its last dependency reaches Done", () =>
  withGovernor(setup([armedCard({ dependsOn: ["dep"] }), blocker("dep", BUILDING)]), (h) =>
    Effect.gen(function* () {
      const { board } = h;
      yield* deliver(h, cardMoved(blocker("dep", DONE), BUILDING, DONE, 1));

      assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
      // Auto-build is a lasting setting: the move does not spend it.
      assert.strictEqual(armOf(yield* board, "waiter"), true);
      // An ORDINARY forward move, the one a human's Begin build makes:
      // no `override`, so the decider's every gate still applies and nothing
      // downstream can tell an auto-started card from a dragged one.
      const [move] = moveTypes(yield* h.commands);
      assert.strictEqual(move?.cardId, BoardCardId.make("waiter"));
      assert.isUndefined((move as { readonly override?: boolean } | undefined)?.override);
    }),
  ),
);

it.effect("does not fire while one dependency is still outstanding", () =>
  withGovernor(
    setup([
      armedCard({ dependsOn: ["dep-a", "dep-b"] }),
      blocker("dep-a", BUILDING),
      blocker("dep-b", BUILDING),
    ]),
    (h) =>
      Effect.gen(function* () {
        const { board } = h;
        yield* deliver(h, cardMoved(blocker("dep-a", DONE), BUILDING, DONE, 1));

        // Still waiting on dep-b, and still armed — the arm is only spent by a
        // move that actually happens.
        assert.strictEqual(stageOf(yield* board, "waiter"), READY);
        assert.strictEqual(armOf(yield* board, "waiter"), true);

        yield* deliver(h, cardMoved(blocker("dep-b", DONE), BUILDING, DONE, 2));
        assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
      }),
  ),
);

it.effect("leaves an UNARMED card waiting when its dependency finishes", () =>
  withGovernor(
    setup([armedCard({ dependsOn: ["dep"], autoStart: false }), blocker("dep", BUILDING)]),
    (h) =>
      Effect.gen(function* () {
        const { board, commands } = h;
        yield* deliver(h, cardMoved(blocker("dep", DONE), BUILDING, DONE, 1));

        // The whole feature is opt-in: without the arm the card waits for a
        // human, which is what every card did before this shipped.
        assert.strictEqual(stageOf(yield* board, "waiter"), READY);
        assert.lengthOf(moveTypes(yield* commands), 0);
      }),
  ),
);

it.effect("fires when the blocking card is ARCHIVED rather than finished", () =>
  withGovernor(setup([armedCard({ dependsOn: ["dep"] }), blocker("dep", BUILDING)]), (h) =>
    Effect.gen(function* () {
      const { board } = h;
      // Archiving means the work is not happening, so a gate
      // waiting on it is a deadlock. An armed card must clear it too.
      // The card the decider emits already carries its `archivedAt` — the
      // projector upserts the payload card whole.
      yield* deliver(
        h,
        cardArchived(
          { ...blocker("dep", BUILDING), archivedAt: "1970-01-01T00:00:00.000Z" } as BoardCard,
          1,
        ),
      );

      assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
    }),
  ),
);

it.effect("fires for a leaf inside a group too — any leaf may be armed (T3O-27)", () =>
  withGovernor(
    setup([
      makeBoardCard({ id: "parent", stage: BUILDING, orderKey: "a" }),
      armedCard({ dependsOn: ["dep"], parentCardId: "parent" }),
      blocker("dep", BUILDING),
    ]),
    (h) =>
      Effect.gen(function* () {
        const { board } = h;
        yield* deliver(h, cardMoved(blocker("dep", DONE), BUILDING, DONE, 1));
        // The per-card arm is the card's own trigger; group auto-build is an
        // additional one, not a replacement.
        assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
      }),
  ),
);

// ── D5: a move refused for a NON-dependency reason leaves the card armed ──

it.effect("a card awaiting split approval stays armed, and fires once it is approved", () =>
  Effect.gen(function* () {
    const plan = (ordinal: number): BoardPlan => ({
      planId: BoardPlanId.make(`waiter::plan-${String(ordinal)}`),
      cardId: BoardCardId.make("waiter"),
      title: `Plan ${String(ordinal)}`,
      summary: "",
      dependsOn: [],
      ordinal,
      locked: false,
      createdAt: "1970-01-01T00:00:00.000Z",
      updatedAt: "1970-01-01T00:00:00.000Z",
    });
    yield* withGovernor(
      setup([armedCard({ dependsOn: ["dep"] }), blocker("dep", BUILDING)], [plan(0), plan(1)]),
      (h) =>
        Effect.gen(function* () {
          const { board, commands } = h;
          yield* deliver(h, cardMoved(blocker("dep", DONE), BUILDING, DONE, 1));

          // The decider refuses every forward move while a split is pending, so
          // the reactor does not attempt one — and says nothing, because
          // "Needs approval" is already on the card's face.
          assert.strictEqual(stageOf(yield* board, "waiter"), READY);
          assert.lengthOf(moveTypes(yield* commands), 0);
          // Crucially the arm SURVIVES: nothing was spent on a move that never
          // happened, so the card fires by itself once the gate clears.
          assert.strictEqual(armOf(yield* board, "waiter"), true);
        }),
    );

    // The other side of the same gate: approving the split materialises child
    // cards, which is what stops the card pending — and the very next sweep
    // starts it, with no second gesture from the human.
    yield* withGovernor(
      setup(
        [
          armedCard({ dependsOn: ["dep"] }),
          blocker("dep", DONE),
          makeBoardCard({
            id: "child",
            stage: READY,
            orderKey: "n",
            parentCardId: "waiter",
          }),
        ],
        [plan(0), plan(1)],
      ),
      ({ reactor, board }) =>
        Effect.gen(function* () {
          yield* reactor.startArmed;
          assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
        }),
    );
  }),
);

// ── D6: the sweep is the self-healing half ───────────────────────────────

it.effect("the sweep starts a card whose dependency landed while nothing was listening", () =>
  withGovernor(
    // The blocker is ALREADY done and the card is ALREADY armed: exactly the
    // state a server that was down through the dependency's Done arrival comes
    // back to, with no event left to replay.
    setup([armedCard({ dependsOn: ["dep"] }), blocker("dep", DONE)]),
    (h) =>
      Effect.gen(function* () {
        const { reactor, board } = h;
        // Nothing has been pumped, so only a total pass can find this card.
        assert.strictEqual(stageOf(yield* board, "waiter"), READY);

        yield* reactor.startArmed;

        assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
      }),
  ),
);

it.effect("the sweep is idempotent: a second pass moves nothing", () =>
  withGovernor(setup([armedCard({ dependsOn: ["dep"] }), blocker("dep", DONE)]), (h) =>
    Effect.gen(function* () {
      const { reactor, board, commands } = h;
      yield* reactor.startArmed;
      yield* reactor.startArmed;

      // The move clears the arm and carries the card out of Ready in one
      // event, so the card is not due on the second pass. That is what makes
      // a raced targeted call and the 30s tick safe over the same board.
      assert.lengthOf(moveTypes(yield* commands), 1);
      assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
    }),
  ),
);

it.effect("an edit that arms an already-unblocked card fires it immediately", () =>
  withGovernor(
    setup([armedCard({ dependsOn: ["dep"], autoStart: false }), blocker("dep", DONE)]),
    (h) =>
      Effect.gen(function* () {
        const { pumpDomain, board } = h;
        // The race the targeted `card-updated` trigger exists for: the
        // dependency finished between the modal rendering and the click, so
        // no done-arrival event is coming.
        const armed = armedCard({ dependsOn: ["dep"] });
        yield* pumpDomain({
          type: "board.card-updated",
          sequence: 1,
          payload: { cardId: armed.id, card: armed, autoStart: true },
        } as never);

        assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
      }),
  ),
);

it.effect("an edit that drops the last blocking edge fires the card", () =>
  withGovernor(setup([armedCard({ dependsOn: ["dep"] }), blocker("dep", BUILDING)]), (h) =>
    Effect.gen(function* () {
      const { board } = h;
      // Removing the edge by hand is a way to unblock a card, and it arrives
      // as a `card-updated` naming no dependency — the same shape the decider
      // emits for every dependent when a blocking card is DELETED.
      const freed = armedCard({ dependsOn: [] });
      yield* deliver(h, {
        type: "board.card-updated",
        sequence: 1,
        payload: { cardId: freed.id, card: freed },
      } as never);

      assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
    }),
  ),
);

it.effect("an unrelated edit on an armed, still-blocked card does nothing", () =>
  withGovernor(setup([armedCard({ dependsOn: ["dep"] }), blocker("dep", BUILDING)]), (h) =>
    Effect.gen(function* () {
      const { board, commands } = h;
      yield* deliver(h, cardTitleUpdated(armedCard({ dependsOn: ["dep"] }), 1));

      assert.strictEqual(stageOf(yield* board, "waiter"), READY);
      assert.lengthOf(moveTypes(yield* commands), 0);
    }),
  ),
);

// ── D10: an arm and a schedule compose without knowing about each other ──

it.effect("an armed AND scheduled card enters Building, then holds its step for the time", () =>
  withGovernor(
    setup([armedCard({ dependsOn: ["dep"], scheduledStartAt: FUTURE }), blocker("dep", BUILDING)]),
    (h) =>
      Effect.gen(function* () {
        const { board, slots } = h;
        yield* deliver(h, cardMoved(blocker("dep", DONE), BUILDING, DONE, 1));
        assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
        yield* deliverAutoStart(h, "waiter", 2);

        // Two independent holds: auto-start crosses the STAGE gate, the
        // schedule gates STEP ADMISSION. Asserted so a future change cannot
        // quietly couple them — the card is in Building on its own, and its
        // step waits for the time, holding no slot.
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("waiter")), "pending");
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

// ── The queue is untouched: an auto-started card is an ordinary card ──────

it.effect("an auto-started card with no free slot queues honestly", () =>
  withGovernor(
    {
      board: boardOf([
        armedCard({ dependsOn: ["dep"] }),
        blocker("dep", BUILDING),
        makeBoardCard({ id: "hog", stage: BUILDING, orderKey: "a" }),
      ]),
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
    },
    (h) =>
      Effect.gen(function* () {
        const { pumpDomain, board } = h;
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({ id: "hog", stage: BUILDING, orderKey: "a" }),
            READY,
            BUILDING,
            1,
          ),
        );
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("hog")), "running");

        yield* deliver(h, cardMoved(blocker("dep", DONE), BUILDING, DONE, 2));
        assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
        yield* deliverAutoStart(h, "waiter", 3);

        // Nothing downstream is special-cased for an auto-start: with the
        // only slot taken the card sits `Queued #n` like any other, which is
        // the honest answer.
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("waiter")), "queued");
      }),
  ),
);

// ── Automation toggles ───────────────────────────────────────────

const armEdit = (card: BoardCard, sequence: number) =>
  ({
    type: "board.card-updated",
    sequence,
    payload: { cardId: card.id, card, automationChanged: { autoBuild: true } },
  }) as never;

it.effect("a child's own Auto-build starts it without beginning its unstarted group", () => {
  const group: BoardCard = {
    ...makeBoardCard({ id: "group", stage: READY, orderKey: "a" }),
    group: {
      target: "inherit",
      autoBuild: true,
      autoMerge: false,
      autoPlan: false,
      started: false,
      placed: BOARD_SEED_STAGE_IDS.ready,
      prevStage: null,
      heading: true,
      integrated: false,
    },
  };
  const own = armedCard({ dependsOn: [], parentCardId: "group" });
  const sibling = makeBoardCard({
    id: "sibling",
    stage: READY,
    orderKey: "n",
    parentCardId: "group",
  });
  return withGovernor(setup([group, own, sibling]), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(armEdit(own, 1));
      assert.strictEqual(stageOf(yield* h.board, "waiter"), BUILDING);
      yield* deliverAutoStart(h, "waiter", 2);

      const after = yield* h.board;
      assert.strictEqual(stageOf(after, "sibling"), READY, "the group's cascade did not run");
      assert.isFalse(
        after.cards.find((card) => card.id === BoardCardId.make("group"))?.group?.started,
      );
    }),
  );
});

it.effect("Auto-build runs the build unattended even when the card asks for a human", () => {
  const card: BoardCard = { ...armedCard({ dependsOn: [] }), humanInLoop: true };
  return withGovernor(setup([card]), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(armEdit(card, 1));
      yield* deliverAutoStart(h, "waiter", 2);

      const state = boardCardStepState(yield* h.board, BoardCardId.make("waiter"));
      assert.strictEqual(state?.stepId, BUILDING);
      assert.isFalse(state?.humanInLoop);
    }),
  );
});

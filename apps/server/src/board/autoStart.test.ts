/**
 * Auto-start (T3O-24): one boolean on a card waiting at Ready that moves it
 * into Building the moment its last dependency reaches Done.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`), because the behaviour spans the fire path, the real
 * decider's move gate, worktree provisioning and the 30s tick. The engine
 * double decides every dispatched command with the production decider, so a
 * move this suite says the card makes is a move the decider really allowed.
 *
 * Nothing here sleeps or polls: the sweep is driven by calling the reactor's
 * own `startArmed` hook, exactly as the scheduled-start suite drives
 * `fireSchedules`.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardPlanId,
  type BoardCard,
  type BoardPlan,
  type BoardState,
  type OrchestrationCommand,
  type OrchestrationEvent,
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
} from "./supervisorHarness.testkit.ts";

/**
 * Fold an event into the read model, then deliver it — the order production
 * runs in, the projection pipeline sitting ahead of the reactor's domain
 * stream.
 *
 * The harness's own pump folds only the handful of event types whose suites
 * need it; every other suite seeds the post-move card into its fixture board
 * instead. This one cannot: the card it asserts on is a DIFFERENT card from
 * the one that moved, so the dependency really has to change under the reactor
 * while it runs.
 */
const deliver = (h: Pick<Harness, "model" | "pumpDomain">, event: OrchestrationEvent) =>
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

/** Deliver the move a reactor DISPATCH produced, so the rest of the pipeline
    runs on it. The engine double decides and projects a dispatched command but
    does not feed its event back into the domain queue, so a suite that wants
    the downstream — step selection, the governor's slots — has to hand it over
    itself. Reads the card as the dispatch left it, so the event is the real
    one. */
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
  board.cards.find((card) => card.id === BoardCardId.make(id))?.autoStart ?? null;

const moveTypes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "board.card.move");

// ── The fire path ─────────────────────────────────────────────────────────

it.effect("starts an armed card when its last dependency reaches Done", () =>
  withGovernor(setup([armedCard({ dependsOn: ["dep"] }), blocker("dep", BUILDING)]), (h) =>
    Effect.gen(function* () {
      const { board } = h;
      yield* deliver(h, cardMoved(blocker("dep", DONE), BUILDING, DONE, 1));

      assert.strictEqual(stageOf(yield* board, "waiter"), BUILDING);
      // The arm is SPENT by the move that fired it (D4), in the same event —
      // so there is no cleared-but-unstarted window and no second command
      // that can be lost.
      assert.strictEqual(armOf(yield* board, "waiter"), false);
      // An ORDINARY forward move, the one a human's Begin build makes (D3):
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
      // t3o-13 D1: archiving means the work is not happening, so a gate
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

it.effect("never fires for a sub-board child — its siblings already cascade", () =>
  withGovernor(
    setup([
      makeBoardCard({ id: "parent", stage: BUILDING, orderKey: "a" }),
      armedCard({ dependsOn: ["dep"], parentCardId: "parent" }),
      blocker("dep", BUILDING),
    ]),
    (h) =>
      Effect.gen(function* () {
        const { board, commands } = h;
        yield* deliver(h, cardMoved(blocker("dep", DONE), BUILDING, DONE, 1));

        // A child is started by `cascadeUnblockedChildren` off its PARENT's
        // Begin build (t3o-28 D3). Its dependency finishing here is not a
        // parent's Begin build, and a second mechanism firing on it would be
        // two answers to one question.
        assert.strictEqual(stageOf(yield* board, "waiter"), READY);
        assert.lengthOf(
          moveTypes(yield* commands).filter(
            (command) => command.cardId === BoardCardId.make("waiter"),
          ),
          0,
        );
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

        // Nothing downstream is special-cased for an auto-start (D3): with the
        // only slot taken the card sits `Queued #n` like any other, which is
        // the honest answer.
        assert.strictEqual(stepStatus(yield* board, BoardCardId.make("waiter")), "queued");
      }),
  ),
);

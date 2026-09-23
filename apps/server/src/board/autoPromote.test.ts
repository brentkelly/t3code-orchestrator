/**
 * Auto-promote Backlog → Sprint (t3o-35): a per-project setting that moves
 * every unblocked, unparked, due Backlog card into Sprint.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`), the same way the auto-start suite drives `startArmed`.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  type BoardCard,
  type BoardState,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { projectBoardEvent } from "./projector.ts";
import {
  cardMoved,
  codexStep,
  makeBoardCard,
  projectId,
  settingsWith,
  withGovernor,
  type Harness,
} from "./supervisorHarness.testkit.ts";

const deliver = (h: Pick<Harness, "model" | "pumpDomain">, event: OrchestrationEvent) =>
  Ref.get(h.model).pipe(
    Effect.flatMap((model) =>
      projectBoardEvent(model, event as Parameters<typeof projectBoardEvent>[1]),
    ),
    Effect.flatMap((next) => Ref.set(h.model, next)),
    Effect.orDie,
    Effect.andThen(h.pumpDomain(event)),
  );

const BACKLOG = String(BOARD_SEED_STAGE_IDS.backlog);
const SPRINT = String(BOARD_SEED_STAGE_IDS.sprint);
const BUILDING = String(BOARD_SEED_STAGE_IDS.building);
const DONE = String(BOARD_SEED_STAGE_IDS.done);
const FUTURE = "1970-01-01T01:00:00.000Z";

const waiting = (input: {
  readonly id?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly backlogParked?: boolean;
  readonly parentCardId?: string;
  readonly scheduledStartAt?: string;
}): BoardCard =>
  makeBoardCard({
    id: input.id ?? "waiter",
    stage: BACKLOG,
    orderKey: "m",
    dependsOn: input.dependsOn ?? [],
    ...(input.backlogParked === undefined ? {} : { backlogParked: input.backlogParked }),
    ...(input.parentCardId === undefined ? {} : { parentCardId: input.parentCardId }),
    ...(input.scheduledStartAt === undefined ? {} : { scheduledStartAt: input.scheduledStartAt }),
  });

const blocker = (id: string, stage: string) => makeBoardCard({ id, stage, orderKey: "b" });

const promoteSettings = (children = false) =>
  settingsWith({
    building: [codexStep],
    globalMaxConcurrent: 3,
    projects: {
      [projectId]: {
        keyPrefix: null,
        accentColor: null,
        hidden: false,
        autoPromoteToSprint: true,
        autoPromoteChildren: children,
      },
    },
  });

const setup = (cards: ReadonlyArray<BoardCard>, children = false) => ({
  board: { cards, nextCardNumberByProject: {} } satisfies BoardState,
  settings: promoteSettings(children),
});

const stageOf = (board: BoardState, id: string): string | null =>
  String(board.cards.find((card) => card.id === BoardCardId.make(id))?.stage ?? "") || null;

const parkedOf = (board: BoardState, id: string): boolean | null =>
  board.cards.find((card) => card.id === BoardCardId.make(id))?.backlogParked ?? null;

const moveTypes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "board.card.move");

it.effect("promotes an unblocked Backlog card when the setting is on", () =>
  withGovernor(setup([waiting({})]), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.promoteUnblocked;
      assert.strictEqual(stageOf(yield* h.board, "waiter"), SPRINT);
      const [move] = moveTypes(yield* h.commands);
      assert.strictEqual(move?.cardId, BoardCardId.make("waiter"));
      assert.isUndefined((move as { readonly override?: boolean } | undefined)?.override);
    }),
  ),
);

it.effect("does not promote while one of two dependencies is still outstanding", () =>
  withGovernor(
    setup([
      waiting({ dependsOn: ["dep-a", "dep-b"] }),
      blocker("dep-a", DONE),
      blocker("dep-b", BUILDING),
    ]),
    (h) =>
      Effect.gen(function* () {
        yield* deliver(h, cardMoved(blocker("dep-a", DONE), BUILDING, DONE, 1));
        assert.strictEqual(stageOf(yield* h.board, "waiter"), BACKLOG);
        yield* deliver(h, cardMoved(blocker("dep-b", DONE), BUILDING, DONE, 2));
        assert.strictEqual(stageOf(yield* h.board, "waiter"), SPRINT);
      }),
  ),
);

it.effect("does not promote a parked card", () =>
  withGovernor(setup([waiting({ backlogParked: true })]), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.promoteUnblocked;
      assert.strictEqual(stageOf(yield* h.board, "waiter"), BACKLOG);
      assert.strictEqual(parkedOf(yield* h.board, "waiter"), true);
    }),
  ),
);

it.effect("does not promote before the scheduled start", () =>
  withGovernor(setup([waiting({ scheduledStartAt: FUTURE })]), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.promoteUnblocked;
      assert.strictEqual(stageOf(yield* h.board, "waiter"), BACKLOG);
    }),
  ),
);

it.effect("does not promote a child unless the children setting is on", () =>
  withGovernor(
    setup(
      [
        makeBoardCard({ id: "parent", stage: BUILDING, orderKey: "a" }),
        waiting({ parentCardId: "parent" }),
      ],
      false,
    ),
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.promoteUnblocked;
        assert.strictEqual(stageOf(yield* h.board, "waiter"), BACKLOG);
      }),
  ),
);

it.effect("does not promote a child into Sprint — children cannot enter ideation stages", () =>
  withGovernor(
    setup(
      [
        makeBoardCard({ id: "parent", stage: BUILDING, orderKey: "a" }),
        waiting({ parentCardId: "parent" }),
      ],
      true,
    ),
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.promoteUnblocked;
        // The setting is on, but the decider refuses Backlog/Sprint for
        // children (the materialisation floor is Ready). The sweep must not
        // retry forever; the card stays where it is.
        assert.strictEqual(stageOf(yield* h.board, "waiter"), BACKLOG);
      }),
  ),
);

it.effect("the sweep is idempotent: a second pass moves nothing", () =>
  withGovernor(setup([waiting({})]), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.promoteUnblocked;
      yield* h.reactor.promoteUnblocked;
      assert.lengthOf(moveTypes(yield* h.commands), 1);
      assert.strictEqual(stageOf(yield* h.board, "waiter"), SPRINT);
    }),
  ),
);

it.effect("does not promote until the project setting is on", () =>
  withGovernor(
    {
      board: { cards: [waiting({})], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    (h) =>
      Effect.gen(function* () {
        yield* h.reactor.promoteUnblocked;
        assert.strictEqual(stageOf(yield* h.board, "waiter"), BACKLOG);
        h.setBoardSettings(promoteSettings());
        yield* h.reactor.promoteUnblocked;
        assert.strictEqual(stageOf(yield* h.board, "waiter"), SPRINT);
      }),
  ),
);

it.effect("unparking an eligible card moves it to Sprint", () =>
  withGovernor(setup([waiting({ backlogParked: true })]), (h) =>
    Effect.gen(function* () {
      yield* h.reactor.promoteUnblocked;
      assert.strictEqual(stageOf(yield* h.board, "waiter"), BACKLOG);
      const parked = waiting({ backlogParked: true });
      yield* deliver(h, {
        type: "board.card-updated",
        sequence: 1,
        payload: {
          cardId: parked.id,
          card: { ...parked, backlogParked: false },
          backlogParked: false,
        },
      } as OrchestrationEvent);
      assert.strictEqual(stageOf(yield* h.board, "waiter"), SPRINT);
    }),
  ),
);

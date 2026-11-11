/**
 * Archived cards end to end: an archived dependency no longer blocks its
 * dependent forever, and the archived card stays listable. Runs the real
 * decider, event store, projection and snapshot queries.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  EMPTY_BOARD_STATE,
  ProjectId,
  ProviderInstanceId,
  unmetBoardCardDependencies,
  type BoardCardShell,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardQueries } from "./BoardQueries.ts";
import {
  boardStackEngine,
  boardStackSnapshotQuery,
  makeBoardStackTestLayer,
} from "./boardStack.testkit.ts";

/** One database per scenario. Commands are deduped by `commandId` and every
    scenario shares a seed, so a single database would let one scenario's
    archive silently satisfy the next one's dispatch. */
const makeTestLayer = makeBoardStackTestLayer;

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-board");
const dependencyId = BoardCardId.make("card-dependency");
const dependentId = BoardCardId.make("card-dependent");

const createProject = {
  type: "project.create",
  commandId: CommandId.make("cmd-project"),
  projectId,
  title: "Board Project",
  workspaceRoot: "/tmp/project-board",
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  createdAt,
} as const;

/** A dependency card and a Building card waiting on it. Entry into Building
    with an unmet dependency is refused, so the dependent moves there
    dependency-free and is then edited to add the dependency. */
const seedBoard = Effect.gen(function* () {
  const engine = yield* boardStackEngine;
  yield* engine.dispatch(createProject);
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make("cmd-create-dependency"),
    cardId: dependencyId,
    projectId,
    title: "The work being waited on",
    orderKey: "m",
    createdAt,
  });
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make("cmd-create-dependent"),
    cardId: dependentId,
    projectId,
    title: "The work that waits",
    orderKey: "n",
    createdAt,
  });
  yield* engine.dispatch({
    type: "board.card.move",
    commandId: CommandId.make("cmd-move-building"),
    cardId: dependentId,
    toStage: BoardStageId.make("building"),
    override: true,
    createdAt,
  });
  // Adding the dependency to a card already in the build role re-derives its
  // blocked flag without refusing — refusal is only on entry into build.
  yield* engine.dispatch({
    type: "board.card.update",
    commandId: CommandId.make("cmd-add-dependency"),
    cardId: dependentId,
    dependsOn: [dependencyId],
    createdAt,
  });
  return engine;
});

/** `cards` is key-optional on the shell snapshot (a snapshot with no board
    omits it), so every assertion below reads through this. */
const cardsOf = (snapshot: {
  readonly cards: ReadonlyArray<BoardCardShell>;
}): ReadonlyArray<BoardCardShell> => snapshot.cards;

const archiveDependency = {
  type: "board.card.archive",
  commandId: CommandId.make("cmd-archive"),
  cardId: dependencyId,
  createdAt,
} as const;

/** One database per scenario. Commands are deduped by `commandId` and the
    scenarios share a seed, so a shared database would let one scenario's
    archive silently satisfy the next one's dispatch. */
it.layer(makeTestLayer("t3o-board-archive-1-"))("archiving a depended-on card", (it) => {
  it.effect("clears the dependents' blocked flag and keeps the dependency edge", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      const snapshotQuery = yield* boardStackSnapshotQuery;

      const blocked = yield* snapshotQuery.getBoardSnapshot();
      assert.strictEqual(
        cardsOf(blocked).find((card) => card.cardId === dependentId)?.blocked,
        true,
        "the dependent starts blocked by unfinished work",
      );

      yield* engine.dispatch(archiveDependency);

      const shell = yield* snapshotQuery.getBoardSnapshot();
      // The archived card leaves the live board…
      assert.deepStrictEqual(
        cardsOf(shell).map((card) => card.cardId),
        [dependentId],
      );
      // …and the card that was waiting on it is free.
      assert.strictEqual(cardsOf(shell)[0]?.blocked, false);

      const readModel = yield* snapshotQuery.getCommandReadModel();
      const dependent = readModel.board?.cards.find((card) => card.id === dependentId);
      // The edge is untouched — that is what makes the restore below work.
      assert.deepStrictEqual(dependent?.dependsOn, [dependencyId]);
      assert.deepStrictEqual(
        unmetBoardCardDependencies({
          board: readModel.board ?? EMPTY_BOARD_STATE,
          dependsOn: dependent?.dependsOn ?? [],
          cards: readModel.board?.cards ?? [],
        }),
        [],
      );
    }),
  );
});

it.layer(makeTestLayer("t3o-board-archive-2-"))("moving past a released gate", (it) => {
  it.effect("lets the dependent move past Ready once the dependency is archived", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      yield* engine.dispatch(archiveDependency);

      // An archived dependency never reaches `done`, so this must not wait on it.
      yield* engine.dispatch({
        type: "board.card.move",
        commandId: CommandId.make("cmd-move-building"),
        cardId: dependentId,
        toStage: BoardStageId.make("building"),
        createdAt,
      });

      const snapshotQuery = yield* boardStackSnapshotQuery;
      const shell = yield* snapshotQuery.getBoardSnapshot();
      assert.strictEqual(
        cardsOf(shell).find((card) => card.cardId === dependentId)?.stage,
        "building",
      );
    }),
  );
});

it.layer(makeTestLayer("t3o-board-archive-3-"))("restoring a depended-on card", (it) => {
  it.effect("re-blocks the dependent when the dependency is restored", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      const snapshotQuery = yield* boardStackSnapshotQuery;
      yield* engine.dispatch(archiveDependency);

      yield* engine.dispatch({
        type: "board.card.unarchive",
        commandId: CommandId.make("cmd-unarchive"),
        cardId: dependencyId,
        createdAt,
      });

      const shell = yield* snapshotQuery.getBoardSnapshot();
      assert.strictEqual(cardsOf(shell).length, 2, "the restored card is back on the live board");
      assert.strictEqual(cardsOf(shell).find((card) => card.cardId === dependentId)?.blocked, true);
    }),
  );
});

it.layer(makeTestLayer("t3o-board-archive-4-"))("card detail dependency refs", (it) => {
  it.effect("resolves an archived dependency on the card detail rather than dropping it", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      yield* engine.dispatch(archiveDependency);

      const board = yield* BoardQueries;
      assert.isNotNull(board);
      if (board === null) return;

      const detail = yield* board.boardCardDetail(dependentId);
      assert.isNotNull(detail);
      // The shell no longer carries this card, so resolving from the shell is
      // exactly what produced "Unknown task" on "unknown card".
      assert.deepStrictEqual(
        detail?.dependencies.map((entry) => ({
          cardId: entry.cardId,
          title: entry.title,
          archived: entry.archivedAt !== null,
        })),
        [{ cardId: dependencyId, title: "The work being waited on", archived: true }],
      );

      // And the other direction, which the archive confirmation reads.
      const dependencyDetail = yield* board.boardCardDetail(dependencyId);
      assert.deepStrictEqual(
        dependencyDetail?.dependents.map((entry) => entry.cardId),
        [dependentId],
      );
    }),
  );
});

it.layer(makeTestLayer("t3o-board-archive-5-"))("the archive page's card list", (it) => {
  it.effect("lists archived cards on the archive snapshot, and only there", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      const snapshotQuery = yield* boardStackSnapshotQuery;
      yield* engine.dispatch(archiveDependency);

      const archived = yield* snapshotQuery.getArchivedBoardCards();
      assert.deepStrictEqual(
        cardsOf(archived).map((card) => card.cardId),
        [dependencyId],
      );
      assert.strictEqual(cardsOf(archived)[0]?.archivedAt, createdAt);

      // The live snapshot never carries an archived card, and never a
      // populated `archivedAt`.
      const live = yield* snapshotQuery.getBoardSnapshot();
      assert.deepStrictEqual(
        cardsOf(live).map((card) => card.archivedAt),
        [null],
      );
    }),
  );
});

it.layer(makeTestLayer("t3o-board-archive-6-"))("card detail group dependency refs", (it) => {
  it.effect("lists what a card's ancestor groups wait on, minus its own (T3O-26)", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      yield* engine.dispatch(createProject);
      const create = (
        cardId: BoardCardId,
        fields: {
          readonly parentCardId?: BoardCardId;
          readonly dependsOn?: ReadonlyArray<BoardCardId>;
          readonly heading?: boolean;
        } = {},
      ) =>
        engine.dispatch({
          type: "board.card.create",
          commandId: CommandId.make(`cmd-create-${cardId}`),
          cardId,
          projectId,
          title: `Card ${cardId}`,
          ...fields,
          createdAt,
        });
      const outer = BoardCardId.make("card-outer");
      const inner = BoardCardId.make("card-inner");
      const bare = BoardCardId.make("card-bare");
      const own = BoardCardId.make("card-own");
      yield* create(dependencyId);
      yield* create(outer, { heading: true, dependsOn: [dependencyId] });
      yield* create(inner, { heading: true, parentCardId: outer });
      yield* create(bare, { parentCardId: inner });
      yield* create(own, { parentCardId: inner, dependsOn: [dependencyId] });

      const board = yield* BoardQueries;
      assert.isNotNull(board);
      if (board === null) return;
      const groupDependencyIds = (cardId: BoardCardId) =>
        board
          .boardCardDetail(cardId)
          .pipe(Effect.map((detail) => detail?.groupDependencies.map((entry) => entry.cardId)));
      assert.deepStrictEqual(yield* groupDependencyIds(bare), [dependencyId]);
      assert.deepStrictEqual(yield* groupDependencyIds(own), []);
      assert.deepStrictEqual(yield* groupDependencyIds(outer), []);
    }),
  );
});

it.layer(makeTestLayer("t3o-board-archive-7-"))("card detail child refs", (it) => {
  it.effect("carries each child's own dependsOn, hand-made children included (T3O-34)", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      yield* engine.dispatch(createProject);
      const group = BoardCardId.make("card-group");
      const first = BoardCardId.make("card-first");
      const second = BoardCardId.make("card-second");
      const create = (
        cardId: BoardCardId,
        fields: {
          readonly parentCardId?: BoardCardId;
          readonly dependsOn?: ReadonlyArray<BoardCardId>;
          readonly heading?: boolean;
        } = {},
      ) =>
        engine.dispatch({
          type: "board.card.create",
          commandId: CommandId.make(`cmd-create-${cardId}`),
          cardId,
          projectId,
          title: `Card ${cardId}`,
          ...fields,
          createdAt,
        });
      yield* create(group, { heading: true });
      yield* create(first, { parentCardId: group });
      yield* create(second, { parentCardId: group, dependsOn: [first] });

      const board = yield* BoardQueries;
      assert.isNotNull(board);
      if (board === null) return;
      const detail = yield* board.boardCardDetail(group);
      assert.deepStrictEqual(
        detail?.children.map((child) => ({ cardId: child.cardId, dependsOn: child.dependsOn })),
        [
          { cardId: first, dependsOn: [] },
          { cardId: second, dependsOn: [first] },
        ],
      );
    }),
  );
});

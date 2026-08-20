/**
 * T3o archived cards, end to end (t3o-13). Archiving a card that another card
 * depends on used to be a one-way trap: the dependent was blocked forever
 * because an archived dependency counted as unmet, and the archived card was
 * unreachable because nothing listed it.
 *
 * These assertions run the real seams — decider, event store, projection,
 * snapshot queries — because the fix is spread across all of them: the
 * derivation lives in contracts, the re-flag events in the decider, the
 * resolved dependency refs and the archive-page card list in the projection.
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
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";
import { ServerConfig } from "../config.ts";

/** One database per scenario. Commands are deduped by `commandId` and every
    scenario shares a seed, so a single database would let one scenario's
    archive silently satisfy the next one's dispatch. */
const makeTestLayer = (prefix: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

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

/** A dependency card and, behind it, a card in Building that waits on it — the
    exact shape the archive used to strand. Dependency blocking is derived from
    the build role onward now (D11), so the dependent must sit in Building (not
    Ready) to be blocked. Entry into Building with an unmet dependency is refused
    (D11), so the dependent is moved there dependency-free and then edited to add
    the dependency — which re-derives its blocked flag in place. */
const seedBoard = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
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
  // blocked flag (D11) without refusing — refusal is only on entry into build.
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
const cardsOf = (snapshot: OrchestrationShellSnapshot): ReadonlyArray<BoardCardShell> =>
  snapshot.cards ?? [];

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
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const blocked = yield* snapshotQuery.getShellSnapshot();
      assert.strictEqual(
        cardsOf(blocked).find((card) => card.cardId === dependentId)?.blocked,
        true,
        "the dependent starts blocked by unfinished work",
      );

      yield* engine.dispatch(archiveDependency);

      const shell = yield* snapshotQuery.getShellSnapshot();
      // The archived card leaves the live board (D15)…
      assert.deepStrictEqual(
        cardsOf(shell).map((card) => card.cardId),
        [dependentId],
      );
      // …and the card that was waiting on it is free (D1/D5).
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

      // Before t3o-13 this rejected forever: an archived dependency could
      // never reach `done`, so the gate could never open.
      yield* engine.dispatch({
        type: "board.card.move",
        commandId: CommandId.make("cmd-move-building"),
        cardId: dependentId,
        toStage: BoardStageId.make("building"),
        createdAt,
      });

      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const shell = yield* snapshotQuery.getShellSnapshot();
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
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* engine.dispatch(archiveDependency);

      yield* engine.dispatch({
        type: "board.card.unarchive",
        commandId: CommandId.make("cmd-unarchive"),
        cardId: dependencyId,
        createdAt,
      });

      const shell = yield* snapshotQuery.getShellSnapshot();
      assert.strictEqual(cardsOf(shell).length, 2, "the restored card is back on the live board");
      assert.strictEqual(cardsOf(shell).find((card) => card.cardId === dependentId)?.blocked, true);
    }),
  );
});

it.layer(makeTestLayer("t3o-board-archive-4-"))("card detail dependency refs", (it) => {
  it.effect("resolves an archived dependency on the card detail rather than dropping it", () =>
    Effect.gen(function* () {
      const engine = yield* seedBoard;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* engine.dispatch(archiveDependency);

      const board = boardSnapshotQueryMethodsOf(snapshotQuery);
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
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* engine.dispatch(archiveDependency);

      const archived = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepStrictEqual(
        cardsOf(archived).map((card) => card.cardId),
        [dependencyId],
      );
      assert.strictEqual(cardsOf(archived)[0]?.archivedAt, createdAt);

      // The live snapshot never carries an archived card, and never a
      // populated `archivedAt`.
      const live = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(
        cardsOf(live).map((card) => card.archivedAt),
        [null],
      );
    }),
  );
});

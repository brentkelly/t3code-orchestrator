/**
 * T3o walking-skeleton verification (t3o-02): a dispatched `board.card.create`
 * flows through every seam — decider, event store, in-memory projector,
 * persisted projection, snapshot queries — and replaying the persisted events
 * from an empty read model reproduces exactly the board state the engine
 * rehydrates from the projection tables.
 */
import {
  BoardCardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

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
import { createEmptyReadModel, projectEvent } from "../orchestration/projector.ts";
import { ServerConfig } from "../config.ts";

const makeBoardSkeletonTestLayer = (prefix: string) =>
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
const cardId = BoardCardId.make("card-1");

const createProjectCommand = {
  type: "project.create",
  commandId: CommandId.make("cmd-project-create"),
  projectId,
  title: "Board Project",
  workspaceRoot: "/tmp/project-board",
  defaultModelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5-codex",
  },
  createdAt,
} as const;

const createCardCommand = {
  type: "board.card.create",
  commandId: CommandId.make("cmd-card-create"),
  cardId,
  projectId,
  title: "First card",
  createdAt,
} as const;

const expectedCard = {
  id: cardId,
  projectId,
  title: "First card",
  createdAt,
  updatedAt: createdAt,
};

it.layer(makeBoardSkeletonTestLayer("t3o-board-skeleton-test-"))("board walking skeleton", (it) => {
  it.effect(
    "projects a dispatched board.card.create everywhere and replays it identically from an empty read model",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        yield* engine.dispatch(createProjectCommand);
        yield* engine.dispatch(createCardCommand);

        // Engine-facing read model, rehydrated from the projection tables
        // the same way a server restart bootstraps (getCommandReadModel).
        const rehydrated = yield* snapshotQuery.getCommandReadModel();
        assert.deepStrictEqual(rehydrated.board, { cards: [expectedCard] });

        // Shell snapshot carries the card to every connecting client.
        const shell = yield* snapshotQuery.getShellSnapshot();
        assert.deepStrictEqual(shell.cards, [expectedCard]);

        // Replaying the persisted event log from a truly empty read model
        // must land on the same board state.
        const events: OrchestrationEvent[] = Array.from(
          yield* Stream.runCollect(engine.readEvents(0)),
        );
        assert.deepStrictEqual(
          events.map((event) => event.type),
          ["project.created", "board.card-created"],
        );
        const cardEvent = events[1]!;
        assert.strictEqual(cardEvent.aggregateKind, "card");
        assert.strictEqual(cardEvent.aggregateId, cardId);

        let replayed = createEmptyReadModel(createdAt);
        for (const event of events) {
          replayed = yield* projectEvent(replayed, event);
        }
        assert.deepStrictEqual(replayed.board, rehydrated.board);
        assert.strictEqual(replayed.snapshotSequence, rehydrated.snapshotSequence);
      }),
  );

  // Runs against the same store as the test above: project-board and card-1
  // already exist here by design.
  it.effect("rejects a duplicate card id", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const failure = yield* Effect.flip(
        engine.dispatch({
          ...createCardCommand,
          commandId: CommandId.make("cmd-card-create-duplicate"),
        }),
      );
      assert.strictEqual(failure._tag, "OrchestrationCommandInvariantError");
      assert.include(String(failure), "already exists");
    }),
  );

  it.effect("rejects a card for a project that does not exist", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const failure = yield* Effect.flip(
        engine.dispatch({
          type: "board.card.create",
          commandId: CommandId.make("cmd-card-create-orphan"),
          cardId: BoardCardId.make("card-orphan"),
          projectId: ProjectId.make("project-missing"),
          title: "Orphan card",
          createdAt,
        }),
      );
      assert.strictEqual(failure._tag, "OrchestrationCommandInvariantError");
      assert.include(String(failure), "does not exist");
    }),
  );
});

// Separate layer = a pristine empty database. Two cards created OUT of
// timestamp order (the second dispatched carries an earlier createdAt) would
// expose any divergence between the in-memory projector's ordering and the
// table's `ORDER BY created_at, card_id` — the single-card happy path cannot.
it.layer(makeBoardSkeletonTestLayer("t3o-board-skeleton-order-test-"))(
  "board walking skeleton (out-of-order cards)",
  (it) => {
    it.effect("replay equals rehydration when cards are created out of timestamp order", () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        yield* engine.dispatch(createProjectCommand);
        // Dispatched first, but LATER timestamp.
        yield* engine.dispatch({
          type: "board.card.create",
          commandId: CommandId.make("cmd-card-late"),
          cardId: BoardCardId.make("card-late"),
          projectId,
          title: "Later card",
          createdAt: "2026-01-02T00:00:00.000Z",
        });
        // Dispatched second, but EARLIER timestamp — so dispatch order and
        // canonical (createdAt) order disagree.
        yield* engine.dispatch({
          type: "board.card.create",
          commandId: CommandId.make("cmd-card-early"),
          cardId: BoardCardId.make("card-early"),
          projectId,
          title: "Earlier card",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        const rehydrated = yield* snapshotQuery.getCommandReadModel();
        // Canonical order is by createdAt: the earlier card sorts first even
        // though it was dispatched second.
        assert.deepStrictEqual(
          rehydrated.board?.cards.map((card) => card.id),
          [BoardCardId.make("card-early"), BoardCardId.make("card-late")],
        );

        const events: OrchestrationEvent[] = Array.from(
          yield* Stream.runCollect(engine.readEvents(0)),
        );
        let replayed = createEmptyReadModel(createdAt);
        for (const event of events) {
          replayed = yield* projectEvent(replayed, event);
        }
        // The order-sensitive equality must hold for ≥2 out-of-order cards.
        assert.deepStrictEqual(replayed.board, rehydrated.board);
      }),
    );
  },
);

// Separate layer = a pristine empty database, so the zero-card case is not
// contaminated by the card the shared-layer block above creates.
it.layer(makeBoardSkeletonTestLayer("t3o-board-skeleton-empty-test-"))(
  "board walking skeleton (empty database)",
  (it) => {
    it.effect("an empty board rehydrates to the same read model a from-empty replay produces", () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        // The replay-equality invariant must hold for zero cards too: an
        // empty board is an *absent* field on both sides, never `{cards:[]}`
        // on one and `undefined` on the other.
        const rehydrated = yield* snapshotQuery.getCommandReadModel();
        const replayed = createEmptyReadModel(createdAt);
        assert.strictEqual(rehydrated.board, undefined);
        assert.deepStrictEqual(rehydrated.board, replayed.board);

        // And the shell snapshot carries no empty `cards` array (payload
        // discipline — nothing board-shaped reaches the client until a card
        // exists).
        const shell = yield* snapshotQuery.getShellSnapshot();
        assert.strictEqual(shell.cards, undefined);
      }),
    );
  },
);

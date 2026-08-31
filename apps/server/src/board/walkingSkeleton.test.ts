/**
 * T3o walking-skeleton verification (t3o-02): a dispatched `board.card.create`
 * flows through every seam — decider, event store, in-memory projector,
 * persisted projection, snapshot queries — and replaying the persisted events
 * from an empty read model reproduces exactly the board state the engine
 * rehydrates from the projection tables.
 */
import {
  BOARD_SEED_LABEL_IDS,
  BOARD_SEED_LABELS,
  BOARD_SEED_STAGES,
  BoardStageId,
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
  orderKey: "m",
  createdAt,
} as const;

const expectedCard = {
  id: cardId,
  key: "CARD-1",
  cardNumber: 1,
  projectId,
  labels: [],
  stage: BoardStageId.make("backlog"),
  orderKey: "m",
  title: "First card",
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  sourcePlanId: null,
  threadLinks: [],
  externalRef: null,
  humanInLoop: null,
  reviewOverrides: null,
  worktree: null,
  pullRequest: null,
  pullRequestHistory: [],
  pullRequestFloor: null,
  blocked: false,
  archivedAt: null,
  createdAt,
  updatedAt: createdAt,
} as const;

// The shell carries the bounded BoardCardShell (t3o-04), never the full
// aggregate above. Spelled out literally — building it through
// makeBoardCardShell would make the assertion tautological.
const expectedCardShell = {
  cardId,
  key: "CARD-1",
  projectId,
  labelIds: [],
  stage: BoardStageId.make("backlog"),
  orderKey: "m",
  title: "First card",
  blocked: false,
  dependencyCount: 0,
  hasBrief: false,
  // Null on every live shell — archived cards leave the snapshot (D15).
  archivedAt: null,
  hasPr: false,
  attachmentCount: 0,
  queued: false,
  stalled: false,
  stepRunning: false,
  threadState: "none",
  awaitingInput: false,
  activeThreadId: null,
  // Sub-board and review summary fields are key-optional and absent until
  // their producing specs land — zero wire bytes per unsourced field.
} as const;

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
        assert.deepStrictEqual(rehydrated.board, {
          cards: [expectedCard],
          // The migration seeds the catalogue on every board; a card created
          // without labels carries none, but the seeds are present.
          labels: BOARD_SEED_LABELS,
          // The eight compiled stages are seeded too (D2), and a from-empty
          // replay reproduces the same list (AC18).
          stages: BOARD_SEED_STAGES,
          nextCardNumberByProject: { [projectId]: 2 },
        });

        // Shell snapshot carries the bounded card shell to every connecting
        // client — never the full aggregate (t3o-04, D7).
        const shell = yield* snapshotQuery.getShellSnapshot();
        assert.deepStrictEqual(shell.cards, [expectedCardShell]);

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

  // t3o-19 AC 12. `step_label` became nullable and `stage_label` was added, and
  // migration 020 deliberately does NOT rewrite history (D7): a pre-020 row
  // keeps its non-null label. That is only safe if BOTH shapes survive the
  // round trip identically — a projector that coerced one of them would make a
  // table rehydration diverge from a from-empty replay, which is the invariant
  // the whole board read model rests on.
  it.effect("rehydration equals replay for both stepped and unstepped run rows", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      const frozen = {
        prompt: "Do the work.",
        providerInstanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
        mode: "plan",
        runtimeMode: "auto",
        humanInLoop: false,
        maxAttempts: 3,
        timeoutMs: 60_000,
        createdAt,
      } as const;

      for (const [suffix, title] of [
        ["unstepped", "Unstepped card"],
        ["stepped", "Stepped card"],
        ["legacy", "Legacy card"],
      ] as const) {
        yield* engine.dispatch({
          type: "board.card.create",
          commandId: CommandId.make(`cmd-card-${suffix}`),
          cardId: BoardCardId.make(`card-${suffix}`),
          projectId,
          title,
          orderKey: `order-${suffix}`,
          createdAt,
        });
      }

      // Post-t3o-19 shape: a stage with no steps.
      yield* engine.dispatch({
        type: "board.card.select-step",
        commandId: CommandId.make("cmd-select-unstepped"),
        cardId: BoardCardId.make("card-unstepped"),
        stepId: "planning",
        stepLabel: null,
        stageLabel: "Planning",
        ...frozen,
      });
      // Post-t3o-19 shape: the review loop, which genuinely has steps.
      yield* engine.dispatch({
        type: "board.card.select-step",
        commandId: CommandId.make("cmd-select-stepped"),
        cardId: BoardCardId.make("card-stepped"),
        stepId: "review@1",
        stepLabel: "Review · round 1",
        stageLabel: "Code review",
        ...frozen,
      });
      // The shape migration 020 leaves behind: a label, but no frozen stage
      // label, because the row predates the freeze.
      yield* engine.dispatch({
        type: "board.card.select-step",
        commandId: CommandId.make("cmd-select-legacy"),
        cardId: BoardCardId.make("card-legacy"),
        stepId: "building",
        stepLabel: "Building",
        stageLabel: null,
        ...frozen,
      });

      const rehydrated = yield* snapshotQuery.getCommandReadModel();
      const labels = (rehydrated.board?.stepStates ?? []).map((state) => ({
        stepId: state.stepId,
        stepLabel: state.stepLabel,
        stageLabel: state.stageLabel,
      }));
      assert.includeDeepMembers(labels, [
        { stepId: "planning", stepLabel: null, stageLabel: "Planning" },
        { stepId: "review@1", stepLabel: "Review · round 1", stageLabel: "Code review" },
        { stepId: "building", stepLabel: "Building", stageLabel: null },
      ]);

      const events: OrchestrationEvent[] = Array.from(
        yield* Stream.runCollect(engine.readEvents(0)),
      );
      let replayed = createEmptyReadModel(createdAt);
      for (const event of events) {
        replayed = yield* projectEvent(replayed, event);
      }
      assert.deepStrictEqual(replayed.board?.stepStates, rehydrated.board?.stepStates);
    }),
  );

  // Labels round-trip through the join table and the shell, and a from-empty
  // replay reproduces them identically (t3o-06a). The decider sees the seeded
  // catalogue (the migration seeds it), so a create tagged with the feature
  // seed label validates.
  it.effect("persists card labels through the join and replays them identically", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: CommandId.make("cmd-card-create-labelled"),
        cardId: BoardCardId.make("card-labelled"),
        projectId,
        title: "Labelled card",
        labels: [BOARD_SEED_LABEL_IDS.feature],
        orderKey: "z",
        createdAt,
      });

      const rehydrated = yield* snapshotQuery.getCommandReadModel();
      const rehydratedCard = rehydrated.board?.cards.find((card) => card.id === "card-labelled");
      assert.deepStrictEqual(rehydratedCard?.labels, [BOARD_SEED_LABEL_IDS.feature]);

      const shell = yield* snapshotQuery.getShellSnapshot();
      const shellCard = shell.cards?.find((card) => card.cardId === "card-labelled");
      assert.deepStrictEqual(shellCard?.labelIds, [BOARD_SEED_LABEL_IDS.feature]);
      // The catalogue rides the shell once, as a top-level array.
      assert.isTrue((shell.boardLabels?.length ?? 0) >= 3);

      const events: OrchestrationEvent[] = Array.from(
        yield* Stream.runCollect(engine.readEvents(0)),
      );
      let replayed = createEmptyReadModel(createdAt);
      for (const event of events) replayed = yield* projectEvent(replayed, event);
      assert.deepStrictEqual(replayed.board, rehydrated.board);
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
          orderKey: "m",
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
          orderKey: "m",
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
          orderKey: "t",
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

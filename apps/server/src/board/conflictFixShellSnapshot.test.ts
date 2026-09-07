/**
 * The SNAPSHOT producer for `stepConflictFix` (T3O-9).
 *
 * The flag has two producers that must agree: the `card-stalled` delta, which
 * keeps a connected client's card honest, and this SQL-derived shell snapshot,
 * which is what every client gets on connect and on reload. The delta path is
 * covered by the projector and reducer suites; if only that side were right,
 * the amber "Conflicts" pill would survive right up until the page refreshed
 * and then vanish while the merge was still held.
 *
 * That is also the whole reason the fact rides the PERSISTED step label rather
 * than the reactor's in-memory merge arm: the arm dies on restart, the row does
 * not. So this drives the real seams (decider → event store → projection →
 * snapshot query), because a snapshot read is exactly what a restarted server
 * hands its clients.
 */
import {
  BOARD_CONFLICT_STEP_LABEL,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCardShell,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
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
import { ServerConfig } from "../config.ts";

/** One database per scenario: commands are deduped by `commandId`, so a shared
    database would let one scenario's writes satisfy the next one's dispatch. */
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
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-conflict");
const cardId = BoardCardId.make("card-conflict");
const stepId = String(BOARD_SEED_STAGE_IDS.merge);
const threadId = ThreadId.make("thread-conflict");

const frozenConfig = {
  prompt: "merge the base branch into this card's branch and resolve the conflicts",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build" as const,
  runtimeMode: "full-access" as const,
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 1000,
  baseTipAtRoundStart: null,
} as const;

/** Seed a card sitting at the merge stage with one selected step. The step's
    LABEL is the whole variable: the armed fix wears
    `BOARD_CONFLICT_STEP_LABEL`, a hand-opened merge conversation wears null. */
const seedSelectedStep = (stepLabel: string | null) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project"),
      projectId,
      title: "Board Project",
      workspaceRoot: "/tmp/project-conflict",
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt,
    });
    yield* engine.dispatch({
      type: "board.card.create",
      commandId: CommandId.make("cmd-create"),
      cardId,
      projectId,
      title: "A card whose merge hit conflicts",
      orderKey: "m",
      stage: BOARD_SEED_STAGE_IDS.merge,
      createdAt,
    });
    yield* engine.dispatch({
      type: "board.card.select-step",
      commandId: CommandId.make("cmd-select"),
      cardId,
      stepId,
      stepLabel,
      stageLabel: "Ready for merge",
      ...frozenConfig,
      createdAt,
    });
    return engine;
  });

/** Admit the seeded step to running, the way the governor does. */
const admit = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "board.card.admit-step",
    commandId: CommandId.make("cmd-admit"),
    cardId,
    stepId,
    admitted: true,
    threadId,
    createdAt,
  });
});

const cardsOf = (snapshot: OrchestrationShellSnapshot): ReadonlyArray<BoardCardShell> =>
  snapshot.cards ?? [];

const shellCard = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot = yield* snapshotQuery.getShellSnapshot();
  return cardsOf(snapshot).find((card) => card.cardId === cardId);
});

describe("stepConflictFix on the shell SNAPSHOT (T3O-9)", () => {
  it.layer(makeTestLayer("t3o-conflict-snap-1-"))("a conflict fix waiting for a slot", (it) => {
    it.effect("is already flagged, before any agent starts", () =>
      Effect.gen(function* () {
        const engine = yield* seedSelectedStep(BOARD_CONFLICT_STEP_LABEL);
        yield* engine.dispatch({
          type: "board.card.admit-step",
          commandId: CommandId.make("cmd-hold"),
          cardId,
          stepId,
          admitted: false,
          threadId: null,
          createdAt,
        });

        const card = yield* shellCard;
        // The merge is held from the moment the fix is requested. The card
        // does get a queue pill here, but it says "queued for build" and
        // nothing about a held merge — the whole reason this flag covers the
        // queued window rather than only the running one.
        assert.strictEqual(card?.stepConflictFix, true);
        assert.strictEqual(card?.queued, true);
        assert.strictEqual(card?.stepRunning, false);
      }),
    );
  });

  it.layer(makeTestLayer("t3o-conflict-snap-2-"))("a conflict fix an agent is running", (it) => {
    it.effect("comes back from SQL flagged and running, both", () =>
      Effect.gen(function* () {
        yield* seedSelectedStep(BOARD_CONFLICT_STEP_LABEL);
        yield* admit;

        const card = yield* shellCard;
        // Two facts, each in its own vocabulary: the merge is HELD (amber pill)
        // and an agent is WORKING (the existing blue dot). Neither replaces the
        // other.
        assert.strictEqual(card?.stepConflictFix, true);
        assert.strictEqual(card?.stepRunning, true);
        assert.strictEqual(card?.stalled, false);
        assert.strictEqual(card?.held, false);
      }),
    );
  });

  it.layer(makeTestLayer("t3o-conflict-snap-3-"))("a hand-opened merge conversation", (it) => {
    it.effect("is a running step at the merge stage and NOT a conflict fix", () =>
      Effect.gen(function* () {
        // The case the old `stepRunning` inference got wrong: the merge stage
        // does run something other than a conflict fix — a clean conversation a
        // human restarted by hand, selected with no step identity at all.
        yield* seedSelectedStep(null);
        yield* admit;

        const card = yield* shellCard;
        assert.strictEqual(card?.stepRunning, true);
        assert.strictEqual(card?.stepConflictFix, false);
      }),
    );
  });

  it.layer(makeTestLayer("t3o-conflict-snap-4-"))("a conflict fix that settled", (it) => {
    it.effect("clears the flag the moment the step is terminal", () =>
      Effect.gen(function* () {
        const engine = yield* seedSelectedStep(BOARD_CONFLICT_STEP_LABEL);
        yield* admit;
        yield* engine.dispatch({
          type: "board.card.settle-step",
          commandId: CommandId.make("cmd-settle"),
          cardId,
          stepId,
          outcome: "succeeded",
          createdAt,
        });

        // The label stays on the row — history is never rewritten — so the
        // snapshot has to key on the STATUS as well, or a card would wear the
        // pill for the rest of its life at this stage.
        const card = yield* shellCard;
        assert.strictEqual(card?.stepConflictFix, false);
        assert.strictEqual(card?.held, true);
      }),
    );
  });

  it.layer(makeTestLayer("t3o-conflict-snap-5-"))("a conflict fix recovery gave up on", (it) => {
    it.effect("hands over to the louder Stalled chip rather than fighting it", () =>
      Effect.gen(function* () {
        const engine = yield* seedSelectedStep(BOARD_CONFLICT_STEP_LABEL);
        yield* admit;
        yield* engine.dispatch({
          type: "board.card.recover-step",
          commandId: CommandId.make("cmd-escalate"),
          cardId,
          stepId,
          threadId,
          escalateToHuman: true,
          progressed: false,
          createdAt,
        });

        const card = yield* shellCard;
        assert.strictEqual(card?.stalled, true);
        assert.strictEqual(card?.stepConflictFix, false);
      }),
    );
  });
});

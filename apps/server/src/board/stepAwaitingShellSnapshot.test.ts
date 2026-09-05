/**
 * The SNAPSHOT producer for `stepAwaiting` (t3o-34, D4), and the NULL fallback
 * migration 034 rests on.
 *
 * `stepAwaiting` has two producers that must agree: the `card-stalled` delta,
 * which keeps a connected client's card honest, and this SQL-derived shell
 * snapshot, which is what every client gets on connect and on reload. The delta
 * path is covered by the projector and reducer suites; if only that side were
 * right, a card would show the correct "Input needed" / "Needs a human"
 * treatment right up until the page refreshed and then go straight back to
 * claiming the agent was working — the exact lie t3o-34 exists to remove,
 * surviving one F5.
 *
 * The NULL case is the other half. Migration 033 adds `awaiting_reason` as a
 * plain nullable column and does not rewrite history, so every row written
 * before it reads NULL — and the whole back-compat story is that a NULL means
 * `question`, because before t3o-34 the only route into `awaiting-input` was the
 * structured-question path. Nothing else asserts that.
 *
 * Run through the real seams (decider → event store → projection → snapshot
 * query), because that is where the two producers actually meet.
 */
import {
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
import * as SqlClient from "effect/unstable/sql/SqlClient";

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
    // provideMerge, not provide: the NULL-column case writes the pre-034 row
    // shape directly, so the test needs the same `SqlClient` the projection uses.
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

const createdAt = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-await");
const cardId = BoardCardId.make("card-await");
const stepId = "planning";

const frozenConfig = {
  prompt: "interview the human",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "plan" as const,
  runtimeMode: "auto" as const,
  humanInLoop: true,
  maxAttempts: 3,
  timeoutMs: 1000,
  baseTipAtRoundStart: null,
} as const;

/** Drive a card all the way to a parked step, through the real decider. */
const seedParkedStep = (reason: "question" | "stopped") =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-project"),
      projectId,
      title: "Board Project",
      workspaceRoot: "/tmp/project-await",
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
      title: "A card whose agent asked something",
      orderKey: "m",
      stage: BOARD_SEED_STAGE_IDS.planning,
      createdAt,
    });
    yield* engine.dispatch({
      type: "board.card.select-step",
      commandId: CommandId.make("cmd-select"),
      cardId,
      stepId,
      stepLabel: null,
      stageLabel: "Planning",
      ...frozenConfig,
      createdAt,
    });
    yield* engine.dispatch({
      type: "board.card.admit-step",
      commandId: CommandId.make("cmd-admit"),
      cardId,
      stepId,
      admitted: true,
      threadId: ThreadId.make("thread-await"),
      createdAt,
    });
    yield* engine.dispatch({
      type: "board.card.await-step-input",
      commandId: CommandId.make("cmd-await"),
      cardId,
      stepId,
      reason,
      createdAt,
    });
    return engine;
  });

const cardsOf = (snapshot: OrchestrationShellSnapshot): ReadonlyArray<BoardCardShell> =>
  snapshot.cards ?? [];

const shellCard = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot = yield* snapshotQuery.getShellSnapshot();
  return cardsOf(snapshot).find((card) => card.cardId === cardId);
});

describe("stepAwaiting on the shell SNAPSHOT (t3o-34, D4)", () => {
  it.layer(makeTestLayer("t3o-await-snap-1-"))("a step parked with nothing to answer", (it) => {
    it.effect("comes back from SQL as `stopped`, and not running", () =>
      Effect.gen(function* () {
        yield* seedParkedStep("stopped");
        const card = yield* shellCard;

        assert.strictEqual(card?.stepAwaiting, "stopped");
        // The three flags that share this slice have to be right together: a
        // parked step is not running, not stalled, and not settled.
        assert.strictEqual(card?.stepRunning, false);
        assert.strictEqual(card?.stalled, false);
        assert.strictEqual(card?.held, false);
      }),
    );
  });

  it.layer(makeTestLayer("t3o-await-snap-2-"))("a step parked on a question", (it) => {
    it.effect("comes back from SQL as `question`", () =>
      Effect.gen(function* () {
        yield* seedParkedStep("question");
        assert.strictEqual((yield* shellCard)?.stepAwaiting, "question");
      }),
    );
  });

  it.layer(makeTestLayer("t3o-await-snap-3-"))("a pre-migration-034 row", (it) => {
    it.effect("reads a NULL awaiting_reason as `question`", () =>
      Effect.gen(function* () {
        yield* seedParkedStep("stopped");
        // What a row written before migration 034 looks like: the column exists
        // (the ALTER ran) but nothing ever wrote it. Every such row reached
        // `awaiting-input` through the structured-question path, because before
        // t3o-34 there was no other way in — so it must read as `question`, not
        // as a card claiming its agent stopped for no reason.
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE board_card_step_state SET awaiting_reason = NULL WHERE card_id = ${cardId}`;

        assert.strictEqual((yield* shellCard)?.stepAwaiting, "question");
      }),
    );
  });

  it.layer(makeTestLayer("t3o-await-snap-4-"))("a step that is not parked at all", (it) => {
    it.effect("carries no reason, whatever the column happens to hold", () =>
      Effect.gen(function* () {
        const engine = yield* seedParkedStep("stopped");
        // A resume leaves `awaiting_reason` behind on the row — it is only
        // meaningful on `awaiting-input`, and nothing clears it. The snapshot
        // must key on the STATUS, or a card would keep its badge for the rest of
        // the step's life.
        yield* engine.dispatch({
          type: "board.card.resume-step",
          commandId: CommandId.make("cmd-resume"),
          cardId,
          stepId,
          createdAt,
        });

        const card = yield* shellCard;
        assert.strictEqual(card?.stepAwaiting, null);
        assert.strictEqual(card?.stepRunning, true);
      }),
    );
  });
});

/**
 * The provider-cooldown slice on the SHELL SNAPSHOT (T3O-22, D14).
 *
 * A cooldown has two producers, and the snapshot is the one that matters most.
 * The `card-provider-limit-upserted` delta keeps a CONNECTED client honest, but a
 * usage limit is a multi-hour fact and the client that reloads — or reconnects
 * over a flaky tunnel — in the middle of one replays no delta at all. If only the
 * delta side were right, the pill, the popover, its waiting list and both of its
 * buttons would be invisible for essentially the whole life of every limit, which
 * is the entire window in which a human might want to act on it.
 *
 * Run through the real seams (decider → event store → projection → snapshot
 * query), because that is where the two producers actually meet.
 */
import {
  BoardCardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
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
const projectId = ProjectId.make("project-limit");
const cardId = BoardCardId.make("card-limit");
const codex = ProviderInstanceId.make("codex");

const seedProject = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId,
    title: "Board Project",
    workspaceRoot: "/tmp/project-limit",
    defaultModelSelection: { instanceId: codex, model: "gpt-5-codex" },
    createdAt,
  });
  yield* engine.dispatch({
    type: "board.provider-limit.record",
    commandId: CommandId.make("cmd-limit"),
    limit: {
      providerInstanceId: codex,
      kind: "wait",
      until: "2026-01-01T05:00:00.000Z",
      detectedAt: createdAt,
      lastCheckedAt: createdAt,
      reason: "You've hit your usage limit. Resets 5am.",
      ruleId: "codex.usage-limit",
      sourceCardId: cardId,
      knownTime: true,
      blindSince: null,
      probeCardId: null,
      setByHuman: false,
    },
    createdAt,
  });
  return engine;
});

const shellLimits = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const snapshot: OrchestrationShellSnapshot = yield* snapshotQuery.getShellSnapshot();
  return snapshot.boardProviderLimits;
});

describe("provider cooldowns on the shell SNAPSHOT (T3O-22, D14)", () => {
  it.layer(makeTestLayer("t3o-limit-snap-1-"))("a live cooldown", (it) => {
    it.effect("rides the snapshot, so a client reconnecting mid-limit still sees it", () =>
      Effect.gen(function* () {
        yield* seedProject;

        const limits = (yield* shellLimits) ?? [];
        assert.lengthOf(limits, 1);
        const limit = limits[0];
        assert.strictEqual(limit?.providerInstanceId, codex);
        assert.strictEqual(limit?.kind, "wait");
        assert.strictEqual(limit?.until, "2026-01-01T05:00:00.000Z");
        // The two booleans are 0/1 columns: a coercion slip here would flip the
        // popover from "resets 5:00 AM" to "no reset time given".
        assert.strictEqual(limit?.knownTime, true);
        assert.strictEqual(limit?.setByHuman, false);
        assert.strictEqual(limit?.blindSince, null);
      }),
    );
  });

  it.layer(makeTestLayer("t3o-limit-snap-2-"))("a cleared cooldown", (it) => {
    it.effect("leaves the slice ABSENT rather than empty, like every other one", () =>
      Effect.gen(function* () {
        const engine = yield* seedProject;
        yield* engine.dispatch({
          type: "board.provider-limit.clear",
          commandId: CommandId.make("cmd-clear"),
          providerInstanceId: codex,
          createdAt,
        });

        assert.strictEqual(yield* shellLimits, undefined);
      }),
    );
  });
});

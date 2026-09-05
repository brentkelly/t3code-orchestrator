/**
 * T3o board RPC handlers (t3o-04): `board.subscribeCard` against the real
 * engine and projection tables — scope rejection, initial detail frame,
 * re-emission on card change without any shell snapshot involvement, and
 * the missing-card failure.
 */
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  BoardCardId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  type BoardCardDetailStreamItem,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
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
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";
import type { SupervisorReactorShape } from "./supervisorReactor.ts";
import { boardRpcHandlers } from "./rpc.ts";

const makeBoardRpcTestLayer = (prefix: string) =>
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

const t0 = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-rpc");
const cardId = BoardCardId.make("card-rpc");

const session = (scopes: ReadonlyArray<AuthenticatedSession["scopes"][number]>) =>
  ({
    sessionId: AuthSessionId.make("session-rpc-test"),
    subject: "rpc-test",
    method: "bearer-access-token",
    scopes,
  }) as AuthenticatedSession;

const seedCard = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-rpc-project"),
    projectId,
    title: "RPC Project",
    workspaceRoot: "/tmp/project-rpc",
    defaultModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.create",
    commandId: CommandId.make("cmd-rpc-card"),
    cardId,
    projectId,
    title: "RPC card",
    orderKey: "m",
    createdAt: t0,
  });
});

/** Records what the RPC handlers asked the supervisor to do, so the
    authorization tests can assert that an unauthorized call reached it not at
    all — a scope check that runs but still performs the action is worse than
    no check. */
const supervisorCalls: {
  refresh: Array<string>;
  merge: Array<string>;
  submit: Array<string>;
} = { refresh: [], merge: [], submit: [] };

const supervisorStub: SupervisorReactorShape = {
  start: () => Effect.void,
  reconcile: Effect.void,
  sweep: Effect.void,
  drain: Effect.void,
  refreshPullRequest: (cardId) =>
    Effect.sync(() => {
      supervisorCalls.refresh.push(String(cardId));
    }),
  mergePullRequest: (cardId) =>
    Effect.sync(() => {
      supervisorCalls.merge.push(String(cardId));
      return { outcome: "merged", number: 284 } as const;
    }),
  submitForMerge: (cardId) =>
    Effect.sync(() => {
      supervisorCalls.submit.push(String(cardId));
      return { outcome: "started" } as const;
    }),
};

const makeHandlers = (scopes: ReadonlyArray<AuthenticatedSession["scopes"][number]>) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    return boardRpcHandlers({
      currentSession: session(scopes),
      orchestrationEngine,
      projectionSnapshotQuery,
      boardSupervisor: supervisorStub,
    });
  });

it.layer(makeBoardRpcTestLayer("t3o-board-rpc-test-"))("board.subscribeCard", (it) => {
  it.effect("rejects a session without the orchestration read scope", () =>
    Effect.gen(function* () {
      yield* seedCard;
      const handlers = yield* makeHandlers([]);
      const failure = yield* Effect.flip(
        Stream.runHead(handlers["board.subscribeCard"]({ cardId })).pipe(Effect.scoped),
      );
      assert.strictEqual(failure._tag, "EnvironmentAuthorizationError");
    }),
  );

  it.effect("fails for a card that does not exist", () =>
    Effect.gen(function* () {
      const handlers = yield* makeHandlers([AuthOrchestrationReadScope]);
      const failure = yield* Effect.flip(
        Stream.runHead(
          handlers["board.subscribeCard"]({ cardId: BoardCardId.make("card-missing") }),
        ).pipe(Effect.scoped),
      );
      assert.strictEqual(failure._tag, "BoardSubscribeCardError");
    }),
  );

  it.effect("emits the full detail on subscribe and re-emits it on card change", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const handlers = yield* makeHandlers([AuthOrchestrationReadScope]);

      const collected = yield* Deferred.make<ReadonlyArray<BoardCardDetailStreamItem>>();
      const firstFrame = yield* Deferred.make<void>();
      yield* Effect.forkScoped(
        handlers["board.subscribeCard"]({ cardId })
          .pipe(
            Stream.tap(() => Deferred.succeed(firstFrame, undefined)),
            Stream.take(2),
            Stream.runCollect,
          )
          .pipe(
            Effect.flatMap((items) => Deferred.succeed(collected, Array.from(items))),
            Effect.scoped,
          ),
      );

      // Dispatch the update only after the initial frame arrived, so the
      // second frame is unambiguously the live re-emission.
      yield* Deferred.await(firstFrame);
      yield* engine.dispatch({
        type: "board.card.update",
        commandId: CommandId.make("cmd-rpc-brief"),
        cardId,
        brief: "The brief body.",
        createdAt: t0,
      });

      const items = yield* Deferred.await(collected);
      assert.lengthOf(items, 2);
      const [initial, updated] = items;
      assert.strictEqual(initial?.kind, "card-detail");
      assert.strictEqual(initial?.detail.card.id, cardId);
      assert.strictEqual(initial?.detail.brief, null);
      // The re-emitted frame carries the post-change aggregate and body.
      assert.strictEqual(updated?.detail.card.briefRef, "brief");
      assert.strictEqual(updated?.detail.brief, "The brief body.");
    }),
  );
});

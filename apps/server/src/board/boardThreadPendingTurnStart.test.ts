/**
 * `boardThreadPendingTurnStartAt` (T3O-18): when a turn was asked for on a
 * thread and has not begun.
 *
 * The supervisor's blind spot, driven against the real engine and projection
 * rather than a stub, because the whole value of the query is that its
 * predicate matches upstream's own pending-turn-start row. Stubbing it would
 * test the reactor's arithmetic and nothing about the fact it depends on.
 *
 * The window is short and entirely real: a turn exists as a row from the moment
 * a human sends the message, and only claims a turn id when the provider starts
 * it. In between, every "is this thread busy" signal the board had reads empty —
 * which is how a `turn.completed` for the PREVIOUS turn came to park a step
 * whose human had already moved on, leaving the card pulsing blue beside "Needs
 * a human" for the rest of the run.
 */
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
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
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";

const makeLayer = (prefix: string) =>
  Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
    ServerSettings.layerTest(),
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
const at = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const projectId = ProjectId.make("project-a");
const instance = ProviderInstanceId.make("codex");

let commandSeq = 0;
const nextCommandId = () => CommandId.make(`cmd-pending-${(commandSeq += 1)}`);

/** One `it.layer` block shares a database, so each test derives its own thread
    id from its tag and the project create is idempotent by its fixed id. */
const seed = Effect.fn("seed")(function* (tag: string) {
  const threadId = ThreadId.make(`thread-${tag}`);
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId,
    title: "Project A",
    workspaceRoot: "/tmp/project-a",
    defaultModelSelection: { instanceId: instance, model: "gpt-5-codex" },
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`cmd-thread-${tag}`),
    threadId,
    projectId,
    title: `Thread ${tag}`,
    modelSelection: { instanceId: instance, model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: t0,
  });
  return threadId;
});

/** A human sending a message — the command that emits
    `thread.turn-start-requested` and so writes the pending row. */
const sendMessage = (threadId: ThreadId, messageId: string, createdAt: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: nextCommandId(),
      threadId,
      message: {
        messageId: MessageId.make(messageId),
        role: "user",
        text: "Carry on with the plan.",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt,
    });
  });

/** The provider actually starting the requested turn, which is what claims the
    pending row. */
const startTurn = (threadId: ThreadId, turnId: string, createdAt: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: nextCommandId(),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId: instance,
        runtimeMode: "full-access",
        activeTurnId: TurnId.make(turnId),
        lastError: null,
        updatedAt: createdAt,
      },
      createdAt,
    });
  });

const pendingTurnStartAt = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const methods = boardSnapshotQueryMethodsOf(snapshotQuery);
    assert.isNotNull(methods);
    return yield* methods!.boardThreadPendingTurnStartAt(threadId);
  });

it.layer(makeLayer("t3o-board-pending-turn-"))("boardThreadPendingTurnStartAt (T3O-18)", (it) => {
  it.effect("a thread nobody has written to has nothing outstanding", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("idle");
      assert.isNull(yield* pendingTurnStartAt(threadId));
    }),
  );

  it.effect("a message the provider has not picked up yet is outstanding", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("sent");
      yield* sendMessage(threadId, "msg-sent-1", at(5));
      // The whole window: the turn is real, and it has no id for anything else
      // to see it by.
      assert.strictEqual(yield* pendingTurnStartAt(threadId), at(5));
    }),
  );

  it.effect("the turn starting clears it", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("started");
      yield* sendMessage(threadId, "msg-started-1", at(5));
      assert.strictEqual(yield* pendingTurnStartAt(threadId), at(5));

      yield* startTurn(threadId, "turn-started-1", at(6));

      // This is what stops the supervisor's guard wedging: once the turn is
      // running, its own completion is nobody's leftover and parks normally.
      assert.isNull(yield* pendingTurnStartAt(threadId));
    }),
  );

  it.effect("a second message while a turn runs is outstanding again", () =>
    Effect.gen(function* () {
      const threadId = yield* seed("queued");
      yield* sendMessage(threadId, "msg-queued-1", at(5));
      yield* startTurn(threadId, "turn-queued-1", at(6));
      // The production shape: the human types the next message while the turn
      // they are answering is still finishing.
      yield* sendMessage(threadId, "msg-queued-2", at(9));

      assert.strictEqual(yield* pendingTurnStartAt(threadId), at(9));
    }),
  );

  it.effect("one thread's queued message is not another's", () =>
    Effect.gen(function* () {
      const waiting = yield* seed("waiting");
      const quiet = yield* seed("quiet");
      yield* sendMessage(waiting, "msg-waiting-1", at(5));

      assert.strictEqual(yield* pendingTurnStartAt(waiting), at(5));
      // The scoping that matters: a step whose agent really has stopped must
      // not be shielded by a sibling thread's queued message.
      assert.isNull(yield* pendingTurnStartAt(quiet));
    }),
  );
});

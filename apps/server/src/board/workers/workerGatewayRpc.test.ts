/**
 * T3o: the worker side's gateway RPCs and its half of the MCP relay.
 */
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  type BoardGatewayCall,
  type BoardGatewayLaunchScheduleRunInput,
  type BoardMcpRelayRequest,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  t3oBoardSubject,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { aliveThread, fakeThreadState } from "../threadGateway.testkit.ts";
import { makeInProcessWorker, WORKER_PROJECT_ID } from "./distributed.testkit.ts";
import { scheduleRunBranchOf } from "../schedules/scheduleLogic.ts";
import { decodeGatewayCallResult } from "./gatewayWire.ts";
import { makeMcpRelayHost, type McpRelayHostShape } from "./McpRelayHost.ts";
import type { BoardRelayStoreShape } from "./BoardRelayStore.ts";
import { WorkerGatewayHost } from "./WorkerGatewayHost.ts";
import { workerGatewayRpcHandlers } from "./workerGatewayRpc.ts";

const session = (
  scopes: AuthenticatedSession["scopes"],
  sessionId = "session-board",
): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(sessionId),
  subject: "one-time-token",
  method: "bearer-access-token",
  scopes,
});
const SESSION = AuthSessionId.make("session-board");

const CENTRAL = EnvironmentId.make("env-central");
const call = {
  toolName: "board_get_card_context",
  params: {},
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "sess-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  stateDir: "/worker/state",
};

it.effect("a gateway call answers in the wire's own encoding", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* makeInProcessWorker();
      const threadId = ThreadId.make("thread-1");
      yield* Ref.update(env.threads.states, (states) =>
        new Map(states).set(threadId, aliveThread(threadId)),
      );
      const handlers = workerGatewayRpcHandlers(session([AuthOrchestrationOperateScope]));
      const encoded = yield* handlers["boardWorker.gateway.call"]({
        _tag: "threadState",
        threadId,
      }).pipe(Effect.provideService(WorkerGatewayHost, env.host));
      const decoded = yield* decodeGatewayCallResult("threadState", encoded);
      assert.strictEqual(decoded?.threadId, threadId);
      assert.isTrue(decoded?.alive);
    }),
  ),
);

it.effect("a call that drives threads needs the operate scope", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* makeInProcessWorker();
      const handlers = workerGatewayRpcHandlers(session([AuthOrchestrationReadScope]));
      const failure = yield* Effect.flip(
        handlers["boardWorker.gateway.call"]({ _tag: "todoLogHead" }).pipe(
          Effect.provideService(WorkerGatewayHost, env.host),
          Effect.as(null),
        ),
      );
      assert.strictEqual(failure._tag, "EnvironmentAuthorizationError");
    }),
  ),
);

/** A relay with one board listening; what it is sent lands in `sent`. */
const listening = (relay: McpRelayHostShape) =>
  Effect.gen(function* () {
    const sent = yield* Queue.unbounded<BoardMcpRelayRequest>();
    yield* relay.subscribe(CENTRAL, SESSION).pipe(
      Stream.runForEach((request) => Queue.offer(sent, request)),
      Effect.forkScoped,
    );
    yield* relay.connected.pipe(
      Stream.filter((boards) => boards.has(CENTRAL)),
      Stream.runHead,
    );
    return sent;
  });

it.effect("a relayed call waits for its board's answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* makeMcpRelayHost();
      const sent = yield* listening(relay);
      const forwarded = yield* relay.forward(CENTRAL, call).pipe(Effect.forkScoped);
      const request = yield* Queue.take(sent);
      assert.strictEqual(request.toolName, "board_get_card_context");
      yield* relay.respond(
        { callId: request.callId, outcome: { _tag: "success", value: 1 } },
        SESSION,
      );
      assert.deepStrictEqual(yield* Fiber.join(forwarded), { _tag: "success", value: 1 });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
);

it.effect("a call a dropped stream left unanswered goes out again, under the same id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* makeMcpRelayHost();
      const first = yield* relay
        .subscribe(CENTRAL, SESSION)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* relay.connected.pipe(
        Stream.filter((boards) => boards.has(CENTRAL)),
        Stream.runHead,
      );
      const forwarded = yield* relay.forward(CENTRAL, call).pipe(Effect.forkScoped);
      // The first stream takes the call and ends without answering.
      const [dropped] = yield* Fiber.join(first);
      const [again] = yield* relay
        .subscribe(CENTRAL, SESSION)
        .pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual(again?.callId, dropped?.callId);
      if (again === undefined) return;
      yield* relay.respond(
        { callId: again.callId, outcome: { _tag: "success", value: 2 } },
        SESSION,
      );
      assert.deepStrictEqual(yield* Fiber.join(forwarded), { _tag: "success", value: 2 });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
);

it.effect("with no board listening, or no answer in time, the board is unreachable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* makeMcpRelayHost("1 minute");
      const alone = yield* Effect.flip(relay.forward(CENTRAL, call));
      assert.strictEqual(alone.reason, "not-connected");

      const sent = yield* listening(relay);
      const waiting = yield* relay.forward(CENTRAL, call).pipe(Effect.flip, Effect.forkScoped);
      // Sent, so the call has reached its wait: it starts waiting as it sends.
      yield* Queue.take(sent);
      yield* TestClock.adjust("1 minute");
      assert.strictEqual((yield* Fiber.join(waiting)).reason, "timed-out");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  ),
);

it.effect("a board's relay belongs to the session that claimed it, not to whoever names it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* makeInProcessWorker();
      const board = workerGatewayRpcHandlers(session([AuthOrchestrationOperateScope]));
      const other = workerGatewayRpcHandlers(
        session([AuthOrchestrationOperateScope], "session-other-client"),
      );
      const onHost = Effect.provideService(WorkerGatewayHost, env.host);
      const sent = yield* Queue.unbounded<BoardMcpRelayRequest>();
      yield* board["boardWorker.subscribeMcpRelay"]({ centralEnvironmentId: CENTRAL }).pipe(
        Stream.runForEach((request) => Queue.offer(sent, request)),
        onHost,
        Effect.forkScoped,
      );
      yield* env.relayHost.connected.pipe(
        Stream.filter((boards) => boards.has(CENTRAL)),
        Stream.runHead,
      );

      // Another session naming the same board is not sent its calls...
      const subscribed = yield* other["boardWorker.subscribeMcpRelay"]({
        centralEnvironmentId: CENTRAL,
      }).pipe(Stream.runDrain, onHost, Effect.flip);
      assert.strictEqual(
        subscribed._tag === "BoardWorkerGatewayError" ? subscribed.kind : subscribed._tag,
        "refused",
      );

      // ...cannot answer one...
      const forwarded = yield* env.relayHost.forward(CENTRAL, call).pipe(Effect.forkScoped);
      const request = yield* Queue.take(sent);
      const answered = yield* other["boardWorker.mcpRelayRespond"]({
        callId: request.callId,
        outcome: { _tag: "success", value: "forged" },
      }).pipe(onHost, Effect.flip);
      assert.strictEqual(
        answered._tag === "BoardWorkerGatewayError" ? answered.kind : answered._tag,
        "refused",
      );

      // ...and cannot place a thread for that board.
      const forgedThread = ThreadId.make("thread-forged");
      const spawned = yield* other["boardWorker.gateway.call"]({
        _tag: "spawn",
        input: {
          commandId: CommandId.make("server:board-spawn:forged"),
          threadId: forgedThread,
          projectId: ProjectId.make("worker-project"),
          title: "Forged",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/home/worker/repo",
          text: "",
          attachments: [],
          centralEnvironmentId: CENTRAL,
        },
      }).pipe(onHost, Effect.as(null), Effect.flip);
      assert.strictEqual(
        spawned._tag === "BoardWorkerGatewayError" ? spawned.kind : spawned._tag,
        "refused",
      );
      assert.isNull(yield* env.relayStore.store.relayedThreadCentral(forgedThread));

      // The session the call was sent to answers it.
      const outcome = { _tag: "success", value: 3 } as const;
      yield* board["boardWorker.mcpRelayRespond"]({ callId: request.callId, outcome }).pipe(onHost);
      assert.deepStrictEqual(yield* Fiber.join(forwarded), outcome);
    }),
  ),
);

it.effect("a shared worker lets a board act only on the threads and worktrees it placed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* makeInProcessWorker();
      const threadId = ThreadId.make("thread-board-a");
      yield* Ref.update(env.threads.states, (states) =>
        new Map(states).set(threadId, aliveThread(threadId)),
      );
      yield* env.relayStore.store.recordRelayedThread(threadId, CENTRAL);
      const boardSession = (board: string): AuthenticatedSession => ({
        ...session([AuthOrchestrationOperateScope], `session-${board}`),
        subject: t3oBoardSubject(board),
      });
      const owner = workerGatewayRpcHandlers(boardSession(CENTRAL));
      const other = workerGatewayRpcHandlers(boardSession("env-other-board"));
      const onHost = Effect.provideService(WorkerGatewayHost, env.host);
      const target = { commandId: CommandId.make("server:board:target"), threadId };
      const refusedFor = (handlers: typeof other, call: BoardGatewayCall) =>
        handlers["boardWorker.gateway.call"](call).pipe(
          onHost,
          Effect.as("answered"),
          Effect.catch((error) =>
            Effect.succeed(error._tag === "BoardWorkerGatewayError" ? error.kind : error._tag),
          ),
        );

      for (const call of [
        { _tag: "interrupt", input: target },
        { _tag: "stopSession", input: target },
        { _tag: "settle", input: { ...target, auto: false } },
        { _tag: "delete", input: target },
        { _tag: "armLimitRecovery", input: target },
        { _tag: "answerPendingInput", input: { ...target, text: "yes" } },
        {
          _tag: "send",
          input: {
            ...target,
            text: "steer",
            attachments: [],
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        },
      ] satisfies ReadonlyArray<BoardGatewayCall>) {
        assert.strictEqual(yield* refusedFor(other, call), "refused", call._tag);
      }
      assert.deepStrictEqual(yield* env.threads.calls, []);
      // The worker's own threads are no board's to drive either.
      const own = ThreadId.make("thread-worker-own");
      yield* Ref.update(env.threads.states, (states) => new Map(states).set(own, aliveThread(own)));
      assert.strictEqual(
        yield* refusedFor(owner, { _tag: "interrupt", input: { ...target, threadId: own } }),
        "refused",
      );

      assert.strictEqual(
        yield* refusedFor(owner, { _tag: "interrupt", input: target }),
        "answered",
      );

      // Nor may it run CI in, or read CI logs from, a worktree it doesn't hold here.
      const ci = yield* other["boardWorker.gateway.runCi"]({
        runId: "run-1",
        worktreePath: "/home/worker/repo",
        steps: [{ name: "test", command: "true", timeoutMinutes: 1 }],
      }).pipe(Stream.runCollect, onHost, Effect.flip);
      assert.strictEqual(ci._tag, "BoardWorkerGatewayError");

      // Nor may it spawn a thread in another board's name, which would take that board's relay.
      const forged = ThreadId.make("thread-forged-for-a");
      assert.strictEqual(
        yield* refusedFor(other, {
          _tag: "spawn",
          input: {
            commandId: CommandId.make("server:board-spawn:forged"),
            threadId: forged,
            projectId: ProjectId.make("worker-project"),
            title: "Forged",
            modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: "/home/worker/repo",
            text: "",
            attachments: [],
            centralEnvironmentId: CENTRAL,
          },
        }),
        "refused",
      );
      assert.isNull(yield* env.relayStore.store.relayedThreadCentral(forged));
      const owned = yield* owner["boardWorker.subscribeMcpRelay"]({
        centralEnvironmentId: CENTRAL,
      }).pipe(Stream.runDrain, onHost, Effect.forkScoped);
      yield* env.relayHost.connected.pipe(
        Stream.filter((boards) => boards.has(CENTRAL)),
        Stream.runHead,
      );
      yield* Fiber.interrupt(owned);
    }),
  ),
);

it.effect("a deleted thread's board record goes with it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const env = yield* makeInProcessWorker();
      const threadId = ThreadId.make("thread-placed");
      yield* env.relayStore.store.recordRelayedThread(threadId, CENTRAL);
      const forgotten = yield* SubscriptionRef.changes(env.relayStore.relayed).pipe(
        Stream.filter((relayed) => !relayed.has(threadId)),
        Stream.runHead,
        Effect.forkScoped,
      );
      yield* env.threads.emit({ type: "thread-deleted", threadId });
      yield* Fiber.join(forgotten);
      assert.isNull(yield* env.relayStore.store.relayedThreadCentral(threadId));
    }),
  ),
);

describe("a board's schedule run on the worker (T3O-118)", () => {
  const RUN = ThreadId.make("thread-schedule-run");
  const boardSession = (board: string = CENTRAL): AuthenticatedSession => ({
    ...session([AuthOrchestrationOperateScope], `session-${board}`),
    subject: t3oBoardSubject(board),
  });
  const launchCall = (
    previousRuns: BoardGatewayLaunchScheduleRunInput["previousRuns"] = [],
  ): BoardGatewayCall => ({
    _tag: "launchScheduleRun",
    input: {
      commandId: CommandId.make("board-schedule:run-1"),
      threadId: RUN,
      projectId: WORKER_PROJECT_ID,
      title: "walls nightly full run",
      prompt: "Run the suite.",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      branch: "t3o/schedule-run-run",
      centralEnvironmentId: CENTRAL,
      previousRuns,
    },
  });
  /** A worker whose schedule port records each launch and removal. */
  const workerWithRuns = (
    options: {
      readonly agentCapRefusal?: () => string | null;
      readonly refuseDelete?: (threadId: ThreadId) => boolean;
    } = {},
  ) =>
    Effect.gen(function* () {
      const launched: Array<{ projectId: string; relayedTo: EnvironmentId | null }> = [];
      const removed: Array<{ worktreePath: string | null; branch: string | null }> = [];
      // The worker's relay store, once it exists: the launch reads it as it runs.
      let relayStore: BoardRelayStoreShape | null = null;
      const env = yield* makeInProcessWorker({
        ...options,
        scheduleRuns: {
          launch: (input) =>
            Effect.gen(function* () {
              const relayedTo =
                relayStore === null
                  ? null
                  : yield* relayStore
                      .relayedThreadCentral(input.threadId)
                      .pipe(Effect.orElseSucceed(() => null));
              launched.push({ projectId: input.projectId, relayedTo });
            }),
          removeRunWorktree: (input) =>
            Effect.sync(() => {
              removed.push({ worktreePath: input.worktreePath, branch: input.branch });
              return true;
            }),
        },
      });
      relayStore = env.relayStore.store;
      const run = (call: BoardGatewayCall, as = boardSession()) => {
        const handle = workerGatewayRpcHandlers(as)["boardWorker.gateway.call"];
        return handle(call).pipe(Effect.provideService(WorkerGatewayHost, env.host));
      };
      /** A refusal's kind and reason, or "answered". */
      const refusalOf = (call: BoardGatewayCall, as = boardSession()) =>
        run(call, as).pipe(
          Effect.as("answered"),
          Effect.catch((error) =>
            Effect.succeed(
              error._tag === "BoardWorkerGatewayError"
                ? `${error.kind}${error.reason === undefined ? "" : `:${error.reason}`}`
                : error._tag,
            ),
          ),
        );
      return { env, launched, removed, run, refusalOf };
    });

  it.effect(
    "records the thread as relayed before it launches, on the project the board named",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { env, launched, run } = yield* workerWithRuns();
          const encoded = yield* run(launchCall());
          assert.deepStrictEqual(yield* decodeGatewayCallResult("launchScheduleRun", encoded), {
            pruned: [],
          });
          assert.deepStrictEqual(launched, [{ projectId: WORKER_PROJECT_ID, relayedTo: CENTRAL }]);
          assert.strictEqual(yield* env.relayStore.store.relayedThreadCentral(RUN), CENTRAL);
        }),
      ),
  );

  it.effect("refuses a session that isn't a board's, and a board launching for another", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { launched, refusalOf } = yield* workerWithRuns();
        assert.strictEqual(
          yield* refusalOf(launchCall(), session([AuthOrchestrationOperateScope])),
          "refused",
        );
        assert.strictEqual(
          yield* refusalOf(launchCall(), boardSession("env-other-board")),
          "refused",
        );
        assert.deepStrictEqual(launched, []);
      }),
    ),
  );

  it.effect("waits at the worker's agent cap, launching nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { launched, refusalOf } = yield* workerWithRuns({
          agentCapRefusal: () => "At its cap (2).",
        });
        assert.strictEqual(yield* refusalOf(launchCall()), "refused:agent-cap");
        assert.deepStrictEqual(launched, []);
      }),
    ),
  );

  it.effect(
    "removes the board's old settled runs, keeping the threads of those that touched a card",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { env, removed, run } = yield* workerWithRuns();
          const settled = ThreadId.make("thread-schedule-settled");
          const touched = ThreadId.make("thread-schedule-touched");
          const turning = ThreadId.make("thread-schedule-turning");
          const foreign = ThreadId.make("thread-schedule-other-board");
          const gone = ThreadId.make("thread-schedule-gone");
          yield* Ref.update(env.threads.states, (states) =>
            new Map(states)
              .set(settled, fakeThreadState(settled, { worktreePath: "/home/worker/run-settled" }))
              .set(touched, fakeThreadState(touched, { worktreePath: "/home/worker/run-touched" }))
              .set(turning, aliveThread(turning))
              .set(foreign, fakeThreadState(foreign)),
          );
          for (const threadId of [settled, touched, turning]) {
            yield* env.relayStore.store.recordRelayedThread(threadId, CENTRAL);
          }
          yield* env.relayStore.store.recordRelayedThread(foreign, EnvironmentId.make("env-other"));
          const previous = (threadId: ThreadId, touchedCard = false) => ({
            threadId,
            branch: scheduleRunBranchOf(threadId),
            touchedCard,
          });
          const encoded = yield* run(
            launchCall([
              previous(settled),
              previous(touched, true),
              previous(turning),
              previous(foreign),
              previous(gone),
              // Never a branch that thread's run didn't make.
              {
                threadId: ThreadId.make("thread-schedule-odd"),
                branch: "main",
                touchedCard: false,
              },
              { threadId: gone, branch: "t3o/schedule-run-other", touchedCard: false },
            ]),
          );
          const { pruned } = yield* decodeGatewayCallResult("launchScheduleRun", encoded);
          assert.deepStrictEqual(pruned, [settled, touched, gone]);
          assert.deepStrictEqual(removed, [
            { worktreePath: "/home/worker/run-settled", branch: "t3o/schedule-run-settled" },
            { worktreePath: "/home/worker/run-touched", branch: "t3o/schedule-run-touched" },
            { worktreePath: null, branch: "t3o/schedule-run-gone" },
          ]);
          const deletes = (yield* env.threads.calls).filter(
            (call) => call.type === "thread.delete",
          );
          assert.deepStrictEqual(
            deletes.map((call) => call.threadId),
            [settled],
          );
        }),
      ),
  );

  it.effect("prunes a run on a later pass after its first delete is refused", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let refuse = true;
        const { env, removed, run } = yield* workerWithRuns({ refuseDelete: () => refuse });
        const settled = ThreadId.make("thread-schedule-settled");
        yield* Ref.update(env.threads.states, (states) =>
          new Map(states).set(settled, fakeThreadState(settled)),
        );
        yield* env.relayStore.store.recordRelayedThread(settled, CENTRAL);
        const pruneCall: BoardGatewayCall = {
          _tag: "pruneScheduleRuns",
          input: {
            projectId: WORKER_PROJECT_ID,
            centralEnvironmentId: CENTRAL,
            previousRuns: [
              { threadId: settled, branch: scheduleRunBranchOf(settled), touchedCard: false },
            ],
          },
        };
        const prune = run(pruneCall).pipe(
          Effect.flatMap((encoded) => decodeGatewayCallResult("pruneScheduleRuns", encoded)),
        );
        assert.deepStrictEqual((yield* prune).pruned, []);
        assert.deepStrictEqual(removed, []);
        refuse = false;
        assert.deepStrictEqual((yield* prune).pruned, [settled]);
        assert.strictEqual(removed.length, 1);
      }),
    ),
  );

  it.effect("prunes without launching, only for the board's own runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { env, launched, removed, run, refusalOf } = yield* workerWithRuns();
        const settled = ThreadId.make("thread-schedule-settled");
        yield* Ref.update(env.threads.states, (states) =>
          new Map(states).set(
            settled,
            fakeThreadState(settled, { worktreePath: "/home/worker/run-settled" }),
          ),
        );
        yield* env.relayStore.store.recordRelayedThread(settled, CENTRAL);
        const pruneCall = (centralEnvironmentId: EnvironmentId): BoardGatewayCall => ({
          _tag: "pruneScheduleRuns",
          input: {
            projectId: WORKER_PROJECT_ID,
            centralEnvironmentId,
            previousRuns: [
              { threadId: settled, branch: "t3o/schedule-run-settled", touchedCard: false },
            ],
          },
        });
        assert.strictEqual(
          yield* refusalOf(pruneCall(EnvironmentId.make("env-other-board"))),
          "refused",
        );
        assert.deepStrictEqual(removed, []);
        const encoded = yield* run(pruneCall(CENTRAL));
        const { pruned } = yield* decodeGatewayCallResult("pruneScheduleRuns", encoded);
        assert.deepStrictEqual(pruned, [settled]);
        assert.deepStrictEqual(launched, []);
        assert.deepStrictEqual(removed, [
          { worktreePath: "/home/worker/run-settled", branch: "t3o/schedule-run-settled" },
        ]);
      }),
    ),
  );
});

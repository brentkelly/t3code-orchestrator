/**
 * T3o (T3O-63): the worker side's gateway RPCs and its half of the MCP relay.
 */
import {
  AuthOrchestrationOperateScope,
  CommandId,
  ProjectId,
  type BoardMcpRelayRequest,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { aliveThread } from "../threadGateway.testkit.ts";
import { makeInProcessWorker } from "./distributed.testkit.ts";
import { decodeGatewayCallResult } from "./gatewayWire.ts";
import { makeMcpRelayHost, type McpRelayHostShape } from "./McpRelayHost.ts";
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
        handlers["boardWorker.gateway.call"]({ _tag: "listLiveThreadIds" }).pipe(
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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
    }).pipe(Effect.provide(NodeServices.layer)),
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

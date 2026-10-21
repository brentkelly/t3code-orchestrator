/**
 * T3o (T3O-63): the worker side's gateway RPCs and its half of the MCP relay.
 */
import {
  AuthOrchestrationOperateScope,
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
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { aliveThread } from "../threadGateway.testkit.ts";
import { makeInProcessWorker } from "./distributed.testkit.ts";
import { decodeGatewayCallResult } from "./gatewayWire.ts";
import { makeMcpRelayHost } from "./McpRelayHost.ts";
import { WorkerGatewayHost } from "./WorkerGatewayHost.ts";
import { workerGatewayRpcHandlers } from "./workerGatewayRpc.ts";

const session = (scopes: AuthenticatedSession["scopes"]): AuthenticatedSession => ({
  sessionId: AuthSessionId.make("session-board"),
  subject: "board",
  method: "bearer-access-token",
  scopes,
});

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

it.effect("a relayed call waits for its board's answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* makeMcpRelayHost();
      const requests = yield* relay
        .subscribe(CENTRAL)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* relay.connected.pipe(
        Stream.filter((boards) => boards.has(CENTRAL)),
        Stream.runHead,
      );
      const forwarded = yield* relay.forward(CENTRAL, call).pipe(Effect.forkScoped);
      const [request] = yield* Fiber.join(requests);
      assert.strictEqual(request?.toolName, "board_get_card_context");
      if (request === undefined) return;
      yield* relay.respond({ callId: request.callId, outcome: { _tag: "success", value: 1 } });
      assert.deepStrictEqual(yield* Fiber.join(forwarded), { _tag: "success", value: 1 });
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

it.effect("a call a dropped stream left unanswered goes out again, under the same id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const relay = yield* makeMcpRelayHost();
      const first = yield* relay
        .subscribe(CENTRAL)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped);
      yield* relay.connected.pipe(
        Stream.filter((boards) => boards.has(CENTRAL)),
        Stream.runHead,
      );
      const forwarded = yield* relay.forward(CENTRAL, call).pipe(Effect.forkScoped);
      // The first stream takes the call and ends without answering.
      const [dropped] = yield* Fiber.join(first);
      const [again] = yield* relay.subscribe(CENTRAL).pipe(Stream.take(1), Stream.runCollect);
      assert.strictEqual(again?.callId, dropped?.callId);
      if (again === undefined) return;
      yield* relay.respond({ callId: again.callId, outcome: { _tag: "success", value: 2 } });
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

      yield* relay.subscribe(CENTRAL).pipe(Stream.runDrain, Effect.forkScoped);
      yield* relay.connected.pipe(
        Stream.filter((boards) => boards.has(CENTRAL)),
        Stream.runHead,
      );
      const waiting = yield* relay.forward(CENTRAL, call).pipe(Effect.flip, Effect.forkScoped);
      // Let the call reach its wait before the clock moves past it.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 minute");
      assert.strictEqual((yield* Fiber.join(waiting)).reason, "timed-out");
    }).pipe(Effect.provide(NodeServices.layer)),
  ),
);

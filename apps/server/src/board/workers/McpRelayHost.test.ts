/**
 * T3o (T3O-63): the worker's half of the MCP relay, on its own.
 */
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type BoardMcpRelayOutcome,
  type BoardMcpRelayRequest,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeMcpRelayHost, RETRY_GRACE_TIMEOUTS, type McpRelayCall } from "./McpRelayHost.ts";

const CENTRAL = EnvironmentId.make("env-central");
const TIMEOUT = Duration.seconds(60);

const call = (params: unknown): McpRelayCall => ({
  toolName: "board_create_card",
  params,
  threadId: ThreadId.make("thread-1"),
  providerSessionId: "sess-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  stateDir: "/worker/state",
});

const created: BoardMcpRelayOutcome = { _tag: "success", value: { cardId: "card-1" } };

/** A host with one central server listening; what it is sent lands in `sent`. */
const listening = Effect.gen(function* () {
  const host = yield* makeMcpRelayHost(TIMEOUT);
  const sent = yield* Queue.unbounded<BoardMcpRelayRequest>();
  yield* host.subscribe(CENTRAL).pipe(
    Stream.runForEach((request) => Queue.offer(sent, request)),
    Effect.forkScoped,
  );
  yield* host.connected.pipe(
    Stream.filter((boards) => boards.has(CENTRAL)),
    Stream.runHead,
  );
  return { host, sent };
});

describe("McpRelayHost", () => {
  it.effect("an agent's retry after a timeout rejoins the call instead of sending it again", () =>
    Effect.gen(function* () {
      const { host, sent } = yield* listening;

      const first = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Follow-up" })));
      const request = yield* Queue.take(sent);
      yield* TestClock.adjust(TIMEOUT);
      const error = yield* Effect.flip(Fiber.join(first));
      assert.strictEqual(error.reason, "timed-out");

      // The board answers the first call late; the agent retries meanwhile.
      const retry = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Follow-up" })));
      yield* host.respond({ callId: request.callId, outcome: created });
      assert.deepStrictEqual(yield* Fiber.join(retry), created);
      assert.isTrue(Option.isNone(yield* Queue.poll(sent)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a retry that comes a full timeout later still rejoins the call", () =>
    Effect.gen(function* () {
      const { host, sent } = yield* listening;

      const first = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Follow-up" })));
      const request = yield* Queue.take(sent);
      yield* TestClock.adjust(TIMEOUT);
      yield* Effect.flip(Fiber.join(first));

      // The agent was told to retry in a minute, and takes a little longer.
      yield* TestClock.adjust(Duration.sum(TIMEOUT, Duration.seconds(5)));
      const retry = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Follow-up" })));
      yield* host.respond({ callId: request.callId, outcome: created });
      assert.deepStrictEqual(yield* Fiber.join(retry), created);
      assert.isTrue(Option.isNone(yield* Queue.poll(sent)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a timed-out call nobody retries is dropped after its grace period", () =>
    Effect.gen(function* () {
      const { host, sent } = yield* listening;

      const first = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Abandoned" })));
      yield* Queue.take(sent);
      yield* TestClock.adjust(TIMEOUT);
      yield* Effect.flip(Fiber.join(first));
      yield* TestClock.adjust(Duration.times(TIMEOUT, RETRY_GRACE_TIMEOUTS));

      // A board that connects now is sent only what is still waiting.
      const later = yield* Queue.unbounded<BoardMcpRelayRequest>();
      yield* host.subscribe(CENTRAL).pipe(
        Stream.runForEach((request) => Queue.offer(later, request)),
        Effect.forkScoped,
      );
      const other = yield* Effect.forkChild(
        host.forward(CENTRAL, { ...call({ title: "Next" }), threadId: ThreadId.make("thread-2") }),
      );
      const delivered = yield* Queue.take(later);
      assert.deepStrictEqual(delivered.params, { title: "Next" });
      yield* host.respond({ callId: delivered.callId, outcome: created });
      yield* Fiber.join(other);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("a different call after a timeout is sent as a new call", () =>
    Effect.gen(function* () {
      const { host, sent } = yield* listening;

      const first = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "One" })));
      const firstRequest = yield* Queue.take(sent);
      yield* TestClock.adjust(TIMEOUT);
      yield* Effect.flip(Fiber.join(first));

      const other = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Two" })));
      const otherRequest = yield* Queue.take(sent);
      assert.notStrictEqual(otherRequest.callId, firstRequest.callId);
      yield* host.respond({ callId: otherRequest.callId, outcome: created });
      assert.deepStrictEqual(yield* Fiber.join(other), created);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

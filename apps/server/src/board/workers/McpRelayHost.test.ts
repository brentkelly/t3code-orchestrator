/**
 * T3o (T3O-63): the worker's half of the MCP relay, on its own.
 */
import {
  AuthSessionId,
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
const SESSION = AuthSessionId.make("session-board");

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
  yield* host.subscribe(CENTRAL, SESSION).pipe(
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
      yield* host.respond({ callId: request.callId, outcome: created }, SESSION);
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
      yield* host.respond({ callId: request.callId, outcome: created }, SESSION);
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
      yield* host.subscribe(CENTRAL, SESSION).pipe(
        Stream.runForEach((request) => Queue.offer(later, request)),
        Effect.forkScoped,
      );
      const other = yield* Effect.forkChild(
        host.forward(CENTRAL, { ...call({ title: "Next" }), threadId: ThreadId.make("thread-2") }),
      );
      const delivered = yield* Queue.take(later);
      assert.deepStrictEqual(delivered.params, { title: "Next" });
      yield* host.respond({ callId: delivered.callId, outcome: created }, SESSION);
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
      yield* host.respond({ callId: otherRequest.callId, outcome: created }, SESSION);
      assert.deepStrictEqual(yield* Fiber.join(other), created);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("McpRelayHost, parallel timeouts on one thread", () => {
  it.effect("each of two timed-out calls is rejoined by its own retry", () =>
    Effect.gen(function* () {
      const { host, sent } = yield* listening;

      const one = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "One" })));
      const two = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Two" })));
      const first = yield* Queue.take(sent);
      const second = yield* Queue.take(sent);
      yield* TestClock.adjust(TIMEOUT);
      yield* Effect.flip(Fiber.join(one));
      yield* Effect.flip(Fiber.join(two));

      const retryOne = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "One" })));
      const retryTwo = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Two" })));
      const answer = (title: string): BoardMcpRelayOutcome => ({ _tag: "success", value: title });
      for (const request of [first, second]) {
        const { title } = request.params as { readonly title: string };
        yield* host.respond({ callId: request.callId, outcome: answer(title) }, SESSION);
      }
      assert.deepStrictEqual(yield* Fiber.join(retryOne), answer("One"));
      assert.deepStrictEqual(yield* Fiber.join(retryTwo), answer("Two"));
      // Neither retry was sent as a call of its own.
      assert.isTrue(Option.isNone(yield* Queue.poll(sent)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("both of two timed-out calls nobody retries are dropped after their grace", () =>
    Effect.gen(function* () {
      const { host, sent } = yield* listening;

      const one = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "One" })));
      const two = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Two" })));
      yield* Queue.take(sent);
      yield* Queue.take(sent);
      yield* TestClock.adjust(TIMEOUT);
      yield* Effect.flip(Fiber.join(one));
      yield* Effect.flip(Fiber.join(two));
      yield* TestClock.adjust(Duration.times(TIMEOUT, RETRY_GRACE_TIMEOUTS));

      // A stream opened now is sent nothing left over, only the next call.
      const later = yield* Queue.unbounded<BoardMcpRelayRequest>();
      yield* host.subscribe(CENTRAL, SESSION).pipe(
        Stream.runForEach((request) => Queue.offer(later, request)),
        Effect.forkScoped,
      );
      const next = yield* Effect.forkChild(
        host.forward(CENTRAL, { ...call({ title: "Next" }), threadId: ThreadId.make("thread-2") }),
      );
      const delivered = yield* Queue.take(later);
      assert.deepStrictEqual(delivered.params, { title: "Next" });
      yield* host.respond({ callId: delivered.callId, outcome: created }, SESSION);
      yield* Fiber.join(next);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("McpRelayHost, a board's session", () => {
  const REPLACEMENT = AuthSessionId.make("session-repaired");

  it.effect("a board passes to a new session only once the one holding it is gone", () =>
    Effect.gen(function* () {
      const revoked = new Set<AuthSessionId>();
      const host = yield* makeMcpRelayHost(TIMEOUT, (session) =>
        Effect.succeed(!revoked.has(session)),
      );
      const sent = yield* Queue.unbounded<BoardMcpRelayRequest>();
      const holding = yield* host.subscribe(CENTRAL, SESSION).pipe(
        Stream.runForEach((request) => Queue.offer(sent, request)),
        Effect.forkScoped,
      );
      yield* host.connected.pipe(
        Stream.filter((boards) => boards.has(CENTRAL)),
        Stream.runHead,
      );
      const forwarded = yield* Effect.forkChild(host.forward(CENTRAL, call({ title: "Kept" })));
      const request = yield* Queue.take(sent);

      // Held: another session can neither take the board nor answer its call.
      const refused = yield* Effect.flip(
        host.subscribe(CENTRAL, REPLACEMENT).pipe(Stream.runDrain),
      );
      assert.strictEqual(refused._tag, "McpRelayRefused");
      const forged = yield* Effect.flip(
        host.respond({ callId: request.callId, outcome: created }, REPLACEMENT),
      );
      assert.strictEqual(forged._tag, "McpRelayRefused");

      // Revoked (a re-pair): the replacement takes the board, the old stream
      // ends, and the call still waiting goes to the replacement.
      revoked.add(SESSION);
      const replaced = yield* Queue.unbounded<BoardMcpRelayRequest>();
      yield* host.subscribe(CENTRAL, REPLACEMENT).pipe(
        Stream.runForEach((next) => Queue.offer(replaced, next)),
        Effect.forkScoped,
      );
      const again = yield* Queue.take(replaced);
      assert.strictEqual(again.callId, request.callId);
      yield* Fiber.join(holding);
      yield* host.respond({ callId: again.callId, outcome: created }, REPLACEMENT);
      assert.deepStrictEqual(yield* Fiber.join(forwarded), created);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

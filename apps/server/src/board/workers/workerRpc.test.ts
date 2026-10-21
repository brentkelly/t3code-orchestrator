import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  BOARD_WORKER_PROTOCOL_VERSION,
  EnvironmentId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import { EnvironmentAuth, type AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { boardWorkerRpcHandlers } from "./workerRpc.ts";

const session = (scopes: AuthenticatedSession["scopes"]): AuthenticatedSession => ({
  sessionId: AuthSessionId.make("session-board"),
  subject: "board",
  method: "bearer-access-token",
  scopes,
});

const revoked: Array<string> = [];

const layer = Layer.mergeAll(
  Layer.succeed(ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("env-worker")),
    getDescriptor: Effect.die("unused"),
  }),
  Layer.mock(EnvironmentAuth)({
    revokeSession: (sessionId) =>
      Effect.sync(() => {
        revoked.push(sessionId);
        return true;
      }),
  }),
);

it.effect("answers the board's handshake with its protocol and environment", () =>
  Effect.gen(function* () {
    const handlers = yield* boardWorkerRpcHandlers(session([AuthOrchestrationReadScope]));
    const hello = yield* handlers["boardWorker.hello"]({});
    assert.strictEqual(hello.protocolVersion, BOARD_WORKER_PROTOCOL_VERSION);
    assert.strictEqual(hello.environmentId, "env-worker");
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a session without the read scope", () =>
  Effect.gen(function* () {
    const handlers = yield* boardWorkerRpcHandlers(session([]));
    const failure = yield* Effect.flip(handlers["boardWorker.hello"]({}));
    assert.strictEqual(failure._tag, "EnvironmentAuthorizationError");
  }).pipe(Effect.provide(layer)),
);

it.effect("release revokes the calling session itself, after answering", () =>
  Effect.gen(function* () {
    revoked.length = 0;
    const handlers = yield* boardWorkerRpcHandlers(session([AuthOrchestrationReadScope]));
    yield* handlers["boardWorker.release"]({});
    assert.deepStrictEqual(revoked, []);
    yield* TestClock.adjust("250 millis");
    assert.deepStrictEqual(revoked, ["session-board"]);
  }).pipe(Effect.provide(layer)),
);

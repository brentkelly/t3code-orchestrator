import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  BOARD_WORKER_PROTOCOL_VERSION,
  EnvironmentId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
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
const issued: Array<unknown> = [];

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
    listSessions: () =>
      Effect.succeed([
        {
          sessionId: AuthSessionId.make("session-board"),
          client: { label: "T3o board (central)", deviceType: "bot" },
        },
      ] as never),
    issueSession: (input) =>
      Effect.sync(() => {
        issued.push(input);
        return { token: "token-successor" } as never;
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

it.effect("renew issues a successor with the caller's own subject, scopes and label", () =>
  Effect.gen(function* () {
    issued.length = 0;
    revoked.length = 0;
    const handlers = yield* boardWorkerRpcHandlers(session([AuthOrchestrationReadScope]));
    const renewal = yield* handlers["boardWorker.renew"]({});
    assert.strictEqual(renewal.accessToken, "token-successor");
    assert.deepStrictEqual(issued, [
      { subject: "board", scopes: [AuthOrchestrationReadScope], label: "T3o board (central)" },
    ]);
    // The old session stays valid until the caller gives it back.
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(revoked, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("hello reports when the calling session expires", () =>
  Effect.gen(function* () {
    const handlers = yield* boardWorkerRpcHandlers({
      ...session([AuthOrchestrationReadScope]),
      expiresAt: DateTime.makeUnsafe("2026-11-20T10:00:00.000Z"),
    });
    const hello = yield* handlers["boardWorker.hello"]({});
    assert.strictEqual(hello.sessionExpiresAt, "2026-11-20T10:00:00.000Z");
  }).pipe(Effect.provide(layer)),
);

it.effect("renew refuses a browser cookie, a DPoP-bound or a non-board session", () =>
  Effect.gen(function* () {
    issued.length = 0;
    const callers: Array<AuthenticatedSession> = [
      { ...session([AuthOrchestrationReadScope]), method: "browser-session-cookie" },
      {
        ...session([AuthOrchestrationReadScope]),
        method: "dpop-access-token",
        proofKeyThumbprint: "thumbprint",
      },
      { ...session([AuthOrchestrationReadScope]), sessionId: AuthSessionId.make("session-cli") },
    ];
    for (const caller of callers) {
      const handlers = yield* boardWorkerRpcHandlers(caller);
      const failure = yield* Effect.flip(handlers["boardWorker.renew"]({}));
      assert.strictEqual(failure._tag, "BoardWorkerRequestError");
    }
    assert.deepStrictEqual(issued, []);
  }).pipe(Effect.provide(layer)),
);

import {
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  BOARD_WORKER_PROTOCOL_VERSION,
  EnvironmentId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import { EnvironmentAuth, type AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import {
  boardWorkerRpcHandlers,
  issueBoardSession,
  reconcileBoardUserSessions,
} from "./workerRpc.ts";

const session = (scopes: AuthenticatedSession["scopes"]): AuthenticatedSession => ({
  sessionId: AuthSessionId.make("session-board"),
  subject: "t3o-board:env-board",
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
          subject: "t3o-board:env-board",
          client: { label: "T3o board (central)", deviceType: "bot" },
        },
        {
          sessionId: AuthSessionId.make("session-user-1"),
          subject: "t3o-board-user:env-board:board-session-1",
          client: { label: "Chrome via T3o board (central)", deviceType: "bot" },
        },
        {
          sessionId: AuthSessionId.make("session-user-9-old"),
          subject: "t3o-board-user:env-board:board-session-9",
          issuedAt: DateTime.makeUnsafe("2026-11-12T08:00:00.000Z"),
          client: { label: "Chrome via T3o board (central)", deviceType: "bot" },
        },
        {
          sessionId: AuthSessionId.make("session-user-9-new"),
          subject: "t3o-board-user:env-board:board-session-9",
          issuedAt: DateTime.makeUnsafe("2026-11-12T09:00:00.000Z"),
          client: { label: "Chrome via T3o board (central)", deviceType: "bot" },
        },
        {
          sessionId: AuthSessionId.make("session-user-2"),
          subject: "t3o-board-user:env-board:board-session-2",
          client: { label: "Phone via T3o board (central)", deviceType: "bot" },
        },
        {
          sessionId: AuthSessionId.make("session-other-board"),
          subject: "t3o-board:env-elsewhere",
          client: { label: "T3o board (elsewhere)", deviceType: "bot" },
        },
        {
          sessionId: AuthSessionId.make("session-laptop"),
          subject: "one-time-token",
          client: { label: "Laptop", deviceType: "desktop" },
        },
      ] as never),
    issueSession: (input) =>
      Effect.sync(() => {
        issued.push(input);
        return {
          token: "token-successor",
          scopes: input?.scopes ?? [],
          expiresAt: DateTime.makeUnsafe("2026-11-13T10:00:00.000Z"),
        } as never;
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

it.effect("release revokes only the calling session, so a renewal keeps its successor", () =>
  Effect.gen(function* () {
    revoked.length = 0;
    const handlers = yield* boardWorkerRpcHandlers(session([AuthOrchestrationReadScope]));
    yield* handlers["boardWorker.release"]({});
    assert.deepStrictEqual(revoked, []);
    yield* TestClock.adjust("250 millis");
    assert.deepStrictEqual(revoked, ["session-board"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("release all revokes every session of the calling board, after answering", () =>
  Effect.gen(function* () {
    revoked.length = 0;
    const handlers = yield* boardWorkerRpcHandlers(session([AuthOrchestrationReadScope]));
    yield* handlers["boardWorker.release"]({ all: true });
    assert.deepStrictEqual(revoked, []);
    yield* TestClock.adjust("250 millis");
    // Its own and its users', never another board's or this machine's own clients.
    assert.deepStrictEqual(revoked, [
      "session-board",
      "session-user-1",
      "session-user-9-old",
      "session-user-9-new",
      "session-user-2",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("mints a board user's session: the board's subject, never wider than the board", () =>
  Effect.gen(function* () {
    issued.length = 0;
    revoked.length = 0;
    const handlers = yield* boardWorkerRpcHandlers(
      session([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
    );
    const minted = yield* handlers["boardWorker.mintUserSession"]({
      boardSessionId: "board-session-9",
      scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope, AuthFilesystemWriteScope],
      label: "Chrome via T3o board (central)",
    });
    assert.strictEqual(minted.bearerToken, "token-successor");
    assert.strictEqual(minted.expiresAt, "2026-11-13T10:00:00.000Z");
    const [input] = issued as Array<{
      readonly subject: string;
      readonly scopes: ReadonlyArray<string>;
      readonly ttl: Duration.Duration;
    }>;
    assert.strictEqual(input?.subject, "t3o-board-user:env-board:board-session-9");
    assert.deepStrictEqual(input?.scopes, [
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
    ]);
    assert.strictEqual(Duration.toHours(input!.ttl), 24);
    // A re-mint keeps only the newest earlier session for that board user.
    assert.deepStrictEqual(revoked, ["session-user-9-old"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("revokes only the named board sessions' worker sessions", () =>
  Effect.gen(function* () {
    revoked.length = 0;
    const handlers = yield* boardWorkerRpcHandlers(session([AuthOrchestrationReadScope]));
    const result = yield* handlers["boardWorker.revokeUserSessions"]({
      boardSessionIds: ["board-session-2"],
    });
    assert.strictEqual(result.revoked, 1);
    assert.deepStrictEqual(revoked, ["session-user-2"]);
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
      {
        subject: "t3o-board:env-board",
        scopes: [AuthOrchestrationReadScope],
        label: "T3o board (central)",
      },
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
      {
        ...session([AuthOrchestrationReadScope]),
        sessionId: AuthSessionId.make("session-laptop"),
        subject: "one-time-token",
      },
    ];
    for (const caller of callers) {
      const handlers = yield* boardWorkerRpcHandlers(caller);
      const failure = yield* Effect.flip(handlers["boardWorker.renew"]({}));
      assert.strictEqual(failure._tag, "BoardWorkerRequestError");
    }
    assert.deepStrictEqual(issued, []);
  }).pipe(Effect.provide(layer)),
);

it.effect("a tunnel handshake revokes user sessions whose board session is gone", () =>
  Effect.gen(function* () {
    revoked.length = 0;
    const auth = yield* EnvironmentAuth;
    const count = yield* reconcileBoardUserSessions(auth, "env-board", [
      "board-session-1",
      "board-session-9",
    ]);
    // Only this board's users, only the dead one; never the board's own session.
    assert.strictEqual(count, 1);
    assert.deepStrictEqual(revoked, ["session-user-2"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("issuing the board's session revokes the one it held before, and nothing else", () =>
  Effect.gen(function* () {
    revoked.length = 0;
    issued.length = 0;
    const auth = yield* EnvironmentAuth;
    yield* issueBoardSession(auth, "env-board", "T3o board (central)");
    assert.deepStrictEqual(revoked, ["session-board"]);
    assert.deepStrictEqual(issued, [
      { subject: "t3o-board:env-board", label: "T3o board (central)" },
    ]);
  }).pipe(Effect.provide(layer)),
);

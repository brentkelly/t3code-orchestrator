import {
  BOARD_WORKER_GATEWAY_WS_METHODS,
  BOARD_WORKER_GIT_CALL_WS_METHODS,
  BOARD_WORKER_WS_METHODS,
  BOARD_WORKERS_WS_METHODS,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { BOARD_ONLY_METHODS, boardSubjectRefusal, guardBoardHandlers } from "./boardSubjectGuard.ts";

const BOARD = "t3o-board:env-board";
const USER = "t3o-board-user:env-board:session-1";
const PLAIN = "one-time-token";

it("every board-only method refuses a board user's session and a plain one", () => {
  const methods = [
    ...Object.values(BOARD_WORKER_WS_METHODS),
    ...Object.values(BOARD_WORKER_GATEWAY_WS_METHODS),
    ...Object.values(BOARD_WORKER_GIT_CALL_WS_METHODS),
  ];
  assert.deepStrictEqual([...BOARD_ONLY_METHODS].toSorted(), methods.toSorted());
  for (const method of methods) {
    assert.isNull(boardSubjectRefusal(method, BOARD), method);
    assert.isNotNull(boardSubjectRefusal(method, USER), method);
    assert.isNotNull(boardSubjectRefusal(method, PLAIN), method);
    assert.isNotNull(boardSubjectRefusal(method, "t3o-board:"), method);
  }
});

it("a worker's board sessions can't manage that worker's own board", () => {
  for (const method of [BOARD_WORKERS_WS_METHODS.createJoinCode, "board.dispatchCommand"]) {
    assert.isNotNull(boardSubjectRefusal(method, BOARD), method);
    assert.isNotNull(boardSubjectRefusal(method, USER), method);
    assert.isNull(boardSubjectRefusal(method, PLAIN), method);
  }
});

it.effect("wraps a handler record, failing refused calls and streams with an authorization error", () =>
  Effect.gen(function* () {
    const handlers = guardBoardHandlers(USER, {
      [BOARD_WORKER_WS_METHODS.hello]: () => Effect.succeed("hello"),
      [BOARD_WORKER_GATEWAY_WS_METHODS.subscribeSignals]: () => Stream.make(1),
      "orchestration.getSnapshot": () => Effect.succeed("ok"),
    });
    const hello = yield* Effect.flip(
      (handlers[BOARD_WORKER_WS_METHODS.hello] as () => Effect.Effect<string, { _tag: string }>)(),
    );
    assert.strictEqual(hello._tag, "EnvironmentAuthorizationError");
    const signals = yield* Stream.runCollect(
      (
        handlers[BOARD_WORKER_GATEWAY_WS_METHODS.subscribeSignals] as () => Stream.Stream<
          number,
          { _tag: string }
        >
      )(),
    ).pipe(Effect.flip);
    assert.strictEqual(signals._tag, "EnvironmentAuthorizationError");
    const own = handlers["orchestration.getSnapshot"] as () => Effect.Effect<string>;
    assert.strictEqual(yield* own(), "ok");
  }),
);

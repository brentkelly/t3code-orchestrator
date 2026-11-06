import { BOARD_LOCAL_WORKER_ID, CommandId, EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { BoardEngine } from "../BoardEngine.ts";
import { BoardQueries } from "../BoardQueries.ts";
import { makeBoardStackTestLayer } from "../boardStack.testkit.ts";

const NOW = "2026-10-21T10:00:00.000Z";

it.layer(makeBoardStackTestLayer("t3o-board-workers-projection-"))(
  "board worker registry projection",
  (it) => {
    it.effect("rehydrates the registry and default from the tables exactly as replayed", () =>
      Effect.gen(function* () {
        const engine = yield* BoardEngine;
        const queries = yield* BoardQueries;
        yield* engine.dispatch({
          type: "board.worker.register",
          commandId: CommandId.make("cmd-register-a"),
          mode: "add",
          worker: {
            id: EnvironmentId.make("env-a"),
            label: "linux-box",
            url: "http://linux-box:3773",
            addedAt: NOW,
          },
          createdAt: NOW,
        });
        yield* engine.dispatch({
          type: "board.worker.register",
          commandId: CommandId.make("cmd-register-b"),
          mode: "add",
          worker: {
            id: EnvironmentId.make("env-b"),
            label: "gpu-rig",
            url: "http://gpu-rig:3773",
            addedAt: NOW,
          },
          createdAt: NOW,
        });
        yield* engine.dispatch({
          type: "board.worker.set-default",
          commandId: CommandId.make("cmd-default-a"),
          workerId: EnvironmentId.make("env-a"),
          createdAt: NOW,
        });
        yield* engine.dispatch({
          type: "board.worker.remove",
          commandId: CommandId.make("cmd-remove-b"),
          workerId: EnvironmentId.make("env-b"),
          createdAt: NOW,
        });

        const replayed = (yield* engine.getReadModel).board;
        const rehydrated = yield* queries.loadBoardState();
        // A board with only workers is not an unused board: it rehydrates.
        assert.isNotNull(rehydrated);
        assert.deepStrictEqual(rehydrated?.workers, replayed?.workers);
        assert.strictEqual(rehydrated?.defaultWorkerId, "env-a");

        yield* engine.dispatch({
          type: "board.worker.set-default",
          commandId: CommandId.make("cmd-default-local"),
          workerId: BOARD_LOCAL_WORKER_ID,
          createdAt: NOW,
        });
        assert.isUndefined((yield* queries.loadBoardState())?.defaultWorkerId);
      }),
    );
  },
);

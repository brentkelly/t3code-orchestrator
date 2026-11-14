/** Removing the default worker through the real seams: decider, event store, SQL projection
    and the rehydrated read model. */
import { CommandId, EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  boardStackEngine,
  boardStackSnapshotQuery,
  makeBoardStackTestLayer,
} from "./boardStack.testkit.ts";

const at = "2026-01-01T00:00:00.000Z";
const workerId = EnvironmentId.make("env-worker-a");

it.layer(makeBoardStackTestLayer("t3o-board-worker-removal-"))("removing a worker", (it) => {
  it.effect("that was the default leaves this server as the default", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      yield* engine.dispatch({
        type: "board.worker.register",
        commandId: CommandId.make("cmd-add"),
        mode: "add",
        worker: { id: workerId, label: "worker-a", url: "http://worker-a:3773", addedAt: at },
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.worker.set-default",
        commandId: CommandId.make("cmd-default"),
        workerId,
        createdAt: at,
      });
      yield* engine.dispatch({
        type: "board.worker.remove",
        commandId: CommandId.make("cmd-remove"),
        workerId,
        createdAt: at,
      });
      const model = yield* (yield* boardStackSnapshotQuery).getCommandReadModel();
      assert.isUndefined(model.board?.defaultWorkerId);
    }),
  );
});

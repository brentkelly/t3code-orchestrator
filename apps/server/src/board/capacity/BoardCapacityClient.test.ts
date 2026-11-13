import { EnvironmentId, type BoardSyncedCard } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { WorkerConnections } from "../workers/WorkerConnections.ts";
import { BoardCapacityClient, BoardCapacityClientLive } from "./BoardCapacityClient.ts";
import { BoardWorkerCapacity } from "./BoardWorkerCapacity.ts";

const W1 = EnvironmentId.make("worker-1");
const listed = (cardId: string) => ({ cardId }) as unknown as BoardSyncedCard;

const layer = (answers: { hang: boolean }) =>
  BoardCapacityClientLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeSqliteClient.layer({ filename: ":memory:" }),
        Layer.succeed(BoardWorkerCapacity, {
          subscribe: () => Stream.never,
        } as never),
        Layer.succeed(ServerEnvironment, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("env-board")),
        } as never),
        Layer.succeed(WorkerConnections, {
          states: Stream.never,
          get: () =>
            Effect.succeed({
              gateway: {
                syncCards: () => (answers.hang ? Effect.never : Effect.void),
              },
            }),
        } as never),
      ),
    ),
  );

it.effect("a sync the worker leaves unanswered reports false, even after an earlier one landed", () => {
  const answers = { hang: false };
  return Effect.gen(function* () {
    const client = yield* BoardCapacityClient;
    assert.isTrue(yield* client.syncCards(W1, []));
    answers.hang = true;
    const pending = yield* client.syncCards(W1, [listed("a")]).pipe(Effect.forkChild);
    yield* TestClock.adjust("5 seconds");
    assert.isFalse(yield* Fiber.join(pending));
    // The worker still holds the earlier sync's baseline.
    assert.isTrue(yield* client.synced(W1));
  }).pipe(Effect.provide(layer(answers)));
});

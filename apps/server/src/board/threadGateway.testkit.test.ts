/**
 * The in-memory gateway fake must keep `observe`'s contract, or harness suites
 * pass against a stream the real gateway never produces (T3O-58).
 */
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeFakeThreadGateway } from "./threadGateway.testkit.ts";

describe("fake ThreadGateway observe", () => {
  it.effect("delivers every signal to every subscription, including late ones", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeThreadGateway();
      const first = ThreadId.make("thread-a");
      const second = ThreadId.make("thread-b");
      yield* fake.emit({ type: "session-started", threadId: first });
      yield* fake.emit({ type: "session-started", threadId: second });

      const read = fake.gateway.observe.pipe(Stream.take(2), Stream.runCollect);
      const [one, two] = yield* Effect.all([read, read], { concurrency: 2 });
      assert.deepStrictEqual(
        [...one].map((signal) => signal.threadId),
        [first, second],
      );
      assert.deepStrictEqual(
        [...two].map((signal) => signal.threadId),
        [first, second],
      );
    }),
  );
});

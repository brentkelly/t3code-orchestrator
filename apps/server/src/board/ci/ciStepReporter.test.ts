/**
 * A running CI step's live reports (T3O-60), on the TestClock: progress is
 * throttled to one report per 10 s and only on a change, and silence is
 * flagged after 10 min and cleared by output.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { makeBoardCiStepReporter, type BoardCiStepLive } from "./ciStepReporter.ts";

const progressLine = (done: number, total: number, message = "Running tests") =>
  `::t3o-progress::${JSON.stringify({ message, done, total })}`;

const start = Effect.gen(function* () {
  const reports: BoardCiStepLive[] = [];
  const reporter = yield* makeBoardCiStepReporter((live) =>
    Effect.sync(() => {
      reports.push(live);
    }),
  );
  return { reports, reporter };
});

it.effect("reports progress at once, then at most every 10 s and only when it changed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { reports, reporter } = yield* start;
      yield* reporter.line("plain output");
      assert.lengthOf(reports, 0);

      yield* reporter.line(progressLine(1, 300));
      assert.lengthOf(reports, 1);
      assert.deepInclude(reports[0]!.progress, { message: "Running tests", done: 1, total: 300 });

      // 1/300 → 2/300 is still 0 %.
      yield* reporter.line(progressLine(2, 300));
      yield* TestClock.adjust("20 seconds");
      assert.lengthOf(reports, 1, "a change under 1 % is not a report");

      // A real change waits out the window, then the ticker flushes it.
      yield* reporter.line(progressLine(150, 300));
      assert.lengthOf(reports, 2, "the window had passed, so it reports at once");
      yield* reporter.line(progressLine(225, 300));
      assert.lengthOf(reports, 2);
      yield* TestClock.adjust("9 seconds");
      assert.lengthOf(reports, 2);
      yield* TestClock.adjust("1 second");
      assert.lengthOf(reports, 3);
      assert.strictEqual(reports[2]!.progress?.done, 225);

      // A new message with the same fraction is a change.
      yield* TestClock.adjust("10 seconds");
      yield* reporter.line(progressLine(225, 300, "Linting"));
      assert.lengthOf(reports, 4);
      assert.strictEqual(reporter.progress()?.message, "Linting");
    }),
  ),
);

it.effect("keeps the latest progress even when it was never reported", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { reports, reporter } = yield* start;
      yield* reporter.line(progressLine(1, 10));
      yield* reporter.line(progressLine(9, 10));
      assert.lengthOf(reports, 1);
      // The step's settled row takes this, so a failure shows where it stopped.
      assert.strictEqual(reporter.progress()?.done, 9);
    }),
  ),
);

it.effect("flags a step silent after 10 min without output, and clears it on output", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { reports, reporter } = yield* start;
      yield* TestClock.adjust("2 minutes");
      yield* reporter.output;
      assert.lengthOf(reports, 0, "output while not silent reports nothing");

      yield* TestClock.adjust("9 minutes");
      assert.lengthOf(reports, 0);
      yield* TestClock.adjust("1 minute");
      assert.lengthOf(reports, 1);
      // Silent since the last output, two minutes in.
      assert.strictEqual(reports[0]!.silentSince, new Date(2 * 60_000).toISOString());

      yield* TestClock.adjust("5 minutes");
      assert.lengthOf(reports, 1, "it is set once");

      yield* reporter.output;
      assert.lengthOf(reports, 2);
      assert.isUndefined(reports[1]!.silentSince);
    }),
  ),
);

it.effect("stops reporting once its scope closes", () =>
  Effect.gen(function* () {
    const reports: BoardCiStepLive[] = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const reporter = yield* makeBoardCiStepReporter((live) =>
          Effect.sync(() => {
            reports.push(live);
          }),
        );
        yield* reporter.line(progressLine(1, 10));
        yield* reporter.line(progressLine(5, 10));
      }),
    );
    yield* TestClock.adjust("30 minutes");
    assert.lengthOf(reports, 1);
  }),
);

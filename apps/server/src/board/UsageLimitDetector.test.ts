/**
 * The usage-limit detection seam (T3O-22, D17; T3O-59).
 *
 * Since orchestration-v2 the provider adapters classify a failure themselves,
 * so the seam's whole job is reading that classification off the thread: a
 * latest run that failed on a usage limit is a `wait`, carrying the provider's
 * reset time plus the retry margin, and anything else is no match at all.
 */
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadGateway, type BoardThreadUsageLimit } from "./ThreadGateway.ts";
import { fakeThreadState, inertThreadGateway } from "./threadGateway.testkit.ts";
import { UsageLimitDetector, UsageLimitDetectorLive } from "./UsageLimitDetector.ts";

const threadId = ThreadId.make("thread-1");
const NOW = Date.parse("2026-07-19T12:00:00.000Z");

const classify = (
  usageLimit: BoardThreadUsageLimit | null,
  options: { readonly gone?: boolean } = {},
) =>
  Effect.gen(function* () {
    const detector = yield* UsageLimitDetector;
    return yield* detector.classifyTurn({
      threadId,
      turnErrorMessage: null,
      nowMs: NOW,
      since: null,
    });
  }).pipe(
    Effect.provide(
      UsageLimitDetectorLive.pipe(
        Layer.provide(
          Layer.succeed(
            ThreadGateway,
            inertThreadGateway({
              threadState: () =>
                options.gone === true
                  ? Effect.succeed(null)
                  : Effect.succeed(
                      fakeThreadState("thread-1", { sessionStatus: "error", usageLimit }),
                    ),
            }),
          ),
        ),
      ),
    ),
  );

it.effect(
  "a run that failed on a usage limit is a strict wait until the reset, plus the margin",
  () =>
    Effect.gen(function* () {
      const match = yield* classify({
        resetAt: "2026-07-19T15:00:00.000Z",
        message: "You've hit your usage limit.",
        resumeArmed: false,
      });
      assert.deepStrictEqual(match, {
        kind: "wait",
        confidence: "strict",
        resumeAt: "2026-07-19T15:01:00.000Z",
        reason: "You've hit your usage limit.",
        ruleId: "orchestration-v2-usage-limit",
      });
    }),
);

it.effect("a limit with no reset time still parks the card, on the board's own blind poll", () =>
  Effect.gen(function* () {
    const match = yield* classify({ resetAt: null, message: "  ", resumeArmed: false });
    assert.strictEqual(match?.resumeAt, null);
    assert.strictEqual(match?.reason, "The provider's usage limit was reached.");
  }),
);

it.effect("any other ending is no match", () =>
  Effect.gen(function* () {
    assert.isNull(yield* classify(null));
    assert.isNull(yield* classify(null, { gone: true }));
  }),
);

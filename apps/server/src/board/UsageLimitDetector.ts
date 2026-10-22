/**
 * T3o usage-limit detection seam (T3O-22, D17; T3O-59).
 *
 * Since orchestration-v2 the provider adapters classify a failure themselves:
 * a run that hit a usage limit fails with `class: "usage_limit"` and, when the
 * provider said, the reset time. Detection is reading that off the thread —
 * the board's own catalogue of provider refusal sentences is no longer
 * consulted.
 *
 * Still a service rather than a function on the reactor: reactor tests provide
 * a STUB that returns a fixed verdict, so the behavioural suite drives `wait` /
 * `exhausted` / `slow-down` / null directly and tests the supervisor, which is
 * what they are for.
 */
import type { BoardUsageLimitMatch, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ThreadGateway, UNKNOWN_THREAD_STATE } from "./ThreadGateway.ts";

/** Added to a provider's reset time before anything is retried against it,
    as the catalogue's matches always carried (D5). */
const RESUME_MARGIN_MS = 60_000;

export interface UsageLimitDetectorShape {
  /**
   * Classify a turn that has just ended: a `wait` when the thread's latest run
   * failed on a usage limit, otherwise `null`. `turnErrorMessage`, `nowMs`
   * and `since` are what the text catalogue needed; the v2 failure class needs
   * none of them, and they stay so the stubbed suites keep their shape.
   */
  readonly classifyTurn: (input: {
    readonly threadId: ThreadId;
    /** The turn's own error text, when the adapter reported one. */
    readonly turnErrorMessage: string | null;
    /** The instant to measure a relative or bare-clock reset time against. */
    readonly nowMs: number;
    /** Only a message the agent wrote SINCE this instant counts, for the same
        reason `endedWithQuestion` bounds its read: a turn that ends having said
        nothing leaves an older message newest, and re-reading it would park the
        card on a limit that has already passed. Null means no bound. */
    readonly since: string | null;
  }) => Effect.Effect<BoardUsageLimitMatch | null>;
}

export class UsageLimitDetector extends Context.Service<
  UsageLimitDetector,
  UsageLimitDetectorShape
>()("t3/board/UsageLimitDetector") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadGateway;

  const classifyTurn: UsageLimitDetectorShape["classifyTurn"] = (input) =>
    threads.threadState(input.threadId).pipe(
      Effect.map((state): BoardUsageLimitMatch | null => {
        const limit = state === UNKNOWN_THREAD_STATE ? null : (state?.usageLimit ?? null);
        if (limit === null) return null;
        const resetMs = limit.resetAt === null ? Number.NaN : Date.parse(limit.resetAt);
        return {
          kind: "wait",
          confidence: "strict",
          resumeAt: Number.isFinite(resetMs)
            ? DateTime.formatIso(DateTime.makeUnsafe(resetMs + RESUME_MARGIN_MS))
            : null,
          reason:
            limit.message !== null && limit.message.trim().length > 0
              ? limit.message.trim()
              : "The provider's usage limit was reached.",
          ruleId: "orchestration-v2-usage-limit",
        };
      }),
      // A read failure answers "no match", leaving recovery as it was.
      Effect.orElseSucceed(() => null),
    );

  return { classifyTurn } satisfies UsageLimitDetectorShape;
});

export const UsageLimitDetectorLive = Layer.effect(UsageLimitDetector, make);

/** The instant a caller measures a reset time against, as this service's
    callers hold it: epoch millis off the Effect clock, never `new Date()`. */
export const detectorNowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

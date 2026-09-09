/**
 * T3o usage-limit detection seam (T3O-22, D17).
 *
 * The only impure part of detection, and thin by construction: it reads the
 * thread's last assistant message, binds the clock, the server's time zone and
 * the shipped catalogue, calls the pure algorithm, and returns the verdict.
 * Everything that could be a decision instead of a lookup lives in
 * `boardUsageLimitDetect.ts`.
 *
 * A service rather than another function on the reactor, for three reasons:
 *
 * - `supervisorReactor.ts` is already five thousand lines. This keeps the
 *   message read, the time zone and the channel choice out of it; the reactor
 *   gains one call and acts on the verdict.
 * - Reactor tests can provide a STUB that returns a fixed verdict, so the
 *   behavioural suite drives `wait` / `exhausted` / `slow-down` / null directly
 *   instead of crafting provider prose and hoping the classifier agrees. Those
 *   tests are then testing the supervisor, which is what they are for.
 * - It is the established shape here — `BoardStepSlots`,
 *   `BoardPullRequestGateway` and `ProjectSetupScriptRunner` are all exactly
 *   this.
 */
import {
  type BoardUsageLimitChannel,
  type BoardUsageLimitMatch,
  detectBoardUsageLimit,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

import { boardSnapshotQueryMethodsOf } from "./projection.ts";

export interface UsageLimitDetectorShape {
  /**
   * Classify a turn that has just ended, or `null` when nothing in the
   * catalogue matched.
   *
   * `turnErrorMessage` is the failed turn's own `errorMessage` when the adapter
   * reported one. It is the STRONGER channel and is preferred over the last
   * assistant message: Grok's refusal arrives that way with no assistant
   * message present at all, and nobody quotes a sentence into a failed turn's
   * error field.
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

/** The server's own zone, for a provider that quotes a bare clock time with no
    zone beside it (`try again a 4:03AM`). A zone the message names always wins;
    this is only the fallback. */
export function serverTimeZone(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const make = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const boardQueries = boardSnapshotQueryMethodsOf(snapshotQuery);

  const classifyTurn: UsageLimitDetectorShape["classifyTurn"] = (input) =>
    Effect.gen(function* () {
      const timeZone = serverTimeZone();
      // The failed turn's error field first: it is unambiguous, and on the Grok
      // path it is the ONLY text there is.
      if (input.turnErrorMessage !== null && input.turnErrorMessage.trim().length > 0) {
        return classify(input.turnErrorMessage, "turn-error", input.nowMs, timeZone);
      }
      if (boardQueries === null) return null;
      // Best-effort in the shape of `endedWithQuestion`: a read failure, or a
      // thread with no assistant message at all, answers "no match", which
      // leaves recovery exactly as it was before this feature existed.
      const message = yield* boardQueries
        .boardLatestAssistantMessage(input.threadId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));
      if (message === null) return null;
      if (input.since !== null && !(message.createdAt > input.since)) return null;
      return classify(message.text, "message", input.nowMs, timeZone);
    });

  return { classifyTurn } satisfies UsageLimitDetectorShape;
});

const classify = (
  text: string,
  channel: BoardUsageLimitChannel,
  nowMs: number,
  timeZone: string,
): BoardUsageLimitMatch | null => detectBoardUsageLimit({ text, channel, nowMs, timeZone });

export const UsageLimitDetectorLive = Layer.effect(UsageLimitDetector, make);

/** The instant a caller measures a reset time against, as this service's
    callers hold it: epoch millis off the Effect clock, never `new Date()`. */
export const detectorNowMs = Effect.map(DateTime.now, DateTime.toEpochMillis);

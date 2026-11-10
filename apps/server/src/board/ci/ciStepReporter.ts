/**
 * A running CI step's live reports (T3O-60): its latest `::t3o-progress::`
 * line and whether it has gone quiet. Each report re-records the running step
 * row, so they are throttled: progress at most once every 10 s, and only when
 * the fraction (to 1 %) or the message changed. Going silent, or speaking
 * again after, reports at once.
 */
import {
  BOARD_CI_SILENT_AFTER_MS,
  parseBoardCiProgressLine,
  type BoardCiProgress,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/** The least time between two progress reports of one step. */
const BOARD_CI_PROGRESS_REPORT_MS = 10_000;
/** How often a running step's reporter wakes to flush or check for silence. */
const TICK_MS = 1_000;

/** What a running step row carries beyond its fixed fields. */
export interface BoardCiStepLive {
  readonly progress?: BoardCiProgress;
  readonly silentSince?: string;
}

export interface BoardCiStepReporter {
  /** Output arrived (any chunk, even one with no full line). */
  readonly output: Effect.Effect<void>;
  /** A complete output line. */
  readonly line: (line: string) => Effect.Effect<void>;
  /** The latest progress, for the step's settled row. */
  readonly progress: () => BoardCiProgress | undefined;
}

const progressKey = (progress: BoardCiProgress): string => {
  const { done, total } = progress;
  const amount =
    done !== null && total !== null && total > 0
      ? `${Math.floor((Math.min(done, total) / total) * 100)}%`
      : String(done);
  return `${amount}\0${progress.message ?? ""}`;
};

const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Start a step's reporter in the current scope; closing the scope stops it
    after any report already in flight has landed. */
export const makeBoardCiStepReporter = Effect.fn("BoardCiStepReporter.make")(function* (
  report: (live: BoardCiStepLive) => Effect.Effect<void>,
): Effect.fn.Return<BoardCiStepReporter, never, Scope.Scope> {
  const lock = yield* Semaphore.make(1);
  const startedMs = yield* Clock.currentTimeMillis;
  let latest: BoardCiProgress | undefined;
  let reportedKey: string | null = null;
  let reportedAtMs = Number.NEGATIVE_INFINITY;
  let lastOutputMs = startedMs;
  let silentSince: string | undefined;

  const live = (): BoardCiStepLive => ({
    ...(latest === undefined ? {} : { progress: latest }),
    ...(silentSince === undefined ? {} : { silentSince }),
  });
  const send = (nowMs: number) =>
    Effect.suspend(() => {
      reportedAtMs = nowMs;
      if (latest !== undefined) reportedKey = progressKey(latest);
      return report(live());
    });
  /** Under the lock and uninterruptible, so a report is never cut in half
      and the scope's close waits for it. */
  const guarded = (decide: (nowMs: number) => boolean) =>
    lock.withPermits(1)(
      Effect.uninterruptible(
        Effect.flatMap(Clock.currentTimeMillis, (nowMs) =>
          decide(nowMs) ? send(nowMs) : Effect.void,
        ),
      ),
    );
  const progressDue = (nowMs: number) =>
    latest !== undefined &&
    progressKey(latest) !== reportedKey &&
    nowMs - reportedAtMs >= BOARD_CI_PROGRESS_REPORT_MS;

  const tick = guarded((nowMs) => {
    if (silentSince === undefined && nowMs - lastOutputMs >= BOARD_CI_SILENT_AFTER_MS) {
      silentSince = isoAt(lastOutputMs);
      return true;
    }
    return progressDue(nowMs);
  });
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(TICK_MS), tick)));

  return {
    output: guarded((nowMs) => {
      lastOutputMs = nowMs;
      if (silentSince === undefined) return false;
      silentSince = undefined;
      return true;
    }),
    line: (text) => {
      const parsed = parseBoardCiProgressLine(text);
      if (parsed === null) return Effect.void;
      return guarded((nowMs) => {
        latest = { ...parsed, at: isoAt(nowMs) };
        return progressDue(nowMs);
      });
    },
    progress: () => latest,
  };
});

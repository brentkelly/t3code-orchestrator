// @effect-diagnostics nodeBuiltinImport:off
/**
 * The CI disk preflight (T3O-59): a pass doesn't start on a filesystem with
 * less than 2 GiB free, since a full disk is what left Z5-305 "running" with
 * no result. Fixed on purpose; there is no setting.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

const BOARD_CI_MIN_FREE_BYTES = 2 * 1024 ** 3;

export interface BoardDiskSpaceShape {
  /** Bytes free to an unprivileged writer at `path`, or null when unknown. */
  readonly freeBytes: (path: string) => Effect.Effect<number | null>;
}

const statfsFreeBytes = (path: string): Effect.Effect<number | null> =>
  Effect.callback<number | null>((resume) => {
    NodeFS.statfs(path, (error, stats) =>
      resume(Effect.succeed(error === null ? stats.bavail * stats.bsize : null)),
    );
  });

/** A Reference, so the real reader is the default and a test injects one. */
export class BoardDiskSpace extends Context.Reference<BoardDiskSpaceShape>(
  "t3/board/BoardDiskSpace",
  { defaultValue: () => ({ freeBytes: statfsFreeBytes }) },
) {}

/** Why `path`'s filesystem is too full for CI, or null when it isn't — or
    when it can't be read: a statfs error never blocks a pass. */
export const boardCiLowDiskReason = Effect.fn("boardCiLowDiskReason")(function* (path: string) {
  const disk = yield* BoardDiskSpace;
  const free = yield* disk.freeBytes(path).pipe(Effect.catchCause(() => Effect.succeed(null)));
  if (free === null || !Number.isFinite(free) || free >= BOARD_CI_MIN_FREE_BYTES) return null;
  return `Disk nearly full on ${NodeOS.hostname()}: ${(free / 1024 ** 3).toFixed(1)} GiB free.`;
});

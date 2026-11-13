// @effect-diagnostics nodeBuiltinImport:off - setup logs and markers are plain files in the worktree's git dir.
/**
 * A card's setup on the worker holding its worktree (T3O-86): run once, not bound to a
 * thread; the setup script runs in its own process group and a marker records success.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BOARD_CAPACITY_LOG_MAX_BYTES,
  BOARD_CARD_SETUP_STAGES,
  BOARD_CARD_SETUP_TAIL_LINES,
  type BoardCardSetupProgress,
  type BoardCardSetupStage,
  type BoardWorkerRunSetupInput,
  type BoardWorkerSetupState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { BoardCiTail, runBoardCiStep } from "../ci/BoardCiRunner.ts";

export const SETUP_DONE_MARKER = "t3o-setup-done";
const SETUP_LOG = "t3o-setup.log";
const SETUP_RESULT = "t3o-setup-failed";

/** The project's setup script on this worker, or null when it has none. */
export interface CardSetupScript {
  readonly command: string;
  /** Upstream's `async`: true (the default) lets the agent start while it runs. */
  readonly async: boolean;
  /** Environment the project's scripts get. */
  readonly env: Readonly<Record<string, string>>;
}

export interface CardSetupDeps {
  readonly script: (
    projectId: string,
    worktreePath: string,
  ) => Effect.Effect<CardSetupScript | null>;
  /** The worktree's private git dir, where the marker and log live; null when unreadable. */
  readonly gitDir: (worktreePath: string) => Effect.Effect<string | null>;
  /** Replaces the real step runner in tests. */
  readonly runStep?: typeof runBoardCiStep;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const stagesWith = (
  current: BoardCardSetupStage,
  status: "running" | "failed" | "done",
  durations: Partial<Record<BoardCardSetupStage, number>>,
): BoardCardSetupProgress["stages"] => {
  const at = BOARD_CARD_SETUP_STAGES.indexOf(current);
  return BOARD_CARD_SETUP_STAGES.map((stage, index) => ({
    stage,
    status:
      index < at
        ? "done"
        : index === at
          ? status
          : status === "failed"
            ? "skipped"
            : status === "done"
              ? "done"
              : "pending",
    durationMs: durations[stage] ?? null,
  }));
};

export const makeCardSetup = (deps: CardSetupDeps) => {
  const runStep = deps.runStep ?? runBoardCiStep;
  const running = new Map<string, Fiber.Fiber<unknown>>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const markerPath = Effect.fn("CardSetup.markerPath")(function* (worktreePath: string) {
    const dir = yield* deps.gitDir(worktreePath);
    return dir === null ? null : { dir, marker: NodePath.join(dir, SETUP_DONE_MARKER) };
  });

  const writeMarker = (path: string) =>
    Effect.sync(() => {
      try {
        NodeFS.writeFileSync(path, "done\n");
      } catch {
        // A marker that can't be written only means the next step sets up again.
      }
    });

  const state = Effect.fn("CardSetup.state")(function* (worktreePath: string) {
    if (running.has(worktreePath)) return "running" as BoardWorkerSetupState;
    const paths = yield* markerPath(worktreePath);
    if (paths === null) return "none" as BoardWorkerSetupState;
    if (NodeFS.existsSync(paths.marker)) return "done" as BoardWorkerSetupState;
    return (
      NodeFS.existsSync(NodePath.join(paths.dir, SETUP_RESULT)) ? "failed" : "none"
    ) as BoardWorkerSetupState;
  });

  /** The setup, streamed: the progress now, after every stage, then the result. */
  const run = (input: BoardWorkerRunSetupInput) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const startedAt = yield* nowIso;
        const started = yield* Clock.currentTimeMillis;
        const paths = yield* markerPath(input.worktreePath);
        const script = yield* deps.script(input.projectId, input.worktreePath);
        const blocking = script !== null && !script.async;
        const base = { exitCode: null, startedAt, tail: "", blocking, detail: null };
        const finished = (
          status: BoardCardSetupProgress["status"],
          extra: Partial<BoardCardSetupProgress> = {},
        ): BoardCardSetupProgress => ({
          ...base,
          status,
          stage: "setup-script",
          stages: stagesWith("setup-script", status === "succeeded" ? "done" : "failed", {}),
          durationMs: 0,
          ...extra,
        });
        if (paths === null) {
          return Stream.make(
            finished("failed", { detail: "The worktree has no git directory to set up." }),
          );
        }
        // One script per worktree: a second request while one runs reports it, and starts none.
        if (running.has(input.worktreePath) && input.markOnly !== true) {
          return Stream.make({
            ...base,
            status: "running",
            stage: "setup-script",
            stages: stagesWith("setup-script", "running", {}),
            durationMs: null,
            detail: "Already running on the worker.",
          } satisfies BoardCardSetupProgress);
        }
        const alreadyDone = NodeFS.existsSync(paths.marker);
        if (input.markOnly === true || (alreadyDone && input.retry !== true)) {
          if (!alreadyDone) yield* writeMarker(paths.marker);
          return Stream.make(finished("succeeded"));
        }
        if (script === null) {
          yield* writeMarker(paths.marker);
          return Stream.make(finished("succeeded", { detail: "The project has no setup script." }));
        }
        const queue = yield* Queue.unbounded<BoardCardSetupProgress, Cause.Done>();
        const tail = new BoardCiTail(BOARD_CARD_SETUP_TAIL_LINES);
        const progress = (
          status: BoardCardSetupProgress["status"],
          stageStatus: "running" | "failed" | "done",
          extra: Partial<BoardCardSetupProgress> = {},
        ): BoardCardSetupProgress => ({
          ...base,
          status,
          stage: "setup-script",
          stages: stagesWith("setup-script", stageStatus, {}),
          durationMs: null,
          tail: tail.text(),
          ...extra,
        });
        yield* Queue.offer(queue, progress("running", "running"));
        const env = Object.entries({
          ...script.env,
          T3CODE_WORKTREE_PATH: input.worktreePath,
        })
          .map(([key, value]) => `${key}=${shellQuote(value)}`)
          .join(" ");
        const fiber = yield* runStep({
          command: `${env} ${script.command}`,
          cwd: input.worktreePath,
          timeoutMs: input.timeoutMinutes * 60_000,
          tail,
          logPath: NodePath.join(paths.dir, SETUP_LOG),
          resultPath: NodePath.join(paths.dir, SETUP_RESULT),
        }).pipe(
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              const durationMs = (yield* Clock.currentTimeMillis) - started;
              if (exit.status === "passed") yield* writeMarker(paths.marker);
              else {
                yield* Effect.sync(() => {
                  try {
                    NodeFS.writeFileSync(
                      NodePath.join(paths.dir, SETUP_RESULT),
                      `${exit.exitCode ?? ""}\n`,
                    );
                  } catch {
                    // The state read falls back to "none".
                  }
                });
              }
              yield* Queue.offer(
                queue,
                exit.status === "passed"
                  ? progress("succeeded", "done", { exitCode: exit.exitCode, durationMs })
                  : progress("failed", "failed", {
                      exitCode: exit.exitCode,
                      durationMs,
                      detail:
                        exit.status === "timed-out"
                          ? `Timed out after ${input.timeoutMinutes} min.`
                          : null,
                    }),
              );
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.gen(function* () {
              const durationMs = (yield* Clock.currentTimeMillis) - started;
              yield* Queue.offer(
                queue,
                progress("cancelled", "failed", { durationMs, detail: "Setup was cancelled." }),
              );
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => running.delete(input.worktreePath)).pipe(
              Effect.andThen(Queue.end(queue)),
            ),
          ),
          Effect.forkDetach,
        );
        running.set(input.worktreePath, fiber);
        return Stream.fromQueue(queue);
      }),
    );

  const cancel = Effect.fn("CardSetup.cancel")(function* (worktreePath: string) {
    const fiber = running.get(worktreePath);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
  });

  /** The setup log's last 64 KB. */
  const readLog = Effect.fn("CardSetup.readLog")(function* (worktreePath: string) {
    const paths = yield* markerPath(worktreePath);
    if (paths === null) return "";
    return yield* Effect.sync(() => {
      try {
        const text = NodeFS.readFileSync(NodePath.join(paths.dir, SETUP_LOG), "utf8");
        return text.length > BOARD_CAPACITY_LOG_MAX_BYTES
          ? text.slice(-BOARD_CAPACITY_LOG_MAX_BYTES)
          : text;
      } catch {
        return "";
      }
    });
  });

  return { run, state, cancel, readLog };
};

export type CardSetup = ReturnType<typeof makeCardSetup>;

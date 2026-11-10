/**
 * A CI pass on a placed worker (T3O-44, D21): the worker runs the steps in the
 * card's worktree there and streams each step's progress back over its
 * gateway (`boardWorker.gateway.runCi`). Interrupting the pass closes the
 * stream, which interrupts the worker's run and kills its process group.
 */
import {
  boardCiStepGroups,
  clampBoardCiHeadline,
  type BoardCiPassStep,
  type BoardCiStepDefinition,
  type BoardWorkerCiProgress,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { WorkerConnectionsShape } from "../workers/WorkerConnections.ts";
import type { BoardCiRunnerShape, BoardCiRunResult } from "./BoardCiRunner.ts";

type WireCiDone = Extract<BoardWorkerCiProgress, { _tag: "done" }>;
type WireCiStep = Extract<BoardWorkerCiProgress, { _tag: "step" }>["step"];

/** The worker's end of a pass, as sent over its gateway. */
export function toWireCiDone(outcome: BoardCiRunResult): WireCiDone {
  return outcome.result === "unavailable"
    ? {
        _tag: "done",
        result: "unavailable",
        failedIndex: null,
        detail: outcome.detail,
        ...(outcome.machine === true ? { machine: true } : {}),
      }
    : {
        _tag: "done",
        result: outcome.result,
        failedIndex: outcome.failedIndex,
        ...(outcome.exitCode === undefined ? {} : { exitCode: outcome.exitCode }),
        ...(outcome.result === "failed" && outcome.headline !== undefined
          ? { headline: outcome.headline }
          : {}),
      };
}

/** A worker's headline, clamped here (T3O-61): the wire carries loose strings. */
const fromWireHeadline = (headline: WireCiDone["headline"]) =>
  headline === undefined ? null : clampBoardCiHeadline(headline);

/** A worker's step report as this board records it. */
function fromWireCiStep(step: WireCiStep): BoardCiPassStep {
  const { headline, ...rest } = step;
  const clamped = fromWireHeadline(headline);
  return {
    ...rest,
    ...(clamped === null ? {} : { headline: clamped }),
  };
}

function fromWireCiDone(done: WireCiDone): BoardCiRunResult {
  if (done.result === "unavailable") {
    return {
      result: "unavailable",
      failedIndex: null,
      detail: done.detail ?? "CI couldn't run on the card's worker.",
      ...(done.machine === true ? { machine: true } : {}),
    };
  }
  const headline = done.result === "failed" ? fromWireHeadline(done.headline) : null;
  return {
    result: done.result,
    failedIndex: done.failedIndex,
    ...(done.exitCode === undefined ? {} : { exitCode: done.exitCode }),
    ...(headline === null ? {} : { headline }),
  };
}

/** How long a worker's run may take before the board stops waiting
    (T3O-59): each group's longest step limit, summed, plus 10 minutes. */
export function remoteCiRunBudgetMs(steps: ReadonlyArray<BoardCiStepDefinition>): number {
  const indexed = steps.map((definition) => ({
    definition,
    kind: "script" as const,
    parallel: definition.parallel === true,
  }));
  const minutes = boardCiStepGroups(indexed).reduce(
    (total, group) => total + Math.max(...group.map((member) => member.definition.timeoutMinutes)),
    0,
  );
  return (minutes + 10) * 60_000;
}

const TIMED_OUT: BoardCiRunResult = {
  result: "unavailable",
  failedIndex: null,
  detail: "The worker's CI run didn't finish within its time limits; stopped.",
};

export const remoteCiRunner = (
  connections: Pick<WorkerConnectionsShape, "get">,
  workerId: EnvironmentId,
): BoardCiRunnerShape => ({
  run: (request, emit) =>
    Effect.gen(function* () {
      const result = yield* Ref.make<BoardCiRunResult | null>(null);
      const rpc = yield* connections.get(workerId);
      // A dropped connection already fails the stream at once: the client
      // doesn't retry its socket, raises a protocol error on requests in
      // flight, and a ping timeout covers a half-open one. This budget covers
      // a worker that stays connected but whose run never ends.
      const finished = yield* rpc.gateway
        .runCi({
          runId: request.runId,
          worktreePath: request.cwd,
          steps: request.steps,
          ...(request.indexOffset === undefined ? {} : { indexOffset: request.indexOffset }),
        })
        .pipe(
          Stream.runForEach((progress) =>
            progress._tag === "step"
              ? emit({ index: progress.index, step: fromWireCiStep(progress.step) })
              : Ref.set(result, fromWireCiDone(progress)),
          ),
          Effect.timeoutOption(remoteCiRunBudgetMs(request.steps)),
        );
      if (Option.isNone(finished)) return TIMED_OUT;
      const outcome = yield* Ref.get(result);
      const ended: BoardCiRunResult = {
        result: "unavailable",
        failedIndex: null,
        detail: "The worker's CI run ended without a result.",
      };
      return outcome ?? ended;
    }).pipe(
      Effect.catch((cause) =>
        Effect.succeed<BoardCiRunResult>({
          result: "unavailable",
          failedIndex: null,
          detail: `CI couldn't run on the card's worker: ${
            (cause as { readonly message?: string }).message ?? String(cause)
          }`,
        }),
      ),
    ),
});

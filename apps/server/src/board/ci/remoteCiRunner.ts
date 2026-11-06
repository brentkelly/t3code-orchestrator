/**
 * A CI pass on a placed worker (T3O-44, D21): the worker runs the steps in the
 * card's worktree there and streams each step's progress back over its
 * gateway (`boardWorker.gateway.runCi`). Interrupting the pass closes the
 * stream, which interrupts the worker's run and kills its process group.
 */
import type { BoardWorkerCiProgress, EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { WorkerConnectionsShape } from "../workers/WorkerConnections.ts";
import type { BoardCiRunnerShape, BoardCiRunResult } from "./BoardCiRunner.ts";

type WireCiDone = Extract<BoardWorkerCiProgress, { _tag: "done" }>;

/** The worker's end of a pass, as sent over its gateway. */
export function toWireCiDone(outcome: BoardCiRunResult): WireCiDone {
  return outcome.result === "unavailable"
    ? { _tag: "done", result: "unavailable", failedIndex: null, detail: outcome.detail }
    : { _tag: "done", result: outcome.result, failedIndex: outcome.failedIndex };
}

function fromWireCiDone(done: WireCiDone): BoardCiRunResult {
  return done.result === "unavailable"
    ? {
        result: "unavailable",
        failedIndex: null,
        detail: done.detail ?? "CI couldn't run on the card's worker.",
      }
    : { result: done.result, failedIndex: done.failedIndex };
}

export const remoteCiRunner = (
  connections: Pick<WorkerConnectionsShape, "get">,
  workerId: EnvironmentId,
): BoardCiRunnerShape => ({
  run: (request, emit) =>
    Effect.gen(function* () {
      const result = yield* Ref.make<BoardCiRunResult | null>(null);
      const rpc = yield* connections.get(workerId);
      yield* rpc.gateway
        .runCi({
          runId: request.runId,
          worktreePath: request.cwd,
          steps: request.steps,
          ...(request.indexOffset === undefined ? {} : { indexOffset: request.indexOffset }),
        })
        .pipe(
          Stream.runForEach((progress) =>
            progress._tag === "step"
              ? emit({ index: progress.index, step: progress.step })
              : Ref.set(result, fromWireCiDone(progress)),
          ),
        );
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

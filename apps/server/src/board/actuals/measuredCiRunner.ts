/**
 * T3o (T3O-87): the CI runner every board layer captures, measuring each pass under
 * `ci:<runId>`: its steps run in scopes of their own, sampled until the pass returns.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BoardCiRunner, runBoardCiPass } from "../ci/BoardCiRunner.ts";
import { BoardActualsMeter, BoardActualsTap } from "./BoardActualsMeter.ts";

const boardCiActualsKey = (runId: string) => `ci:${runId}`;

export const BoardMeasuredCiRunnerLive = Layer.effect(
  BoardCiRunner,
  Effect.map(BoardActualsMeter, (meter) => ({
    run: (request, emit) =>
      runBoardCiPass(request, emit).pipe(
        Effect.provideService(BoardActualsTap, meter.tap(boardCiActualsKey(request.runId))),
        Effect.ensuring(meter.finish(boardCiActualsKey(request.runId))),
      ),
  })),
);

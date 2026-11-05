import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";
import { BoardSetupScriptRunner } from "./BoardSetupScriptRunner.ts";

export const BoardSetupScriptRunnerLive = Layer.effect(
  BoardSetupScriptRunner,
  Effect.gen(function* () {
    const runner = yield* ProjectSetupScriptRunner;
    return BoardSetupScriptRunner.of({ runForThread: runner.runForThread });
  }),
);

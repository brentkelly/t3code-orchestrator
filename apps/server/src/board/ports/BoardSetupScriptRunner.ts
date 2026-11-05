/**
 * The board's narrow view of upstream's `ProjectSetupScriptRunner` (T3O-45).
 * Upstream's module defines the tag beside its implementation, and importing it
 * loads `terminal/Manager.ts` and every provider driver. Board code depends on
 * this port instead; only `BoardSetupScriptRunner.live.ts` imports upstream.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type {
  ProjectSetupScriptRunnerError,
  ProjectSetupScriptRunnerInput,
  ProjectSetupScriptRunnerResult,
} from "../../project/ProjectSetupScriptRunner.ts";

export class BoardSetupScriptRunner extends Context.Service<
  BoardSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3o/board/ports/BoardSetupScriptRunner") {}

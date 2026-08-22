/**
 * T3o stage executor seam (t3o-15, D15) — the extension point t3o-16's review
 * loop plugs into without touching the reactor.
 *
 * The reactor (`supervisorReactor.ts`) stays generic: it owns stage-entry
 * detection, worktree provisioning, slot acquisition, thread spawn, `sendTurn`,
 * death detection, the recovery ladder and auto-advance. It delegates exactly
 * one question to a **stage executor** — *what runs next, or are we done?* — and
 * never learns what kind of stage it is driving. An `if (stage.role === "review")`
 * branch in the reactor would be the first leak of review logic through the
 * reactor, the decider, the projector and the board UI; the executor seam keeps
 * every one of them uniform.
 *
 * `planNext` is **pure** — no SQL, no git, no thread handles — in the same
 * spirit as `recoveryDecision` and `reconcileStepDecision` in `supervisor.ts`,
 * so it is unit-testable without a reactor, a database or a git repository
 * (acceptance criterion 19). It returns a prompt; the *agent* runs `git` in its
 * worktree, so git stays out of the decision path entirely (D15).
 *
 * This spec ships one implementation, `SimpleStageExecutor`, wrapping the
 * single-step "decide the next step to run" logic that used to sit inline in the
 * reactor: it yields the stage's one seeded step and reports `complete` as soon
 * as that step has succeeded (D1). t3o-16 adds a `ReviewLoopExecutor` that holds
 * the entire review loop — phases, rounds, convergence — inside itself and
 * registers under the `review` role; nothing else in the codebase learns about
 * it. Combined with the `kind`-discriminated `BoardStageExecution` union (D4),
 * the whole codebase branches on stage kind in exactly two places: the settings
 * card (which panel to render) and this registry (which executor to run).
 */
import type {
  BoardCard,
  BoardModelSelection,
  BoardStageExecution,
  BoardStageRole,
  BoardStepCompletion,
  BoardStepOutcome,
} from "@t3tools/contracts";

import { ReviewLoopExecutor } from "./reviewLoopExecutor.ts";

/**
 * The execution parameters a stage executor plans over, assembled by the
 * reactor from the stage definition and its resolved settings config (D4/D12).
 * `model` is already resolved to a concrete provider-instance + model pair
 * (D12), so the executor stays pure and never reaches for a global default.
 */
export interface BoardStageExecutorConfig {
  /** The stage's single step id (D1) — the stage id itself. A multi-step
      executor (t3o-16) mints its own round-scoped step ids and ignores this. */
  readonly stepId: string;
  /** The stage's display label. A single-step executor plans a run with NO
      step identity (t3o-19, D4), so this is the STAGE's name, not a step's;
      it is frozen onto the run row as `stageLabel` and is what the preamble
      prints. A multi-step executor mints its own per-step labels. */
  readonly stageLabel: string;
  readonly prompt: string;
  readonly model: BoardModelSelection;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  /**
   * The stage's fully resolved execution config (D4). A single-step executor
   * plans over the flat `prompt`/`model`/… above; a multi-step executor
   * (t3o-16's review loop) reads its per-phase config off this discriminated
   * union member. Passing the whole resolved config keeps the reactor generic —
   * it never unpacks a stage kind it does not understand.
   */
  readonly execution: BoardStageExecution;
}

/**
 * The executor's view of the run in progress. `round` is the executor's own
 * counter for a sequence that completed but did not converge (t3o-16), stamped
 * onto the step it hands back — kept distinct from the reactor's `maxAttempts`
 * recovery ladder, which counts a step whose thread died. `completedStepIds`
 * are the steps this run has already succeeded, so the executor decides "another
 * step or done?" from run progress rather than from a card's all-time history
 * (a re-entry drag-back is the reactor's D7 concern, not the executor's).
 */
export interface BoardStageRunState {
  readonly round: number;
  readonly completedStepIds: readonly string[];
}

/** What the executor decides the reactor should do next. */
export type BoardStagePlan =
  | {
      readonly kind: "run";
      readonly round: number;
      readonly stepId: string;
      /** The step's label, or NULL when this stage has no steps (t3o-19, D4).
          `SimpleStageExecutor` always returns null — its stage runs one step
          whose label would only ever repeat the stage's, which is what put
          `Stage: planning. Step: Planning.` into every prompt. The review loop
          returns a real label, and so would a future sequence executor: the
          presence of the label IS the "stepped" signal, so neither the
          envelope nor the reactor needs a flag to keep in sync. */
      readonly stepLabel: string | null;
      readonly prompt: string;
      readonly model: BoardModelSelection;
      readonly timeoutMs: number;
      readonly maxAttempts: number;
    }
  | { readonly kind: "complete"; readonly outcome: BoardStepOutcome }
  | { readonly kind: "escalate"; readonly question: string };

export interface BoardStagePlanInput {
  readonly card: BoardCard;
  readonly config: BoardStageExecutorConfig;
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  readonly runState: BoardStageRunState;
}

/**
 * The one question the reactor asks a stage: what runs next, or are we done?
 * (D15). Pure over its inputs — no SQL client, no git, no thread handles.
 */
export interface BoardStageExecutor {
  planNext(input: BoardStagePlanInput): BoardStagePlan;
}

/**
 * The single-step executor every stage uses except the review loop (D1/D15). It
 * yields the stage's one seeded step, and reports `complete` as soon as that
 * step has succeeded in the current run. It never escalates — the reactor owns
 * the recovery ladder (D13). t3o-16's `ReviewLoopExecutor` is the multi-round
 * exception: it completes `blocked` when its sequence runs to the round cap
 * without converging (the `escalate` arm stays part of the seam contract for a
 * future executor, but no shipped executor emits it).
 */
export const SimpleStageExecutor: BoardStageExecutor = {
  planNext({ config, runState }: BoardStagePlanInput): BoardStagePlan {
    if (runState.completedStepIds.includes(config.stepId)) {
      return { kind: "complete", outcome: "succeeded" };
    }
    return {
      kind: "run",
      round: runState.round,
      stepId: config.stepId,
      // No step identity: this stage has exactly one step and naming it would
      // just echo the stage (t3o-19, D4).
      stepLabel: null,
      prompt: config.prompt,
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
    };
  },
};

/**
 * Executor implementations keyed by stage role (D15). The `review` role runs the
 * multi-phase `ReviewLoopExecutor` (t3o-16); every other role, and a null-role
 * custom stage, falls through to `SimpleStageExecutor`. Registering here is the
 * single edit that teaches the pipeline about review without touching the
 * reactor — the reactor only ever asks `stageExecutorForRole(...).planNext`.
 */
const STAGE_EXECUTORS: Partial<Record<BoardStageRole, BoardStageExecutor>> = {
  review: ReviewLoopExecutor,
};

/**
 * Resolve the executor for a stage's role — the one place in the codebase that
 * branches on role to decide *what to execute* (acceptance criterion 20). A
 * role with no registered executor (and a null-role custom stage) runs the
 * simple single-step executor.
 */
export function stageExecutorForRole(role: BoardStageRole | null): BoardStageExecutor {
  return (role !== null ? STAGE_EXECUTORS[role] : undefined) ?? SimpleStageExecutor;
}

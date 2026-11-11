/**
 * The stage executor seam. The reactor stays generic and asks one question of an
 * executor, "what runs next, or are we done?", so it never learns what kind of stage it
 * drives. `planNext` is pure (no SQL, git or thread handles); it returns a prompt and the
 * agent runs git. Stage kind is branched on only in the settings card and this registry.
 */
import type {
  BoardCiAgentStepPayload,
  BoardCiFixIssue,
  BoardCiHeadline,
  BoardCiStepResult,
  BoardCard,
  BoardCardStageModelOverride,
  BoardModelSelection,
  BoardStageExecution,
  BoardStageRole,
  BoardStepCompletion,
  BoardStepOutcome,
  RuntimeMode,
} from "@t3tools/contracts";
import { BOARD_SUBMIT_STEP_ID, boardModelSelectionOfOverride } from "@t3tools/contracts";

import { CiStageExecutor } from "./ci/ciStageExecutor.ts";
import { ReviewLoopExecutor } from "./reviewLoopExecutor.ts";

/**
 * The execution parameters a stage executor plans over, assembled by the
 * reactor from the stage definition and its resolved settings config.
 * `model` is already resolved to a concrete provider-instance + model pair,
 * so the executor stays pure and never reaches for a global default.
 */
export interface BoardStageExecutorConfig {
  /** The stage's single step id — the stage id itself. A multi-step
      executor mints its own round-scoped step ids and ignores this. */
  readonly stepId: string;
  /** The stage's display label. A single-step executor plans a run with NO
      step identity, so this is the STAGE's name, not a step's;
      it is frozen onto the run row as `stageLabel` and is what the preamble
      prints. A multi-step executor mints its own per-step labels. */
  readonly stageLabel: string;
  readonly prompt: string;
  readonly model: BoardModelSelection;
  /** The resolved agent authority for the run. The reactor resolves
      it (never derives it from `mode`) and freezes it onto the run row. */
  readonly runtimeMode: RuntimeMode;
  /**
   * This card's own model and access override for this stage, resolved through the parent
   * for a sub-board child; null when the workspace config governs. Kept beside `model`
   * because what it governs is each executor's call: folding it in would re-model triage
   * and adjudication too.
   */
  readonly cardOverride: BoardCardStageModelOverride | null;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  /**
   * The stage's fully resolved execution config. Multi-step executors read per-phase config
   * off it, so the reactor never unpacks a stage kind it does not understand.
   */
  readonly execution: BoardStageExecution;
}

/**
 * The run in progress. `round` is the executor's own counter, distinct from the reactor's
 * `maxAttempts` recovery ladder. `completedStepIds` are this run's successes, so the
 * executor decides from run progress, not the card's all-time history.
 */
export interface BoardStageRunState {
  readonly round: number;
  readonly completedStepIds: readonly string[];
  /**
   * The step in flight, or null. Every reactor caller today plans only when nothing runs and
   * passes null; it is part of the contract so an executor can tell a STARTED round from a
   * recorded one. The decider's floor is what protects a live run in production.
   */
  readonly liveStepId: string | null;
  /**
   * Whether the base moved since `baseTipAtRoundStart`, measured by the reactor because
   * `planNext` cannot. False with no recorded tip, and only measured for a sub-board child.
   * The review loop reads it to decide whether a sync step stands before `succeeded`.
   */
  readonly baseStale: boolean;
  /**
   * The base the card was retargeted at, when the recorded base has not caught up; null
   * otherwise. Reactor-resolved (it needs the project's default branch). The review loop
   * uses it to word the sync prompt, since "a sibling merged into it" is false here.
   */
  readonly baseRetargetedTo: string | null;
  /**
   * The step that just SETTLED, or null on stage entry. Distinct from `liveStepId`: the
   * build executor needs it to tell "submit just succeeded, route to merge" from "a rebuild
   * that carries an old submit completion".
   */
  readonly settledStepId: string | null;
  /** Every CI step that failed in the pass, in step order, when
      the reactor is asking the CI executor what follows a failed pass; null
      otherwise. Reactor-resolved from the pass record, because the output
      tail never rides the card. Never empty when present. */
  readonly ciFailures?: ReadonlyArray<BoardCiFailure> | null;
  /** The fix issues of that pass (`boardCiFixIssues`), beside `ciFailures`. */
  readonly ciIssues?: ReadonlyArray<BoardCiFixIssue>;
}

/** A failed CI step, as the fix agent needs to see it. */
export interface BoardCiFailure {
  readonly runId: string;
  readonly stepName: string;
  readonly command: string;
  readonly status: "failed" | "timed-out";
  readonly exitCode: number | null;
  readonly tail: string;
  readonly logPath: string | null;
  /** What the step reported in its result file. */
  readonly result?: BoardCiStepResult | null;
  /** What failed and why, as the runner read it. */
  readonly headline?: BoardCiHeadline | null;
}

/** What the executor decides the reactor should do next. */
export type BoardStagePlan =
  | {
      readonly kind: "run";
      readonly round: number;
      readonly stepId: string;
      /**
       * The step's label, or null when the stage has no steps (its label would only repeat the
       * stage's). The label's presence IS the "stepped" signal, so no flag needs syncing.
       */
      readonly stepLabel: string | null;
      readonly prompt: string;
      readonly model: BoardModelSelection;
      /** The agent authority this step runs under. A single-step
          executor echoes the stage config; the review loop resolves it
          per phase. */
      readonly runtimeMode: RuntimeMode;
      readonly timeoutMs: number;
      readonly maxAttempts: number;
      /**
       * Whether this step STARTS a review round, so the reactor never parses review step ids.
       * `true` measures and records the base tip as `baseTipAtRoundStart`; `false` carries the
       * replaced row's tip forward, so a round's later steps keep the tip its review began from.
       */
      readonly recordBaseTip: boolean;
    }
  | {
      readonly kind: "complete";
      readonly outcome: BoardStepOutcome;
      /**
       * Where this stage ends toward, when not simply the next stage. A directed advance is a
       * human's explicit request: it bypasses `autoAdvance` and moves with `override`, because
       * the target is non-adjacent by construction.
       */
      readonly advanceToRole?: BoardStageRole;
    }
  | { readonly kind: "escalate"; readonly question: string }
  /** Run the stage's CI steps from the top: the board runs them
      itself, no agent. */
  | { readonly kind: "ci-pass" }
  /** A CI agent step reported: record its verdict, then carry on
      with the pass, or treat a failed verdict as the pass's failure. */
  | {
      readonly kind: "ci-agent-done";
      readonly runId: string;
      readonly index: number;
      readonly verdict: BoardCiAgentStepPayload | null;
    }
  /** Stop the card in CI for a human: fix attempts used up, the
      fix agent couldn't fix something, or its verdict was unreadable. */
  | {
      readonly kind: "ci-stop";
      readonly stepName: string | null;
      readonly reason: string;
    };

export interface BoardStagePlanInput {
  readonly card: BoardCard;
  readonly config: BoardStageExecutorConfig;
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  readonly runState: BoardStageRunState;
}

/**
 * The one question the reactor asks a stage: what runs next, or are we done?.
 * Pure over its inputs — no SQL client, no git, no thread handles.
 */
export interface BoardStageExecutor {
  planNext(input: BoardStagePlanInput): BoardStagePlan;
}

/**
 * Every stage's executor except review and build: yields the stage's one step and
 * completes as soon as it has succeeded in this run. It never escalates; the reactor owns
 * the recovery ladder.
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
      // just echo the stage.
      stepLabel: null,
      prompt: config.prompt,
      // A single-step stage has one run, so the card's override governs it
      // outright: the model when it names one, and the access level
      // only when it names that too — an override says what it changes and
      // nothing more.
      model:
        config.cardOverride === null
          ? config.model
          : boardModelSelectionOfOverride(config.cardOverride),
      runtimeMode: config.cardOverride?.runtimeMode ?? config.runtimeMode,
      timeoutMs: config.timeoutMs,
      maxAttempts: config.maxAttempts,
      // A single-step stage runs no review rounds; the row keeps whatever tip
      // the card last recorded.
      recordBaseTip: false,
    };
  },
};

/**
 * The build-role executor routes a settled submit step to merge. Without it the stage's
 * `autoAdvance` would move the card into Code review, the stage submit exists to skip. It
 * routes on the SETTLE: a rebuilt card still carries its old, never-cleared completion.
 */
export const BuildStageExecutor: BoardStageExecutor = {
  planNext(input: BoardStagePlanInput): BoardStagePlan {
    if (input.runState.settledStepId === BOARD_SUBMIT_STEP_ID) {
      return { kind: "complete", outcome: "succeeded", advanceToRole: "merge" };
    }
    return SimpleStageExecutor.planNext(input);
  },
};

/**
 * Executors by stage role; every other role, and a null-role custom stage, falls through
 * to `SimpleStageExecutor`. Registering here teaches the pipeline a stage kind without
 * touching the reactor.
 */
const STAGE_EXECUTORS: Partial<Record<BoardStageRole, BoardStageExecutor>> = {
  review: ReviewLoopExecutor,
  build: BuildStageExecutor,
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

/**
 * The executor for a stage: by role, except the CI stage, which holds
 * no role and runs scripts, so it is keyed by its execution member's kind.
 */
export function stageExecutorFor(
  role: BoardStageRole | null,
  execution: BoardStageExecution,
): BoardStageExecutor {
  return execution.kind === "ci" ? CiStageExecutor : stageExecutorForRole(role);
}

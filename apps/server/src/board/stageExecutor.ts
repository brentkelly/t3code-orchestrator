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
  BoardCardStageModelOverride,
  BoardModelSelection,
  BoardStageExecution,
  BoardStageRole,
  BoardStepCompletion,
  BoardStepOutcome,
  RuntimeMode,
} from "@t3tools/contracts";
import { BOARD_SUBMIT_STEP_ID, boardModelSelectionOfOverride } from "@t3tools/contracts";

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
  /** The resolved agent authority for the run (t3o-21). The reactor resolves
      it (never derives it from `mode`) and freezes it onto the run row. */
  readonly runtimeMode: RuntimeMode;
  /**
   * This card's own override of the model and access level for THIS stage
   * (t3o-29), already resolved through the parent for a sub-board child; null
   * when the workspace config governs.
   *
   * Carried BESIDE `model` rather than folded into it, because what an override
   * means is the executor's business, not the reactor's. Folding it in would
   * make the card's "Review model" also re-model triage and adjudication — both
   * default to a null per-phase model and so fall through to `model` — which is
   * exactly what t3o-22 D4 refused, and the reactor cannot special-case the
   * review role without becoming the role branch the seam exists to prevent.
   * So the reactor resolves it (only it can see the board and the parent) and
   * each executor decides what it governs.
   */
  readonly cardOverride: BoardCardStageModelOverride | null;
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
  /** The card's step currently in flight, or null when nothing is running.
      Part of the seam's CONTRACT — a run state that cannot express "a step is
      in flight" is a lossy description of a run — rather than an active guard:
      every reactor caller today plans only when nothing is running and passes
      null. It matters because a multi-step executor must be able to tell a
      round that has STARTED from one that has merely been recorded, and
      t3o-22's round-budget floor turns on exactly that distinction. The floor
      that protects a live run in production is the decider's, which reads the
      card's live step directly. */
  readonly liveStepId: string | null;
  /** Whether the card's base branch has MOVED since its recorded
      `baseTipAtRoundStart` (t3o-24, D1) — resolved by the reactor (one
      `rev-parse` in the project root against the run row's recorded tip)
      because `planNext` is pure and cannot measure. Always false for a card
      with no recorded tip (staleness is measured, not assumed), and the
      reactor only ever measures it for a sub-board child — a top-level card's
      base moving is the universal condition of trunk development, out of the
      gate's scope. The review-loop executor reads it at its convergence arm to
      decide whether a sync-base step stands between the loop and `succeeded`;
      every other executor ignores it. */
  readonly baseStale: boolean;
  /** The step that just SETTLED, or null on stage entry (t3o-07, D5).
   *
   * Distinct from `liveStepId`, which means "in flight": a run state that can
   * only say what is running cannot say what just finished, and the build
   * executor needs exactly that to tell "the submit step just succeeded, route
   * this card to merge" from "this card is being rebuilt and happens to carry
   * an old submit completion". The reactor already holds it — `continueStage`
   * is called with the settled state — so this only lets the seam express it.
   * Every other executor ignores it. */
  readonly settledStepId: string | null;
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
      /** The agent authority this step runs under (t3o-21). A single-step
          executor echoes the stage config; the review loop resolves it
          per phase. */
      readonly runtimeMode: RuntimeMode;
      readonly timeoutMs: number;
      readonly maxAttempts: number;
      /** Whether this step STARTS a review round (t3o-24, D1) — the executor's
          signal to the reactor, which cannot be allowed to parse review step
          ids itself (D15: the reactor learns nothing). `true` has the reactor
          measure the base branch's current tip and record it onto the run row
          as `baseTipAtRoundStart`; `false` carries the replaced row's recorded
          tip forward, so a round's later steps keep the tip its review
          started from. */
      readonly recordBaseTip: boolean;
    }
  | {
      readonly kind: "complete";
      readonly outcome: BoardStepOutcome;
      /** Where this stage ends TOWARD (t3o-07, D5), when it does not simply end
          at the next stage in order. The reactor resolves the role with
          `boardStageWithRole`, which it does throughout, so it stays
          role-generic and learns nothing about submission. A directed advance
          is a human's explicit request: it bypasses the stage's `autoAdvance`
          and moves with `override`, because the target is non-adjacent by
          construction (D6). */
      readonly advanceToRole?: BoardStageRole;
    }
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
 * exception: it completes `succeeded` ONLY when its loop CONVERGES (a round
 * with nothing blocking), and `blocked` for every other ending — the round cap,
 * a stop the user asked for, or a broken reviewer payload (t3o-22, D1). That
 * split is what keeps `advanceStage`, which is gated on `succeeded`, from
 * graduating a card nothing ever passed. (The `escalate` arm stays part of the
 * seam contract for a future executor, but no shipped executor emits it.)
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
      // A single-step stage has one run, so the card's override governs it
      // outright (t3o-29): the model when it names one, and the access level
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
      // the card last recorded (t3o-24).
      recordBaseTip: false,
    };
  },
};

/**
 * The build-role executor (t3o-07, D4).
 *
 * A thin wrapper, and load-bearing rather than tidy. Building ships
 * `autoAdvance: true`: when the submit step settles, `continueStage` asks the
 * stage's executor what happens next, and `SimpleStageExecutor` would see the
 * ordinary build step already recorded, report `complete: succeeded`, and let
 * `advanceStage` move the card to the next stage in order — **Code review**,
 * the one stage the whole feature exists to skip. Registering an executor for
 * the role is the sanctioned single edit, and it keeps the reactor from
 * learning what a submit step is.
 *
 * It routes on the SETTLE, never on the recorded completion. Completions are
 * keyed `(cardId, stepId)` and never cleared, so a card dragged back to
 * Building for a second build still carries its old `submit` completion — and
 * keying on that would send the rebuild straight to merge the moment it
 * finished.
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
 * Executor implementations keyed by stage role (D15). The `review` role runs the
 * multi-phase `ReviewLoopExecutor` (t3o-16) and the `build` role the
 * settle-routing `BuildStageExecutor` (t3o-07); every other role, and a
 * null-role custom stage, falls through to `SimpleStageExecutor`. Registering
 * here is the single edit that teaches the pipeline about a stage kind without
 * touching the reactor — the reactor only ever asks
 * `stageExecutorForRole(...).planNext`.
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

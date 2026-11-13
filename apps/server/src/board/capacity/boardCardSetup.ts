/**
 * A card's setup, from the board (T3O-86): once per worktree on its worker, each stage
 * persisted on the card; a setup that holds the agent holds the step.
 */
import {
  boardProjectStageConfig,
  boardStageWithRole,
  resolveBoardProjectResourceSettings,
  type BoardCard,
  type BoardCardId,
  type BoardCardSetupProgress,
  type BoardCardSetupResult,
  type BoardCommand,
  type BoardState,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { BoardCapacityClientShape } from "./BoardCapacityClient.ts";
import type { CapacityHold } from "./boardCapacityAdmission.ts";

export interface BoardCardSetupDeps {
  readonly client: BoardCapacityClientShape;
  readonly readBoard: Effect.Effect<BoardState>;
  readonly dispatch: (command: BoardCommand) => Effect.Effect<boolean>;
  readonly commandId: (tag: string) => Effect.Effect<BoardCommand["commandId"]>;
  readonly nowIso: Effect.Effect<string>;
  /** Where the card's worktree is, and the worker's own id for its project. */
  readonly placement: (
    card: BoardCard,
  ) => Effect.Effect<{ readonly workerId: BoardWorkerId; readonly projectId: string }>;
  /** A setup ended: the scheduler looks again. */
  readonly onFinished: Effect.Effect<void>;
}

/** Whether the card has finished a Building step: its worktree already works. */
export const cardBuiltOnce = (board: BoardState, cardId: BoardCardId) => {
  const build = boardStageWithRole(board, "build");
  return (
    build !== null &&
    (board.stepCompletions ?? []).some(
      (completion) =>
        completion.cardId === cardId &&
        completion.stepId === build.stageId &&
        completion.outcome === "succeeded",
    )
  );
};

/** What holds a card's next step on its setup, or null. */
export function setupHold(card: BoardCard, workerId: BoardWorkerId): CapacityHold | null {
  const setup = card.resources?.setup ?? null;
  if (setup === null || !setup.blocking || setup.status === "succeeded") return null;
  return { queuedBy: "setup", detail: { workerId }, blocksWorker: false };
}

export const toSetupResult = (
  progress: BoardCardSetupProgress,
  workerId: BoardWorkerId,
): BoardCardSetupResult => ({
  status: progress.status,
  stage: progress.stage,
  exitCode: progress.exitCode,
  startedAt: progress.startedAt,
  durationMs: progress.durationMs,
  workerId,
  detail: progress.detail,
  blocking: progress.blocking,
});

export const makeBoardCardSetup = (deps: BoardCardSetupDeps) => {
  const runs = new Map<string, Fiber.Fiber<unknown>>();

  const record = Effect.fn("BoardCardSetup.record")(function* (
    cardId: BoardCardId,
    setup: BoardCardSetupResult | null,
  ) {
    yield* deps.dispatch({
      type: "board.card.record-setup",
      commandId: yield* deps.commandId("record-setup"),
      cardId,
      setup,
      createdAt: yield* deps.nowIso,
    });
  });

  /** Start the card's setup on its worker, on a fiber of its own. */
  const start = Effect.fn("BoardCardSetup.start")(function* (
    card: BoardCard,
    options: { readonly retry?: boolean; readonly markOnly?: boolean } = {},
  ) {
    if (runs.has(card.id) || card.worktree?.path == null) return;
    const board = yield* deps.readBoard;
    const { workerId, projectId } = yield* deps.placement(card);
    const settings = resolveBoardProjectResourceSettings(
      boardProjectStageConfig(board, card.projectId)?.resources ?? null,
    );
    const worktreePath = card.worktree.path;
    const fiber = yield* deps.client
      .runSetup(workerId, {
        cardId: card.id,
        projectId,
        worktreePath,
        timeoutMinutes: settings.setupTimeoutMinutes,
        ...(options.retry === true ? { retry: true } : {}),
        ...(options.markOnly === true ? { markOnly: true } : {}),
      })
      .pipe(
        Stream.runForEach((progress) => record(card.id, toSetupResult(progress, workerId))),
        Effect.ignoreCause,
        Effect.ensuring(
          Effect.sync(() => runs.delete(card.id)).pipe(Effect.andThen(deps.onFinished)),
        ),
        Effect.forkDetach,
      );
    runs.set(card.id, fiber);
  });

  const cancel = Effect.fn("BoardCardSetup.cancel")(function* (card: BoardCard) {
    const { workerId } = yield* deps.placement(card);
    if (card.worktree?.path != null) yield* deps.client.cancelSetup(workerId, card.worktree.path);
    const fiber = runs.get(card.id);
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
  });

  /**
   * Before a step: a card with a worktree and no setup on record gets one (a card that
   * already built is only marked set up). Null when the step may go ahead.
   */
  const gate = Effect.fn("BoardCardSetup.gate")(function* (
    card: BoardCard,
    workerId: BoardWorkerId,
  ) {
    if (card.group !== null || card.worktree?.status !== "ready") return null;
    if ((card.resources?.setup ?? null) === null) {
      const board = yield* deps.readBoard;
      yield* start(card, { markOnly: cardBuiltOnce(board, card.id) });
      return null;
    }
    return setupHold(card, workerId);
  });

  /** Ask each worker about a setup the board shows running with no run of its own. */
  const reconcile = Effect.fn("BoardCardSetup.reconcile")(function* () {
    const board = yield* deps.readBoard;
    for (const card of board.cards) {
      const setup = card.resources?.setup ?? null;
      if (setup === null || setup.status !== "running" || runs.has(card.id)) continue;
      if (card.worktree?.path == null) continue;
      const { workerId } = yield* deps.placement(card);
      const state = yield* deps.client.setupState(workerId, card.worktree.path);
      if (state === null || state === "running") continue;
      yield* record(card.id, {
        ...setup,
        status: state === "done" ? "succeeded" : "failed",
        detail: state === "none" ? "Interrupted: the worker restarted." : setup.detail,
      });
    }
  });

  /** A human asked: Retry runs the script again; Cancel stops it. */
  const onRequested = Effect.fn("BoardCardSetup.onRequested")(function* (card: BoardCard) {
    const setup = card.resources?.setup ?? null;
    if (setup === null) return;
    if (setup.status === "running" && !runs.has(card.id)) {
      yield* start(card, { retry: true });
    } else if (setup.status === "cancelled" && runs.has(card.id)) {
      yield* cancel(card);
    }
  });

  return {
    start,
    cancel,
    gate,
    reconcile,
    onRequested,
    running: (cardId: string) => runs.has(cardId),
  };
};

export type BoardCardSetupRuns = ReturnType<typeof makeBoardCardSetup>;

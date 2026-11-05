/**
 * The CI passes the board is running (T3O-44): one background fiber per card,
 * each holding a concurrency slot against the board and worker limits (never a
 * provider's), queued when no slot is free.
 *
 * Owned by the supervisor reactor, which decides what a pass's result means;
 * this only runs passes and reports. Progress is recorded straight from the
 * pass's fiber (each record is one decider command); the end of a pass goes
 * back through the reactor's serial worker via `onFinished`.
 */
import {
  BOARD_SEED_STAGE_IDS,
  ProviderInstanceId,
  type BoardCardId,
  type BoardCiStepDefinition,
  type BoardCommand,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";

import type {
  BoardConcurrencyLimit,
  BoardSlotKey,
  BoardStepSlotsShape,
} from "../BoardStepSlots.ts";
import { boardCiLogDir, type BoardCiRunnerShape, type BoardCiRunResult } from "./BoardCiRunner.ts";

/** The slot key's instance for a CI pass: CI holds no provider's slot, so its
    per-instance cap never applies. */
export const BOARD_CI_SLOT_INSTANCE = ProviderInstanceId.make("board-ci");

export interface BoardCiPassRequest {
  readonly cardId: BoardCardId;
  readonly runId: string;
  readonly worktreePath: string;
  readonly workerId: BoardWorkerId;
  readonly steps: ReadonlyArray<BoardCiStepDefinition>;
  readonly limits: BoardConcurrencyLimit;
}

export interface BoardCiPassFinished {
  readonly cardId: BoardCardId;
  readonly runId: string;
  readonly outcome: BoardCiRunResult;
}

export interface BoardCiPassesDeps {
  readonly runner: BoardCiRunnerShape;
  readonly slots: BoardStepSlotsShape;
  readonly dispatch: (command: BoardCommand) => Effect.Effect<void>;
  readonly commandId: (tag: string) => Effect.Effect<BoardCommand["commandId"]>;
  readonly nowIso: Effect.Effect<string>;
  /** Called on the pass's fiber when every step has run or one has failed. */
  readonly onFinished: (finished: BoardCiPassFinished) => Effect.Effect<void>;
}

export interface BoardCiPasses {
  /** Start a pass now if a slot is free (true), or queue it (false). */
  readonly start: (request: BoardCiPassRequest) => Effect.Effect<boolean>;
  /** Start queued passes while slots are free, oldest first. */
  readonly admitQueued: Effect.Effect<void>;
  /** Stop the card's pass, running or queued, recording nothing; returns the
      run id it stopped, or null. */
  readonly cancel: (cardId: BoardCardId) => Effect.Effect<string | null>;
  /** The card's pass in flight or queued. */
  readonly current: (cardId: BoardCardId) => string | null;
  /** Resolves once no pass fiber is running (tests drain on it). */
  readonly awaitIdle: Effect.Effect<void>;
  /** Whether any pass is running now. */
  readonly busy: () => boolean;
}

export const makeBoardCiPasses = Effect.fn("makeBoardCiPasses")(function* (
  deps: BoardCiPassesDeps,
) {
  const fibers = yield* FiberSet.make<void, never>();
  const running = new Map<
    string,
    { readonly runId: string; readonly fiber: Fiber.Fiber<void>; readonly key: BoardSlotKey }
  >();
  const queued = new Map<string, BoardCiPassRequest>();

  const slotKey = (request: BoardCiPassRequest): BoardSlotKey => ({
    workerId: request.workerId,
    providerInstanceId: BOARD_CI_SLOT_INSTANCE,
  });

  const record = (request: BoardCiPassRequest, index: number, step: unknown) =>
    Effect.gen(function* () {
      yield* deps.dispatch({
        type: "board.card.record-ci",
        commandId: yield* deps.commandId("ci-step"),
        cardId: request.cardId,
        action: {
          kind: "step",
          runId: request.runId,
          index,
          step: step as Extract<
            Extract<BoardCommand, { type: "board.card.record-ci" }>["action"],
            { kind: "step" }
          >["step"],
        },
        createdAt: yield* deps.nowIso,
      });
    });

  const launch = (request: BoardCiPassRequest) =>
    Effect.gen(function* () {
      const key = slotKey(request);
      const pass = deps.runner
        .run(
          {
            runId: request.runId,
            cwd: request.worktreePath,
            steps: request.steps,
            logDir: boardCiLogDir(request.worktreePath, request.runId),
          },
          (progress) => record(request, progress.index, progress.step),
        )
        .pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              const entry = running.get(String(request.cardId));
              if (entry?.runId === request.runId) running.delete(String(request.cardId));
              return deps.slots.release(key);
            }),
          ),
          Effect.flatMap((outcome) =>
            deps.onFinished({ cardId: request.cardId, runId: request.runId, outcome }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("board CI pass failed", {
                  cardId: request.cardId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      const fiber = yield* FiberSet.run(fibers, pass, { startImmediately: false });
      running.set(String(request.cardId), { runId: request.runId, fiber, key });
    });

  const tryStart = (request: BoardCiPassRequest) =>
    Effect.gen(function* () {
      const admission = yield* deps.slots.acquire(slotKey(request), {
        ...request.limits,
        perInstance: null,
      });
      if (!admission.admitted) return false;
      yield* launch(request);
      return true;
    });

  const start: BoardCiPasses["start"] = (request) =>
    Effect.gen(function* () {
      queued.delete(String(request.cardId));
      if (yield* tryStart(request)) return true;
      queued.set(String(request.cardId), request);
      return false;
    });

  const admitQueued: BoardCiPasses["admitQueued"] = Effect.gen(function* () {
    for (const [cardId, request] of [...queued]) {
      if (!(yield* tryStart(request))) return;
      // The runner's first step report moves the card from queued to running.
      queued.delete(cardId);
    }
  });

  const cancel: BoardCiPasses["cancel"] = (cardId) =>
    Effect.gen(function* () {
      const waiting = queued.get(String(cardId));
      if (waiting !== undefined) {
        queued.delete(String(cardId));
        return waiting.runId;
      }
      const entry = running.get(String(cardId));
      if (entry === undefined) return null;
      running.delete(String(cardId));
      yield* Fiber.interrupt(entry.fiber);
      return entry.runId;
    });

  return {
    start,
    admitQueued,
    cancel,
    current: (cardId) =>
      running.get(String(cardId))?.runId ?? queued.get(String(cardId))?.runId ?? null,
    awaitIdle: FiberSet.awaitEmpty(fibers),
    busy: () => running.size > 0,
  } satisfies BoardCiPasses;
});

/** The CI stage's id, re-exported for the reactor's few CI checks. */
export const BOARD_CI_STAGE_ID = BOARD_SEED_STAGE_IDS.ci;

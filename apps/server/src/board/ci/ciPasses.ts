/**
 * The CI passes the board is running (T3O-44): one background fiber per card,
 * each holding a concurrency slot against the board and worker limits (never a
 * provider's), queued when no slot is free.
 *
 * Owned by the supervisor reactor, which decides what a pass's result means;
 * this only runs passes and reports. Progress is recorded straight from the
 * pass's fiber (each record is one decider command); the end of a pass goes
 * back through the reactor's serial worker via `onFinished`.
 *
 * T3O-59: a pass's entry outlives its fiber. When the fiber ends it is marked
 * `finishing` and stays until the reactor claims its result by the launch's
 * token and settles it, so the card never looks idle while a result is still
 * on its way, and a duplicate report can't be handled twice.
 */
import {
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
  /** The pass index of `steps[0]` (T3O-49): a pass runs its script groups
      in segments between agent and forge steps. */
  readonly indexOffset?: number;
  /** False runs every step even after a failure (T3O-57). Absent is true. */
  readonly stopOnFailure?: boolean;
  readonly limits: BoardConcurrencyLimit;
  /** Where the steps run; this server's runner when absent. */
  readonly runner?: BoardCiRunnerShape;
}

export interface BoardCiPassFinished {
  readonly cardId: BoardCardId;
  readonly runId: string;
  /** The launch this result is from: segments of a pass share its run id. */
  readonly token: number;
  /** `failedIndex` is a pass index (the segment's offset applied). */
  readonly outcome: BoardCiRunResult;
  /** The pass index after the segment's last step. */
  readonly segmentEnd: number;
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
  /** Start every queued pass that has a free slot, oldest first. */
  readonly admitQueued: Effect.Effect<void>;
  /** Stop the card's pass, running, finishing or queued, recording nothing;
      returns the run id it stopped, or null. The fiber is interrupted on a
      fiber of its own, so this never waits on it. */
  readonly cancel: (cardId: BoardCardId) => Effect.Effect<string | null>;
  /** The card's pass in flight, finishing or queued. */
  readonly current: (cardId: BoardCardId) => string | null;
  /** Take the result of launch `token` for handling: true only once, and
      only while that launch's entry is finishing. */
  readonly claim: (cardId: BoardCardId, token: number) => boolean;
  /** Drop launch `token`'s entry, unless a newer launch has replaced it. */
  readonly settle: (cardId: BoardCardId, token: number) => void;
  /** Resolves once no pass fiber is running (tests drain on it). */
  readonly awaitIdle: Effect.Effect<void>;
  /** Whether any pass fiber is running now. */
  readonly busy: () => boolean;
}

interface RunningPass {
  readonly runId: string;
  readonly token: number;
  readonly fiber: Fiber.Fiber<void>;
  readonly key: BoardSlotKey;
  state: "running" | "finishing" | "claimed";
  slotHeld: boolean;
}

export const makeBoardCiPasses = Effect.fn("makeBoardCiPasses")(function* (
  deps: BoardCiPassesDeps,
) {
  const fibers = yield* FiberSet.make<void, never>();
  const running = new Map<string, RunningPass>();
  const queued = new Map<string, BoardCiPassRequest>();
  let nextToken = 0;

  const releaseSlot = (entry: RunningPass) =>
    Effect.suspend(() => {
      if (!entry.slotHeld) return Effect.void;
      entry.slotHeld = false;
      return deps.slots.release(entry.key);
    });

  /** This launch still owns the card's entry: nothing cancelled it. */
  const owns = (cardId: BoardCardId, token: number) => running.get(String(cardId))?.token === token;

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
          index: index + (request.indexOffset ?? 0),
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
      nextToken += 1;
      const token = nextToken;
      const pass = (request.runner ?? deps.runner)
        .run(
          {
            runId: request.runId,
            cwd: request.worktreePath,
            steps: request.steps,
            logDir: boardCiLogDir(request.worktreePath, request.runId),
            ...(request.indexOffset === undefined ? {} : { indexOffset: request.indexOffset }),
            ...(request.stopOnFailure === false ? { stopOnFailure: false } : {}),
          },
          (progress) => record(request, progress.index, progress.step),
        )
        .pipe(
          // The slot is free once the run ends; the entry stays, finishing,
          // until the reactor has handled the result.
          Effect.ensuring(
            Effect.suspend(() => {
              const entry = running.get(String(request.cardId));
              if (entry?.token !== token) return Effect.void;
              entry.state = "finishing";
              return releaseSlot(entry);
            }),
          ),
          // A defect in the run still reports, as a pass that could not run,
          // so the card never sits in CI "running" with no fiber behind it.
          // So does an interrupt nobody asked for: a worker connection that
          // renews, restarts or goes away interrupts the stream. Only
          // `cancel`, which drops the entry first, ends a pass silently.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? owns(request.cardId, token)
                ? Effect.succeed<BoardCiRunResult>({
                    result: "unavailable",
                    failedIndex: null,
                    detail: "The worker connection closed mid-run. Retry CI.",
                  })
                : Effect.failCause(cause)
              : Effect.logWarning("board CI pass failed", {
                  cardId: request.cardId,
                  cause: Cause.pretty(cause),
                }).pipe(
                  Effect.as<BoardCiRunResult>({
                    result: "unavailable",
                    failedIndex: null,
                    detail: "CI stopped on an internal error.",
                  }),
                ),
          ),
          Effect.flatMap((outcome) =>
            deps.onFinished({
              cardId: request.cardId,
              runId: request.runId,
              token,
              outcome:
                outcome.failedIndex === null
                  ? outcome
                  : { ...outcome, failedIndex: outcome.failedIndex + (request.indexOffset ?? 0) },
              segmentEnd: (request.indexOffset ?? 0) + request.steps.length,
            }),
          ),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("board CI pass result could not be handled", {
                  cardId: request.cardId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
      const fiber = yield* FiberSet.run(fibers, pass, { startImmediately: false });
      running.set(String(request.cardId), {
        runId: request.runId,
        token,
        fiber,
        key,
        state: "running",
        slotHeld: true,
      });
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
    for (const [cardId, request] of queued) {
      // Slots are capped per worker, so a full worker must not hold back the rest.
      if (!(yield* tryStart(request))) continue;
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
      // The slot is free now, so whatever the caller schedules next sees it.
      yield* releaseSlot(entry);
      if (entry.state === "running") {
        yield* FiberSet.run(fibers, Fiber.interrupt(entry.fiber).pipe(Effect.asVoid));
      }
      return entry.runId;
    });

  const claim: BoardCiPasses["claim"] = (cardId, token) => {
    const entry = running.get(String(cardId));
    if (entry?.token !== token || entry.state !== "finishing") return false;
    entry.state = "claimed";
    return true;
  };

  const settle: BoardCiPasses["settle"] = (cardId, token) => {
    if (owns(cardId, token)) running.delete(String(cardId));
  };

  return {
    start,
    admitQueued,
    cancel,
    current: (cardId) =>
      running.get(String(cardId))?.runId ?? queued.get(String(cardId))?.runId ?? null,
    claim,
    settle,
    awaitIdle: FiberSet.awaitEmpty(fibers),
    busy: () => [...running.values()].some((entry) => entry.state === "running"),
  } satisfies BoardCiPasses;
});

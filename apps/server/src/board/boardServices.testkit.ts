/**
 * Doubles for the board's own services (T3O-56), for suites that stub the
 * supervisor's world rather than build the real stack.
 *
 * `boardEngineDouble` hands every dispatch to the suite's own handler — the one
 * that already records and folds commands for upstream's engine double — and
 * reads the board off the suite's model. `inertBoardQueries` answers every read
 * with "nothing there", which is what a suite that never seeded a todo row,
 * message or brief already assumed.
 */
import type { BoardState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BoardEngine, type BoardEngineShape } from "./BoardEngine.ts";
import { BoardQueries } from "./BoardQueries.ts";
import type { BoardQueriesShape } from "./projection.ts";

export const inertBoardQueries = (overrides?: Partial<BoardQueriesShape>): BoardQueriesShape => ({
  loadBoardState: () => Effect.succeed(null),
  boardShellSnapshot: () =>
    Effect.succeed({
      snapshotSequence: 0,
      cards: [],
      labels: [],
      stages: [],
      cardThreads: [],
      providerLimits: [],
    }),
  boardArchivedCards: () => Effect.succeed([]),
  boardCardDetail: () => Effect.succeed(null),
  boardCardActivity: () => Effect.succeed([]),
  boardCardBrief: () => Effect.succeed(null),
  boardPlanBody: () => Effect.succeed(null),
  boardCardThreads: () => Effect.succeed([]),
  boardAllCardThreads: () => Effect.succeed([]),
  boardCardIdForThread: () => Effect.succeed(null),
  boardThreadTodo: () => Effect.succeed(null),
  boardLatestAssistantMessage: () => Effect.succeed(null),
  boardThreadLastSignalAt: () => Effect.succeed(null),
  boardThreadPendingTurnStartAt: () => Effect.succeed(null),
  boardSweepThreadTodos: () => Effect.void,
  boardProjects: () => Effect.succeed([]),
  boardThread: () => Effect.succeed(null),
  ...overrides,
});

export const boardEngineDouble = (input: {
  readonly dispatch: (command: never) => Effect.Effect<{ readonly sequence: number }>;
  readonly board: Effect.Effect<BoardState | undefined>;
}): BoardEngineShape =>
  ({
    dispatch: input.dispatch as unknown as BoardEngineShape["dispatch"],
    getReadModel: Effect.map(input.board, (board) => (board === undefined ? {} : { board })),
    latestSequence: Effect.succeed(0),
    streamBoardEvents: () => Stream.never,
    liveBoardEvents: Stream.never,
    subscribeBoardEvents: Effect.succeed(Stream.never),
  }) satisfies BoardEngineShape;

/** Both doubles as one layer. */
export const boardServicesTestLayer = (input: {
  readonly engine: BoardEngineShape;
  readonly queries?: BoardQueriesShape;
}) =>
  Layer.mergeAll(
    Layer.succeed(BoardEngine, input.engine),
    Layer.succeed(BoardQueries, input.queries ?? inertBoardQueries()),
  );

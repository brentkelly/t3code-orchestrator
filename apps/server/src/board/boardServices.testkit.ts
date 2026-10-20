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
import { ThreadGateway, type ThreadGatewayShape } from "./ThreadGateway.ts";
import { inertThreadGateway } from "./threadGateway.testkit.ts";

export const inertBoardQueries = (overrides?: Partial<BoardQueriesShape>): BoardQueriesShape => ({
  loadBoardState: () => Effect.succeed(null),
  boardCardDetail: () => Effect.succeed(null),
  boardCardActivity: () => Effect.succeed([]),
  boardCardBrief: () => Effect.succeed(null),
  boardPlanBody: () => Effect.succeed(null),
  boardCardThreads: () => Effect.succeed([]),
  boardCardIdForThread: () => Effect.succeed(null),
  boardThreadTodo: () => Effect.succeed(null),
  boardSweepThreadTodos: () => Effect.void,
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

/** The doubles as one layer; the thread gateway knows nothing unless given. */
export const boardServicesTestLayer = (input: {
  readonly engine: BoardEngineShape;
  readonly queries?: BoardQueriesShape;
  readonly threads?: ThreadGatewayShape;
}) =>
  Layer.mergeAll(
    Layer.succeed(BoardEngine, input.engine),
    Layer.succeed(BoardQueries, input.queries ?? inertBoardQueries()),
    Layer.succeed(ThreadGateway, input.threads ?? inertThreadGateway()),
  );

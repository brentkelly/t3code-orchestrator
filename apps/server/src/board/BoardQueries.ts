/**
 * Every board read as one service, so callers depend on the board rather than
 * on upstream's `ProjectionSnapshotQuery`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { makeBoardQueries, type BoardQueriesShape } from "./projection.ts";

export class BoardQueries extends Context.Service<BoardQueries, BoardQueriesShape>()(
  "t3/board/BoardQueries",
) {}

export const BoardQueriesLive = Layer.effect(
  BoardQueries,
  Effect.gen(function* () {
    return makeBoardQueries(yield* SqlClient.SqlClient);
  }),
);

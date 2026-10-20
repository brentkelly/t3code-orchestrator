/**
 * The board's query service (T3O-56).
 *
 * Every board read — card detail, activity, briefs, plan bodies, thread todos,
 * and the few facts the board needs about upstream threads and projects — as
 * one service, so callers depend on the board rather than on upstream's
 * `ProjectionSnapshotQuery`.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

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

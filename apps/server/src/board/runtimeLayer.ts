/**
 * The board's runtime services (T3O-56): its engine, its queries, and its
 * read-only tail of upstream's thread events. One layer, so the server wires
 * the board in with one line.
 */
import * as Layer from "effect/Layer";

import { BoardEngineLive } from "./BoardEngine.ts";
import { BoardQueriesLive } from "./BoardQueries.ts";
import { BoardThreadTailLive } from "./boardThreadTail.ts";

export const BoardRuntimeLive = Layer.mergeAll(BoardEngineLive, BoardThreadTailLive).pipe(
  Layer.provideMerge(BoardQueriesLive),
);

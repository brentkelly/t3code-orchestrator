// T3O-59: the board's first boot under orchestration-v2, recorded.
//
// Changes no schema. Its row in the board ledger is the marker
// `backupBoardDatabaseBeforeV2` reads: a board ledger without it was last
// written by a v1 build, so its file is copied once before a v2 build changes
// anything, and a rollback to a v1 build has board data it can read.
import * as Effect from "effect/Effect";

export default Effect.void;

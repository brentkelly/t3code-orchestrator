/**
 * T3o board migration registry.
 *
 * Spread into the tail of `migrationEntries` in the upstream
 * `persistence/Migrations.ts`; new board migrations register here so the
 * seam never grows. Ids are 900+ (colliding with an upstream migration id
 * corrupts the applied-migration ledger — data loss, not a merge conflict),
 * and `Migrator.fromRecord` sorts by id, so tail position is irrelevant.
 */
import Migration0900 from "../persistence/Migrations/900_BoardCards.ts";

export const BOARD_MIGRATIONS = [[900, "BoardCards", Migration0900]] as const;

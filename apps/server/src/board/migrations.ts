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
import Migration0901 from "../persistence/Migrations/901_BoardCardBodies.ts";
import Migration0902 from "../persistence/Migrations/902_BoardCardThreadLinks.ts";
import Migration0903 from "../persistence/Migrations/903_BoardCardsColumns.ts";

export const BOARD_MIGRATIONS = [
  [900, "BoardCards", Migration0900],
  [901, "BoardCardBodies", Migration0901],
  [902, "BoardCardThreadLinks", Migration0902],
  [903, "BoardCardsColumns", Migration0903],
] as const;

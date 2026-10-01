/**
 * T3o: durable state a board command is decided against (T3O-53).
 *
 * Called by the orchestration engine inside its serial command loop, right
 * before the decider runs — upstream's own `userInputActivity` pre-read is the
 * precedent. Only an incremental or version-guarded brief edit needs anything:
 * the brief body never rides the read model (D8), and reading it here, rather
 * than in the MCP handler, is what makes append, section replace and the
 * expected-version check atomic against every other write to the card.
 */
import * as Effect from "effect/Effect";

import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { OrchestrationCommand } from "@t3tools/contracts";
import { boardCommandNeedsBrief, type BoardDecisionContext } from "./decider.ts";
import { boardSnapshotQueryMethodsOf } from "./projection.ts";

export const loadBoardDecisionContext = (
  command: OrchestrationCommand,
  snapshotQuery: ProjectionSnapshotQueryShape,
) =>
  Effect.gen(function* () {
    if (!boardCommandNeedsBrief(command)) return undefined;
    // Absent only on a snapshot query assembled without the board factory
    // (upstream test mocks); the decider then rejects the edit as unloaded.
    const board = boardSnapshotQueryMethodsOf(snapshotQuery);
    if (board === null) return undefined;
    const brief = yield* board.boardCardBrief(command.cardId);
    return { brief } satisfies BoardDecisionContext;
  });

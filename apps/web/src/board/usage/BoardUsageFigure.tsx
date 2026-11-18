/** A Done card's cost on its face (T3O-77): muted at 500, full ink at 600 once it
    reaches the board's threshold. Weight, never colour. */
import type { BoardCardUsageSummary } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { BoardHint } from "../BoardHint";
import { formatBoardUsageCost, isBoardUsageEmphasized } from "./boardUsageFormat";

export function BoardCardCostFigure({
  usage,
  emphasisUsd,
}: {
  readonly usage: BoardCardUsageSummary | null | undefined;
  readonly emphasisUsd: number;
}) {
  const figure = formatBoardUsageCost(usage, { noUsageWord: true, wholeDollarsFrom: 10 });
  const exact = formatBoardUsageCost(usage, { noUsageWord: true });
  const emphasized = isBoardUsageEmphasized(usage, emphasisUsd);
  return (
    <BoardHint
      label={`${exact.text === figure.text ? "" : `${exact.text}. `}${figure.tooltip} Open the card for the breakdown.`}
    >
      <span
        aria-label={`Cost ${exact.text}`}
        className={cn(
          "ml-auto shrink-0 whitespace-nowrap text-board-10-5 tabular-nums",
          emphasized ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
        )}
        data-board-card-cost
      >
        {figure.text}
      </span>
    </BoardHint>
  );
}

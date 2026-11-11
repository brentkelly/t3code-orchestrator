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
  const figure = formatBoardUsageCost(usage, { noUsageWord: true });
  const emphasized = isBoardUsageEmphasized(usage, emphasisUsd);
  return (
    <BoardHint label={`${figure.tooltip} Open the card for the breakdown.`}>
      <span
        aria-label={`Cost ${figure.text}`}
        className={cn(
          "shrink-0 whitespace-nowrap font-mono text-[10.5px] tabular-nums",
          emphasized ? "font-semibold text-foreground" : "font-medium text-muted-foreground",
        )}
        data-board-card-cost
      >
        {figure.text}
      </span>
    </BoardHint>
  );
}

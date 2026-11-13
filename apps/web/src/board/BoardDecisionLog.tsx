/**
 * The Summary pane's decision log body, filterable to important or unclear. The
 * pane's section row owns open and close. Unclear is violet (waits on a human);
 * important is a neutral outline, since blue would claim it is running.
 */
import { useState } from "react";

import { cn } from "../lib/utils";
import type { BoardDecisionLogRow, BoardDecisionLogView } from "./boardDecisionLog";

const ACTION_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-lg border border-input bg-popover px-2.5 text-board-12 font-medium text-foreground shadow-xs hover:bg-accent";

type Filter = "all" | "important" | "unclear";

const FILTERS: ReadonlyArray<{
  readonly id: Filter;
  readonly label: string;
  readonly matches: (row: BoardDecisionLogRow) => boolean;
}> = [
  { id: "all", label: "All", matches: () => true },
  { id: "important", label: "Important", matches: (row) => row.flag === "important" },
  { id: "unclear", label: "Unclear", matches: (row) => row.flag === "unclear" },
];

export function BoardDecisionLog({
  view,
  onSendBack,
  onFollowUp,
}: {
  readonly view: BoardDecisionLogView;
  readonly onSendBack?: (() => void) | undefined;
  readonly onFollowUp?: (() => void) | undefined;
}) {
  const [choice, setChoice] = useState<Filter>("all");
  const filters = FILTERS.map((filter) => ({
    ...filter,
    count: view.rows.filter(filter.matches).length,
  })).filter((filter) => filter.id === "all" || filter.count > 0);
  // A filter whose rows went away falls back to All.
  const active = filters.find((filter) => filter.id === choice) ?? filters[0]!;
  const numbered = view.rows.map((row, index) => ({ row, number: index + 1 }));
  const shown = numbered.filter((entry) => active.matches(entry.row));
  return (
    <div className="flex flex-col gap-3">
      {view.autoPlanned ? (
        <p className="text-board-12/normal text-pretty text-muted-foreground">
          Auto-planned. The plan was approved without you, including any decisions marked unclear.
        </p>
      ) : null}
      {view.canAct && (onSendBack !== undefined || onFollowUp !== undefined) ? (
        <div className="flex flex-wrap items-center gap-2">
          {onSendBack === undefined ? null : (
            <button className={ACTION_CLASS} onClick={onSendBack} type="button">
              Send back to build with changes
            </button>
          )}
          {onFollowUp === undefined ? null : (
            <button className={ACTION_CLASS} onClick={onFollowUp} type="button">
              Create follow-up card
            </button>
          )}
        </div>
      ) : null}
      {filters.length > 1 ? (
        <div className="flex gap-1 self-start rounded-lg bg-accent p-0.75">
          {filters.map((filter) => (
            <button
              aria-pressed={filter.id === active.id}
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-md px-2.25 text-board-11-5 font-medium text-foreground",
                filter.id === active.id ? "bg-card shadow-xs" : "hover:bg-card/60",
              )}
              key={filter.id}
              onClick={() => setChoice(filter.id)}
              type="button"
            >
              {filter.label}
              <span className="font-normal text-muted-foreground">{filter.count}</span>
            </button>
          ))}
        </div>
      ) : null}
      <ol className="flex flex-col">
        {shown.map(({ row, number }) => (
          <li
            className="grid grid-cols-[26px_minmax(0,1fr)_auto] items-baseline gap-2.5 border-t border-border py-2"
            data-flag={row.flag}
            key={row.id}
          >
            <span className="font-mono text-board-11-5 font-medium text-muted-foreground">
              {number}
            </span>
            <div className="flex min-w-0 flex-col gap-0.75">
              <span className="text-board-11-5 leading-board-1-45 text-pretty text-muted-foreground">
                {row.question}
              </span>
              <span className="text-board-13/normal font-medium text-pretty text-foreground">
                {row.decision}
              </span>
              <span className="text-board-12/normal text-pretty text-muted-foreground">
                {row.reason}
              </span>
            </div>
            <span className="flex items-center gap-1">
              {row.flag === "normal" ? null : (
                <span
                  className={cn(
                    "inline-flex items-center whitespace-nowrap rounded-md px-1.75 py-0.5 text-board-11 font-medium",
                    row.flag === "unclear"
                      ? "bg-attention/12 text-attention-foreground"
                      : "border border-input text-foreground",
                  )}
                >
                  {row.flag === "unclear" ? "Unclear" : "Important"}
                </span>
              )}
              <span className="whitespace-nowrap text-board-10-5 font-medium text-muted-foreground">
                {row.who}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

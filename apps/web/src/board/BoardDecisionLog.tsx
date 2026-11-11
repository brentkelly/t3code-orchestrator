/**
 * The Summary pane's decision log: every decision a planning session
 * recorded, unclear first. Unclear rows wear violet because they wait on a
 * human's review (docs/t3o/status-colours.md); important ones a neutral
 * outline.
 */
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "../lib/utils";
import type { BoardDecisionLogView } from "./boardDecisionLog";

const ACTION_CLASS =
  "inline-flex h-7 items-center gap-1.5 rounded-lg border border-input bg-popover px-2.5 text-[12px] font-medium text-foreground shadow-xs hover:bg-accent";

export function BoardDecisionLog({
  view,
  open: openChoice,
  onOpenChange,
  onSendBack,
  onFollowUp,
}: {
  readonly view: BoardDecisionLogView;
  /** The human's choice, or null for the default rule. */
  readonly open: boolean | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSendBack?: (() => void) | undefined;
  readonly onFollowUp?: (() => void) | undefined;
}) {
  const open = openChoice ?? view.defaultOpen;
  return (
    <div className="flex flex-col gap-2.5">
      <button
        aria-expanded={open}
        className="flex items-center gap-2 text-left"
        onClick={() => onOpenChange(!open)}
        type="button"
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-[12px] font-semibold text-foreground">Decision log</span>
        <span className="text-[11.5px] text-muted-foreground">{view.count}</span>
        {view.unclear === null ? null : (
          <span className="text-[11.5px] font-medium text-attention-foreground">
            {view.unclear}
          </span>
        )}
        {view.unclear !== null && view.important !== null ? (
          <span className="text-[11.5px] text-muted-foreground">·</span>
        ) : null}
        {view.important === null ? null : (
          <span className="text-[11.5px] font-medium text-muted-foreground">{view.important}</span>
        )}
      </button>
      {open ? (
        <>
          {view.autoPlanned ? (
            <p className="text-[12px]/[1.5] text-pretty text-muted-foreground">
              Auto-planned. The plan was approved without you, including any decisions marked
              unclear.
            </p>
          ) : null}
          <ul className="flex flex-col overflow-hidden rounded-[10px] border border-border">
            {view.rows.map((row) => (
              <li
                className={cn(
                  "flex flex-col gap-[3px] border-t border-border px-3 py-2.5 first:border-t-0",
                  row.flag === "unclear"
                    ? "bg-[color-mix(in_srgb,var(--attention)_6%,var(--card))]"
                    : "bg-card",
                )}
                data-flag={row.flag}
                key={row.id}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 text-[11.5px]/[1.45] text-pretty text-muted-foreground">
                    {row.question}
                  </span>
                  {row.flag === "normal" ? null : (
                    <span
                      className={cn(
                        "inline-flex h-[17px] shrink-0 items-center rounded-[5px] px-1.5 text-[10px] font-medium uppercase tracking-[0.03em]",
                        row.flag === "unclear"
                          ? "bg-attention/16 text-attention-foreground"
                          : "border border-input text-foreground",
                      )}
                    >
                      {row.flag === "unclear" ? "Unclear" : "Important"}
                    </span>
                  )}
                  <span className="shrink-0 text-[10.5px] font-medium text-muted-foreground">
                    {row.who}
                  </span>
                </div>
                <div className="text-[13px]/[1.5] font-medium text-pretty text-foreground">
                  {row.decision}
                </div>
                <div className="text-[12px]/[1.5] text-pretty text-muted-foreground">
                  {row.reason}
                </div>
              </li>
            ))}
          </ul>
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
        </>
      ) : null}
    </div>
  );
}

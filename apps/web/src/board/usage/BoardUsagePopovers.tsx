/**
 * The board's two spend popovers (T3O-77): the header chip's "spend in view", and a
 * group's per-child totals. Cost is plain ink with grey bars; status hues stay off it.
 */
import type { BoardCardShell, BoardCardUsageSummary } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { cn } from "../../lib/utils";
import { BoardHint } from "../BoardHint";
import { boardGroupUsage, type BoardUsageInView } from "./boardUsageViews";
import {
  boardUsageProviderLabel,
  formatBoardTokens,
  formatBoardUsageCost,
} from "./boardUsageFormat";

function Bar({ value, max }: { readonly value: number; readonly max: number }) {
  return (
    <span className="block h-1 overflow-hidden rounded-[2px] bg-foreground/6">
      <span
        className="block h-full rounded-[2px] bg-foreground/40"
        style={{ width: `${max <= 0 ? 0 : Math.round((value / max) * 100)}%` }}
      />
    </span>
  );
}

const costOf = (usage: BoardCardUsageSummary | null | undefined) =>
  usage?.costKnown === true ? usage.costUsd : 0;

/** A provider's line: one summed from cards carries no `costKnown`, so a zero that is
    all unpriced or unreported reads as such rather than as $0. */
function providerCostText(provider: BoardCardUsageSummary["providers"][number]): string {
  if (provider.costUsd > 0 || provider.partial !== true) {
    return formatBoardUsageCost({ ...provider, costKnown: true }).text;
  }
  return provider.tokens === 0 ? "—" : "unpriced";
}

const SECTION_HEADING =
  "text-[10px] font-semibold uppercase tracking-[0.07em] text-muted-foreground";

/** The header chip: what the cards in view have cost, following the filter. */
export function BoardUsageChip({ inView }: { readonly inView: BoardUsageInView }) {
  if (inView.total === null) return null;
  const figure = formatBoardUsageCost(inView.total);
  const maxColumn = Math.max(...inView.byColumn.map((column) => costOf(column.usage)));
  const providers = inView.total.providers;
  return (
    <Popover>
      <PopoverTrigger
        aria-label={`Spend across the cards in view: ${figure.text}`}
        className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-input bg-popover px-2 shadow-xs/5 hover:bg-accent data-popup-open:bg-accent sm:h-6.5"
      >
        <span className="font-mono text-[12px] font-semibold tabular-nums text-foreground">
          {figure.text}
        </span>
        <span className="text-[12px] text-muted-foreground max-sm:sr-only">in view</span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[336px] p-3">
        <div className="flex flex-col gap-2.5" data-board-usage-in-view>
          <div className="flex items-baseline gap-2">
            <span className="text-[12.5px] font-semibold text-foreground">Spend in view</span>
            <span className="text-[11px] text-muted-foreground">
              {inView.cardCount} {inView.cardCount === 1 ? "card" : "cards"}
            </span>
            <span className="flex-1" />
            <span className="font-mono text-[12.5px] font-semibold tabular-nums text-foreground">
              {figure.text}
            </span>
          </div>
          {inView.byColumn.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              <span className={SECTION_HEADING}>By column</span>
              {inView.byColumn.map((column) => (
                <div
                  className="grid grid-cols-[112px_minmax(0,1fr)_62px] items-center gap-2"
                  key={column.stageId}
                >
                  <span className="truncate text-[11.5px] text-foreground">{column.label}</span>
                  <Bar max={maxColumn} value={costOf(column.usage)} />
                  <span className="text-right font-mono text-[11px] font-medium tabular-nums text-foreground">
                    {formatBoardUsageCost(column.usage).text}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {providers.length > 0 ? (
            <div className="flex flex-col gap-1.5 border-t border-border pt-2">
              <span className={SECTION_HEADING}>By provider</span>
              {providers.map((provider) => (
                <div className="flex items-center gap-2" key={provider.provider}>
                  <span className="text-[11.5px] text-foreground">
                    {boardUsageProviderLabel(provider.provider)}
                  </span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    {provider.tokens === 0
                      ? "no usage"
                      : `${formatBoardTokens(provider.tokens)} tok`}
                  </span>
                  <span className="flex-1" />
                  <span className="font-mono text-[11px] font-medium tabular-nums text-foreground">
                    {providerCostText(provider)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {inView.partialCount > 0 ? (
            <p className="text-[11px]/[1.5] text-pretty text-muted-foreground">
              {inView.partialCount} {inView.partialCount === 1 ? "card has" : "cards have"}{" "}
              unpriced steps or no usage reported, so the total is a lower bound.
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * A group's spend, and on click the per-child popover. A nested group is one row with
 * a chevron that drills in; the list stays flat, never a tree. A row opens that card.
 */
export function BoardGroupUsageButton({
  shells,
  group,
  stageLabelOf,
  onOpenCard,
  trigger,
}: {
  readonly shells: ReadonlyArray<BoardCardShell>;
  readonly group: BoardCardShell;
  readonly stageLabelOf: (card: BoardCardShell) => string;
  readonly onOpenCard?: ((cardId: string) => void) | undefined;
  /** What the button shows; the figure itself by default. */
  readonly trigger?: (figure: string) => ReactNode;
}) {
  const [path, setPath] = useState<ReadonlyArray<BoardCardShell>>([]);
  const total = boardGroupUsage(shells, String(group.cardId)).total;
  if (total === null) return null;
  const figure = formatBoardUsageCost(total);
  const current = path.at(-1) ?? group;
  const usage = boardGroupUsage(shells, String(current.cardId));
  const max = Math.max(...usage.children.map((child) => costOf(child.usage)));
  const partialKeys = usage.children
    .filter((child) => child.usage?.partial === true)
    .map((child) => child.card.key);
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setPath([]);
      }}
    >
      <PopoverTrigger
        aria-label={`Spend by child: ${figure.text}`}
        className="inline-flex h-[18px] shrink-0 cursor-pointer items-center gap-1.5 rounded-[5px] border border-transparent px-[5px] font-mono text-[10.5px] font-semibold tabular-nums text-foreground hover:bg-accent data-popup-open:border-input data-popup-open:bg-accent"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
      >
        {trigger === undefined ? figure.text : trigger(figure.text)}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[384px] p-0">
        <div
          className="flex flex-col"
          data-board-group-usage
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="presentation"
        >
          <div className="flex items-baseline gap-2 px-3 pb-2 pt-[11px]">
            {path.length > 0 ? (
              <button
                aria-label="Up one level"
                className="inline-flex size-4 items-center justify-center self-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                onClick={() => setPath((previous) => previous.slice(0, -1))}
                type="button"
              >
                <ChevronLeftIcon className="size-3" />
              </button>
            ) : null}
            <span className="text-[12.5px] font-semibold text-foreground">
              {path.length > 0 ? `${current.key} by child` : "Spend by child"}
            </span>
            <span className="text-[11px] text-muted-foreground">
              {usage.children.length} {usage.children.length === 1 ? "card" : "cards"}
            </span>
            <span className="flex-1" />
            <span className="font-mono text-[12.5px] font-semibold tabular-nums text-foreground">
              {formatBoardUsageCost(usage.total).text}
            </span>
          </div>
          {usage.children.map((child) => {
            const childFigure = formatBoardUsageCost(child.usage);
            return (
              <div
                className="grid grid-cols-[52px_minmax(0,1fr)_72px_66px_16px] items-center gap-2 border-t border-border/70 px-3 py-1.5 hover:bg-accent"
                data-board-group-usage-child={child.card.key}
                key={child.card.cardId}
              >
                <span className="font-mono text-[10.5px] font-medium text-muted-foreground">
                  {child.card.key}
                </span>
                <button
                  className="flex min-w-0 flex-col gap-[3px] text-left"
                  disabled={onOpenCard === undefined}
                  onClick={() => onOpenCard?.(String(child.card.cardId))}
                  type="button"
                >
                  <span className="truncate text-[11.5px] font-medium text-foreground">
                    {child.card.title}
                  </span>
                  <Bar max={max} value={costOf(child.usage)} />
                </button>
                <span className="truncate text-[10.5px] text-muted-foreground">
                  {stageLabelOf(child.card)}
                </span>
                <BoardHint label={childFigure.tooltip}>
                  <span className="text-right font-mono text-[11px] font-medium tabular-nums text-foreground">
                    {childFigure.text}
                  </span>
                </BoardHint>
                {child.isGroup ? (
                  <button
                    aria-label={`Open ${child.card.key}'s children`}
                    className="inline-flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                    onClick={() => setPath((previous) => [...previous, child.card])}
                    type="button"
                  >
                    <ChevronRightIcon className="size-3" />
                  </button>
                ) : (
                  <span />
                )}
              </div>
            );
          })}
          <div
            className={cn(
              "border-t border-border px-3 pb-2.5 pt-2 text-[10.5px]/[1.5] text-pretty text-muted-foreground",
            )}
          >
            {partialKeys.length > 0
              ? `${partialKeys.join(", ")} ${partialKeys.length === 1 ? "has" : "have"} unpriced or unreported steps, so the total is a lower bound. `
              : ""}
            {onOpenCard === undefined ? "" : "Click a row to open that card's usage."}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The Usage section's body in a card's Summary pane (T3O-77, Build Summary v3): what
 * leaves the figure partial, and a table by stage or by model. The pane's section row
 * owns open and close; the Cost tile carries the total. Figures change once per
 * finished turn and never animate.
 */
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { cn } from "../../lib/utils";
import { BoardHint } from "../BoardHint";
import type {
  BoardUsageBreakdown,
  BoardUsageColumns,
  BoardUsageStageGroup,
  BoardUsageTag,
} from "./boardUsageBreakdown";
import {
  BOARD_USAGE_UNKNOWN,
  boardUsageStageLabel,
  boardUsageStageShade,
  formatBoardTokens,
  formatBoardUsageCost,
  formatBoardUsd,
} from "./boardUsageFormat";

const GRID =
  "grid grid-cols-[minmax(0,1.25fr)_minmax(0,1.3fr)_64px_64px_76px] items-center gap-x-2.5";

function Tag({ tag }: { readonly tag: BoardUsageTag }) {
  return (
    <BoardHint label={TAG_TOOLTIP[tag]}>
      <span className="inline-flex h-4 items-center whitespace-nowrap rounded-sm border border-border bg-muted px-1.25 text-board-9-5 font-medium tracking-board-2 text-muted-foreground">
        {tag}
      </span>
    </BoardHint>
  );
}

const TAG_TOOLTIP: Record<BoardUsageTag, string> = {
  "est.": "Priced from the model price table.",
  unpriced: "Tokens reported, but this model has no price. Not counted in the total.",
  "no usage": "The provider reported no token usage for this thread. Not counted, and not $0.",
  "so far": "Still running: grows as each turn finishes.",
};

function NumberCells({
  columns,
  weight,
}: {
  readonly columns: BoardUsageColumns & { readonly known?: boolean };
  readonly weight: "normal" | "medium" | "semibold";
}) {
  const known = columns.known !== false;
  const cell = cn(
    "text-right font-mono text-board-11 tabular-nums text-foreground",
    weight === "normal" ? "font-normal" : weight === "medium" ? "font-medium" : "font-semibold",
  );
  return (
    <>
      <BoardHint label={known ? `${formatBoardTokens(columns.cached)} cached` : null}>
        <span className={cell}>
          {known ? formatBoardTokens(columns.input) : BOARD_USAGE_UNKNOWN}
        </span>
      </BoardHint>
      <span className="flex flex-col items-end gap-px">
        <span className={cell}>
          {known ? formatBoardTokens(columns.output) : BOARD_USAGE_UNKNOWN}
        </span>
        {weight === "normal" && known && columns.reasoning > 0 ? (
          <BoardHint label="Reasoning tokens, included in output">
            <span className="whitespace-nowrap font-mono text-board-9-5 text-muted-foreground">
              {formatBoardTokens(columns.reasoning)} rsn
            </span>
          </BoardHint>
        ) : null}
      </span>
    </>
  );
}

function StageRows({
  stage,
  shade,
  open,
  onToggle,
}: {
  readonly stage: BoardUsageStageGroup;
  readonly shade: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const figure = formatBoardUsageCost(stage.summary);
  return (
    <>
      <button
        aria-expanded={open}
        className={cn(GRID, "w-full border-t border-border px-3 py-2 text-left hover:bg-accent")}
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-1.25">
          <ChevronRightIcon
            className={cn("size-3 shrink-0 text-muted-foreground", open && "rotate-90")}
          />
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-xs"
            style={{ background: shade }}
          />
          <span className="truncate text-board-12 font-semibold text-foreground">
            {boardUsageStageLabel(stage)}
          </span>
        </span>
        <span className="truncate text-board-11-5 text-muted-foreground">{stage.models}</span>
        <NumberCells columns={stage} weight="medium" />
        <BoardHint
          label={stage.running ? "Includes a running step. Grows as turns finish." : figure.tooltip}
        >
          <span className="whitespace-nowrap text-right font-mono text-board-11-5 font-semibold tabular-nums text-foreground">
            {figure.text}
            {stage.running ? "*" : ""}
          </span>
        </BoardHint>
      </button>
      {open
        ? stage.lines.map((line) => (
            <div
              className={cn(
                GRID,
                "items-start border-t border-border/60 bg-foreground/2 px-3 pb-1.75 pt-1.5",
              )}
              data-usage-line={line.stepId}
              key={line.key}
            >
              <span className="flex min-w-0 items-center gap-1.5 pl-4.25 pt-px">
                {line.running ? (
                  <BoardHint label="Running">
                    <span className="size-1.75 shrink-0 rounded-full bg-info-foreground" />
                  </BoardHint>
                ) : null}
                <span className="truncate font-mono text-board-11-5 font-medium text-foreground">
                  {line.stepId}
                </span>
              </span>
              <span className="flex min-w-0 flex-col gap-px">
                <span className="truncate text-board-11-5 font-medium text-foreground">
                  {line.model}
                </span>
                <span className="truncate text-board-10-5 text-muted-foreground">
                  {line.provider}
                </span>
              </span>
              <NumberCells columns={{ ...line, known: !line.noUsage }} weight="normal" />
              <span className="flex flex-col items-end gap-0.5 pt-px">
                <span
                  className={cn(
                    "whitespace-nowrap font-mono text-board-11 font-medium tabular-nums",
                    line.costKnown ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {line.costKnown
                    ? `${line.estimated ? "≈" : ""}${formatBoardUsd(line.costUsd)}`
                    : BOARD_USAGE_UNKNOWN}
                </span>
                {line.tag === null ? null : <Tag tag={line.tag} />}
              </span>
            </div>
          ))
        : null}
    </>
  );
}

export function BoardCardUsageSection({ breakdown }: { readonly breakdown: BoardUsageBreakdown }) {
  const [view, setView] = useState<"stage" | "model">("stage");
  const [openStages, setOpenStages] = useState<ReadonlySet<string>>(new Set());
  const figure = formatBoardUsageCost(breakdown.summary, {
    steps: { estimated: breakdown.estimatedSteps, partial: breakdown.partialSteps },
  });
  const tokens = breakdown.totals.input + breakdown.totals.cached + breakdown.totals.output;
  const segmentButton = (active: boolean) =>
    cn(
      "inline-flex h-5 items-center whitespace-nowrap rounded-board-7 border px-2.25 text-board-11 font-medium",
      active
        ? "border-input bg-card text-foreground shadow-xs"
        : "border-transparent text-muted-foreground hover:text-foreground",
    );

  return (
    <div className="flex flex-col gap-3" data-board-usage-section>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-board-11-5 text-muted-foreground">
          {formatBoardTokens(tokens)} tokens · {breakdown.threadCount}{" "}
          {breakdown.threadCount === 1 ? "thread" : "threads"} · {breakdown.providerCount}{" "}
          {breakdown.providerCount === 1 ? "provider" : "providers"}
        </span>
        <span className="flex-1" />
        <div className="flex gap-0.5 rounded-lg bg-accent p-0.5">
          <button
            aria-pressed={view === "stage"}
            className={segmentButton(view === "stage")}
            onClick={() => setView("stage")}
            type="button"
          >
            By stage
          </button>
          <button
            aria-pressed={view === "model"}
            className={segmentButton(view === "model")}
            onClick={() => setView("model")}
            type="button"
          >
            By model
          </button>
        </div>
      </div>
      {breakdown.missing.length > 0 ? (
        <div className="flex gap-2.25 rounded-board-9 border border-dashed border-input bg-muted px-2.5 py-2">
          <span
            aria-hidden="true"
            className="mt-px inline-flex size-3.75 flex-none items-center justify-center rounded-full border border-muted-foreground text-board-9-5 font-bold text-muted-foreground"
          >
            ?
          </span>
          <div className="flex min-w-0 flex-col gap-0.75">
            <span className="text-board-11-5 font-medium text-foreground">
              Partial total: {breakdown.partialSteps.length}{" "}
              {breakdown.partialSteps.length === 1 ? "step isn't" : "steps aren't"} in {figure.text}
            </span>
            {breakdown.missing.map((entry) => (
              <span
                className="text-board-11 leading-board-1-55 text-pretty text-muted-foreground"
                key={`${entry.stepId}|${entry.text}`}
              >
                <span className="font-mono text-foreground">{entry.stepId}</span> · {entry.text}
              </span>
            ))}
            <span className="text-board-11 text-muted-foreground">
              <Link className="font-medium text-info-foreground hover:underline" to="/usage">
                Add a price
              </Link>{" "}
              for unpriced models on the Usage page.
            </span>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col overflow-hidden rounded-board-10 border border-border bg-card">
        <div
          className={cn(
            GRID,
            "bg-muted px-3 py-1.5 text-board-9-5 font-semibold uppercase tracking-board-6 text-muted-foreground",
          )}
        >
          <span>{view === "stage" ? "Stage" : "Model"}</span>
          <span>{view === "stage" ? "Models" : "Steps"}</span>
          <span className="text-right">Input</span>
          <span className="text-right">Output</span>
          <span className="text-right">Cost</span>
        </div>
        {view === "stage"
          ? breakdown.stages.map((stage, index) => (
              <StageRows
                key={stage.stageId}
                onToggle={() =>
                  setOpenStages((current) => {
                    const next = new Set(current);
                    if (next.has(stage.stageId)) next.delete(stage.stageId);
                    else next.add(stage.stageId);
                    return next;
                  })
                }
                open={openStages.has(stage.stageId)}
                shade={boardUsageStageShade(index)}
                stage={stage}
              />
            ))
          : breakdown.models.map((model) => {
              const modelFigure = formatBoardUsageCost(model.summary);
              return (
                <div
                  className={cn(GRID, "items-start border-t border-border px-3 py-2")}
                  data-usage-model={model.model}
                  key={model.key}
                >
                  <span className="flex min-w-0 flex-col gap-px">
                    <span className="truncate text-board-12 font-semibold text-foreground">
                      {model.model}
                    </span>
                    <span className="text-board-10-5 text-muted-foreground">{model.provider}</span>
                  </span>
                  <span className="font-mono text-board-11 leading-board-1-45 text-pretty text-muted-foreground">
                    {model.steps.map((step, index) => (
                      <Fragment key={step}>
                        {index > 0 ? " " : null}
                        {step}
                      </Fragment>
                    ))}
                  </span>
                  <NumberCells
                    columns={{ ...model, known: model.tag !== "no usage" }}
                    weight="medium"
                  />
                  <span className="flex flex-col items-end gap-0.5">
                    <span
                      className={cn(
                        "whitespace-nowrap font-mono text-board-11 font-medium tabular-nums",
                        modelFigure.known ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {modelFigure.text}
                    </span>
                    {model.tag === null ? null : <Tag tag={model.tag} />}
                  </span>
                </div>
              );
            })}
        <div className={cn(GRID, "border-t border-border bg-muted px-3 py-2")}>
          <span className="text-board-11-5 font-semibold text-foreground">Card total</span>
          <span className="truncate text-board-10-5 text-muted-foreground">
            {breakdown.totals.reasoning > 0
              ? `${formatBoardTokens(breakdown.totals.reasoning)} reasoning in output`
              : ""}
          </span>
          <NumberCells columns={breakdown.totals} weight="semibold" />
          <BoardHint label={figure.tooltip}>
            <span className="whitespace-nowrap text-right font-mono text-board-11-5 font-bold tabular-nums text-foreground">
              {figure.text}
            </span>
          </BoardHint>
        </div>
      </div>
      <p className="text-board-10-5 leading-board-1-55 text-pretty text-muted-foreground">
        {breakdown.estimatedSteps.length > 0
          ? "≈ priced from the model price table on the Usage page; your own prices there count as exact. "
          : "Priced with your own prices from the Usage page. "}
        Input is uncached; hover it for cached tokens, billed at each model's cache rate.
        {breakdown.running
          ? " * includes a running step; figures update as each turn finishes."
          : ""}
      </p>
    </div>
  );
}

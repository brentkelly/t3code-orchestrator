/**
 * The Usage section of a card's Summary pane (T3O-77): the total, a grey bar by stage,
 * what leaves the figure partial, and a table by stage or by model. Self-contained so a
 * later resource-actuals block (T3O-71) can sit beside it. Figures change once per
 * finished turn and never animate.
 */
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, useState } from "react";

import { cn } from "../../lib/utils";
import { BoardHint } from "../BoardHint";
import { useBoardUiStore } from "../boardUiStore";
import type {
  BoardUsageBreakdown,
  BoardUsageColumns,
  BoardUsageStageGroup,
  BoardUsageTag,
} from "./boardUsageBreakdown";
import {
  BOARD_USAGE_UNKNOWN,
  formatBoardTokens,
  formatBoardUsageCost,
  formatBoardUsd,
} from "./boardUsageFormat";

const GRID =
  "grid grid-cols-[minmax(0,1.25fr)_minmax(0,1.35fr)_58px_58px_64px_74px] items-center gap-x-2";
// Grey shades by stage order: cost is plain ink, never a status hue.
const SHADES = [64, 48, 36, 26, 18, 12];
const shade = (index: number) =>
  `color-mix(in srgb, var(--foreground) ${SHADES[Math.min(index, SHADES.length - 1)]}%, transparent)`;

function Tag({ tag, tooltip }: { readonly tag: BoardUsageTag; readonly tooltip?: string }) {
  const chip = (
    <span className="inline-flex h-[15px] items-center whitespace-nowrap rounded-[4px] border border-border bg-muted px-[5px] text-[9.5px] font-medium tracking-[0.02em] text-muted-foreground">
      {tag}
    </span>
  );
  return tooltip === undefined ? chip : <BoardHint label={tooltip}>{chip}</BoardHint>;
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
    "text-right font-mono text-[11px] tabular-nums",
    weight === "normal" ? "font-normal" : weight === "medium" ? "font-medium" : "font-semibold",
  );
  return (
    <>
      <span className={cn(cell, "text-foreground")}>
        {known ? formatBoardTokens(columns.input) : BOARD_USAGE_UNKNOWN}
      </span>
      <span className={cn(cell, "text-muted-foreground")}>
        {known ? formatBoardTokens(columns.cached) : BOARD_USAGE_UNKNOWN}
      </span>
      <span className="flex flex-col items-end gap-px">
        <span className={cn(cell, "text-foreground")}>
          {known ? formatBoardTokens(columns.output) : BOARD_USAGE_UNKNOWN}
        </span>
        {weight === "normal" && known && columns.reasoning > 0 ? (
          <BoardHint label="Reasoning tokens, included in output">
            <span className="whitespace-nowrap font-mono text-[9.5px] text-muted-foreground">
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
  open,
  onToggle,
}: {
  readonly stage: BoardUsageStageGroup;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const figure = formatBoardUsageCost(stage.summary);
  return (
    <>
      <button
        aria-expanded={open}
        className={cn(GRID, "w-full border-t border-border px-3.5 py-2 text-left hover:bg-accent")}
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-[5px]">
          <ChevronRightIcon
            className={cn("size-3 shrink-0 text-muted-foreground", open && "rotate-90")}
          />
          <span className="truncate text-[12px] font-semibold text-foreground">{stage.label}</span>
        </span>
        <span className="truncate text-[11px] text-muted-foreground">{stage.models}</span>
        <NumberCells columns={stage} weight="medium" />
        <BoardHint
          label={stage.running ? "Includes a running step. Grows as turns finish." : figure.tooltip}
        >
          <span className="whitespace-nowrap text-right font-mono text-[11.5px] font-semibold tabular-nums text-foreground">
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
                "items-start border-t border-border/60 bg-foreground/[0.015] px-3.5 pb-[7px] pt-1.5",
              )}
              data-usage-line={line.stepId}
              key={line.key}
            >
              <span className="flex min-w-0 items-center gap-1.5 pl-[17px] pt-px">
                {line.running ? (
                  <BoardHint label="Running">
                    <span className="size-[7px] shrink-0 rounded-full bg-info-foreground" />
                  </BoardHint>
                ) : null}
                <span className="truncate font-mono text-[11.5px] font-medium text-foreground">
                  {line.stepId}
                </span>
              </span>
              <span className="flex min-w-0 flex-col gap-px">
                <span className="truncate text-[11.5px] font-medium text-foreground">
                  {line.model}
                </span>
                <span className="truncate text-[10.5px] text-muted-foreground">
                  {line.provider}
                </span>
              </span>
              <NumberCells columns={{ ...line, known: !line.noUsage }} weight="normal" />
              <span className="flex flex-col items-end gap-0.5 pt-px">
                <span
                  className={cn(
                    "whitespace-nowrap font-mono text-[11px] font-medium tabular-nums",
                    line.costKnown ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {line.costKnown
                    ? `${line.estimated ? "≈" : ""}${formatBoardUsd(line.costUsd)}`
                    : BOARD_USAGE_UNKNOWN}
                </span>
                {line.tag === null ? null : <Tag tag={line.tag} tooltip={TAG_TOOLTIP[line.tag]} />}
              </span>
            </div>
          ))
        : null}
    </>
  );
}

export function BoardCardUsageSection({ breakdown }: { readonly breakdown: BoardUsageBreakdown }) {
  const open = useBoardUiStore((state) => state.usageSectionOpen);
  const setOpen = useBoardUiStore((state) => state.setUsageSectionOpen);
  const [view, setView] = useState<"stage" | "model">("stage");
  const [openStages, setOpenStages] = useState<ReadonlySet<string>>(new Set());
  const figure = formatBoardUsageCost(breakdown.summary, {
    steps: { estimated: breakdown.estimatedSteps, partial: breakdown.partialSteps },
  });
  const tokens = breakdown.totals.input + breakdown.totals.cached + breakdown.totals.output;
  const knownStages = breakdown.stages.filter((stage) => stage.summary.costKnown === true);
  const segmentButton = (active: boolean) =>
    cn(
      "inline-flex h-5 items-center whitespace-nowrap rounded-[7px] border px-[9px] text-[11px] font-medium",
      active
        ? "border-input bg-card text-foreground shadow-xs"
        : "border-transparent text-muted-foreground hover:text-foreground",
    );

  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card"
      data-board-usage-section
    >
      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="flex items-center gap-2">
          <button
            aria-expanded={open}
            className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground hover:text-foreground"
            onClick={() => setOpen(!open)}
            type="button"
          >
            <ChevronRightIcon className={cn("size-3", open && "rotate-90")} />
            Usage
          </button>
          <span className="flex-1" />
          {open ? (
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
          ) : (
            <BoardHint label={figure.tooltip}>
              <span className="font-mono text-[12px] font-semibold tabular-nums text-foreground">
                {figure.text}
                {breakdown.running ? (
                  <span className="font-sans font-normal text-muted-foreground"> so far</span>
                ) : null}
              </span>
            </BoardHint>
          )}
        </div>
        {open ? (
          <>
            <div className="flex flex-wrap items-baseline gap-2.5">
              <BoardHint label={figure.tooltip}>
                <span className="font-mono text-[22px] font-semibold tabular-nums tracking-[-0.02em] text-foreground">
                  {figure.text}
                </span>
              </BoardHint>
              {breakdown.running ? (
                <span className="text-[12px] font-medium text-muted-foreground">so far</span>
              ) : null}
              <span className="text-[11.5px] text-muted-foreground">
                {formatBoardTokens(tokens)} tokens · {breakdown.threadCount}{" "}
                {breakdown.threadCount === 1 ? "thread" : "threads"} · {breakdown.providerCount}{" "}
                {breakdown.providerCount === 1 ? "provider" : "providers"}
              </span>
            </div>
            {knownStages.length > 0 || breakdown.missing.length > 0 ? (
              <>
                <div aria-hidden="true" className="flex h-1.5 gap-0.5">
                  {knownStages.map((stage, index) => (
                    <span
                      className="min-w-[3px] rounded-[2px]"
                      key={stage.stageId}
                      style={{
                        flex: `${Math.max(stage.summary.costUsd, 0.02)} 1 0`,
                        background: shade(index),
                      }}
                    />
                  ))}
                  {breakdown.missing.length > 0 ? (
                    <span className="flex-[0_0_22px] rounded-[2px] border border-dashed border-input" />
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1">
                  {knownStages.map((stage, index) => (
                    <span
                      className="inline-flex items-center gap-[5px] text-[10.5px] text-muted-foreground"
                      key={stage.stageId}
                    >
                      <span
                        className="size-2 shrink-0 rounded-[2px]"
                        style={{ background: shade(index) }}
                      />
                      {stage.label}{" "}
                      <span className="font-mono text-foreground">
                        {formatBoardUsageCost(stage.summary).text}
                      </span>
                    </span>
                  ))}
                  {breakdown.missing.length > 0 ? (
                    <span className="inline-flex items-center gap-[5px] text-[10.5px] text-muted-foreground">
                      <span className="size-2 shrink-0 rounded-[2px] border border-dashed border-muted-foreground" />
                      Unknown{" "}
                      <span className="font-mono text-foreground">
                        {breakdown.partialSteps.length}{" "}
                        {breakdown.partialSteps.length === 1 ? "step" : "steps"}
                      </span>
                    </span>
                  ) : null}
                </div>
              </>
            ) : null}
            {breakdown.missing.length > 0 ? (
              <div className="flex gap-[9px] rounded-[9px] border border-dashed border-input bg-muted px-2.5 py-2">
                <span
                  aria-hidden="true"
                  className="mt-px inline-flex size-[15px] flex-none items-center justify-center rounded-full border-[1.4px] border-muted-foreground text-[9px] font-bold text-muted-foreground"
                >
                  ?
                </span>
                <div className="flex min-w-0 flex-col gap-[3px]">
                  <span className="text-[11.5px] font-medium text-foreground">
                    Partial total: {breakdown.partialSteps.length}{" "}
                    {breakdown.partialSteps.length === 1 ? "step isn't" : "steps aren't"} in{" "}
                    {figure.text}
                  </span>
                  {breakdown.missing.map((entry) => (
                    <span
                      className="text-[11px]/[1.5] text-pretty text-muted-foreground"
                      key={`${entry.stepId}|${entry.text}`}
                    >
                      <span className="font-mono text-foreground">{entry.stepId}</span> ·{" "}
                      {entry.text}
                    </span>
                  ))}
                  <span className="text-[11px] text-muted-foreground">
                    <Link className="font-medium text-info-foreground hover:underline" to="/usage">
                      Add a price
                    </Link>{" "}
                    for unpriced models on the Usage page.
                  </span>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {open ? (
        <>
          <div
            className={cn(
              GRID,
              "border-t border-border bg-muted px-3.5 py-1.5 text-[9.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground",
            )}
          >
            <span>{view === "stage" ? "Stage · step" : "Model"}</span>
            <span>{view === "stage" ? "Model" : "Threads"}</span>
            <span className="text-right">Input</span>
            <span className="text-right">Cached</span>
            <span className="text-right">Output</span>
            <span className="text-right">Cost</span>
          </div>
          {view === "stage"
            ? breakdown.stages.map((stage) => (
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
                  stage={stage}
                />
              ))
            : breakdown.models.map((model) => {
                const modelFigure = formatBoardUsageCost(model.summary);
                return (
                  <div
                    className={cn(GRID, "items-start border-t border-border px-3.5 py-2")}
                    data-usage-model={model.model}
                    key={model.key}
                  >
                    <span className="flex min-w-0 flex-col gap-px">
                      <span className="truncate text-[12px] font-semibold text-foreground">
                        {model.model}
                      </span>
                      <span className="text-[10.5px] text-muted-foreground">{model.provider}</span>
                    </span>
                    <span className="font-mono text-[11px]/[1.45] text-pretty text-muted-foreground">
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
                          "whitespace-nowrap font-mono text-[11px] font-medium tabular-nums",
                          modelFigure.known ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {modelFigure.text}
                      </span>
                      {model.tag === null ? null : (
                        <Tag tag={model.tag} tooltip={TAG_TOOLTIP[model.tag]} />
                      )}
                    </span>
                  </div>
                );
              })}
          <div className={cn(GRID, "border-t border-border bg-muted px-3.5 py-2")}>
            <span className="text-[11.5px] font-semibold text-foreground">Card total</span>
            <span className="text-[10.5px] text-muted-foreground">
              {breakdown.totals.reasoning > 0
                ? `${formatBoardTokens(breakdown.totals.reasoning)} reasoning in output`
                : ""}
            </span>
            <NumberCells columns={breakdown.totals} weight="semibold" />
            <span className="whitespace-nowrap text-right font-mono text-[11.5px] font-bold tabular-nums text-foreground">
              {figure.text}
            </span>
          </div>
          <p className="border-t border-border px-3.5 py-2 text-[10.5px]/[1.5] text-pretty text-muted-foreground">
            {breakdown.estimatedSteps.length > 0
              ? "≈ priced from the model price table on the Usage page; your own prices there count as exact. "
              : "Priced with your own prices from the Usage page. "}
            Cached input is billed at each model's cache rate.
            {breakdown.running
              ? " * includes a running step; figures update as each turn finishes."
              : ""}
          </p>
        </>
      ) : null}
    </div>
  );
}

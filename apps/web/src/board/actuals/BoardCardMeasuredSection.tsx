/**
 * The Measured section beside a card's Usage (T3O-87). Running rows are blue ("so far");
 * Partial and Not measured are grey tags with their reason, never a 0. On a narrow screen each
 * step is a card. Hovering a row highlights the Usage lines of the same step.
 */
import type { BoardActualsRowState } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { BoardHint } from "../BoardHint";
import type { BoardActualsLine } from "./boardActualsView";

const GRID =
  "grid grid-cols-[minmax(0,1.4fr)_58px_52px_62px_minmax(0,1fr)_52px_74px] items-center gap-x-2";

const STATE_TAG: Record<BoardActualsRowState, string> = {
  complete: "",
  partial: "Partial",
  "not-measured": "Not measured",
  "so-far": "so far",
};

const STATE_TOOLTIP: Record<BoardActualsRowState, string> = {
  complete: "Measured in full.",
  partial: "A restart cut into this step: the figures are a lower bound.",
  "not-measured": "Not measured.",
  "so-far": "Still running: figures so far.",
};

function DataTag({ line }: { readonly line: BoardActualsLine }) {
  if (line.state === "complete") {
    return <span className="text-right text-board-10-5 text-muted-foreground">complete</span>;
  }
  const running = line.state === "so-far";
  return (
    <BoardHint label={line.reason ?? STATE_TOOLTIP[line.state]}>
      <span
        className={cn(
          "inline-flex h-3.75 items-center justify-self-end whitespace-nowrap rounded-sm border px-1.25 text-board-9-5 font-medium",
          running
            ? "border-info/30 bg-info/10 text-info-foreground"
            : "border-border bg-muted text-muted-foreground",
        )}
      >
        {STATE_TAG[line.state]}
      </span>
    </BoardHint>
  );
}

function StepCell({ line }: { readonly line: BoardActualsLine }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-board-11-5 font-medium text-foreground">{line.label}</span>
      <BoardHint label={line.worker.label}>
        <span className="shrink-0 rounded-sm border border-border px-1 font-mono text-board-9-5 text-muted-foreground">
          {line.worker.abbreviation}
        </span>
      </BoardHint>
    </span>
  );
}

const figure = "text-right font-mono text-board-11 tabular-nums text-foreground";

export function BoardCardMeasuredSection(props: {
  readonly lines: ReadonlyArray<BoardActualsLine>;
  readonly footer: { readonly reservation: string; readonly share: string | null } | null;
  readonly hoveredStepId: string | null;
  readonly onHoverStep: (stepId: string | null) => void;
}) {
  const hover = (line: BoardActualsLine) => ({
    onMouseEnter: () => props.onHoverStep(line.stepId),
    onMouseLeave: () => props.onHoverStep(null),
  });
  const highlighted = (line: BoardActualsLine) =>
    line.stepId !== null && line.stepId === props.hoveredStepId;
  return (
    <div
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card"
      data-board-measured-section
    >
      <div className="px-3.5 py-3 text-board-11 font-semibold uppercase tracking-board-7 text-muted-foreground">
        Measured
      </div>
      {/* Wide: one table row per step. */}
      <div className="hidden sm:block">
        <div
          className={cn(
            GRID,
            "border-t border-border bg-muted px-3.5 py-1.5 text-board-9-5 font-semibold uppercase tracking-board-6 text-muted-foreground",
          )}
        >
          <span>Step</span>
          <span className="text-right">CPU core·s</span>
          <BoardHint label="The highest 1-minute average CPU rate, in cores.">
            <span className="text-right">Peak 1-min</span>
          </BoardHint>
          <span className="text-right">Peak RAM</span>
          <span className="text-right">I/O r / w</span>
          <span className="text-right">Disk</span>
          <span className="text-right">Data</span>
        </div>
        {props.lines.map((line) => (
          <div
            className={cn(
              GRID,
              "border-t border-border px-3.5 py-2",
              line.state === "so-far" && "bg-info/5",
              highlighted(line) && "bg-accent",
            )}
            data-measured-line={line.stepId ?? undefined}
            key={line.key}
            {...hover(line)}
          >
            <StepCell line={line} />
            <span className={figure}>{line.coreSeconds}</span>
            <span className={figure}>{line.peakCores}</span>
            <span className={figure}>{line.peakRam}</span>
            <span className={cn(figure, "truncate")}>{line.io}</span>
            <span className={figure}>{line.disk}</span>
            <DataTag line={line} />
          </div>
        ))}
      </div>
      {/* Narrow: one card per step. */}
      <div className="flex flex-col sm:hidden">
        {props.lines.map((line) => (
          <div
            className={cn(
              "flex flex-col gap-1.5 border-t border-border px-3.5 py-2.5",
              line.state === "so-far" && "bg-info/5",
            )}
            key={line.key}
          >
            <div className="flex items-center justify-between gap-2">
              <StepCell line={line} />
              <DataTag line={line} />
            </div>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-board-10-5 text-muted-foreground">
              <span>
                CPU <span className="font-mono text-foreground">{line.coreSeconds}</span> core·s
              </span>
              <span>
                Peak <span className="font-mono text-foreground">{line.peakCores}</span>
              </span>
              <span>
                RAM <span className="font-mono text-foreground">{line.peakRam}</span>
              </span>
              <span className="col-span-2">
                I/O <span className="font-mono text-foreground">{line.io}</span>
              </span>
              <span>
                Disk <span className="font-mono text-foreground">{line.disk}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
      {props.footer === null ? null : (
        <p className="border-t border-border bg-muted px-3.5 py-2 text-board-10-5/[1.5] text-pretty text-muted-foreground">
          Reserved on this worker:{" "}
          <span className="font-mono text-foreground">{props.footer.reservation}</span>
          {props.footer.share === null ? null : (
            <>
              {" "}
              · peak used <span className="font-mono text-foreground">{props.footer.share}</span>
            </>
          )}
          . Agents that start daemons outside their tree are undercounted, and a spike shorter than
          5 s can be missed.
        </p>
      )}
    </div>
  );
}

/**
 * T3o: the import dialog's Schedules section (T3O-117). Nothing is scheduled
 * unless a machine is picked, and every prompt is shown in full, because each
 * schedule runs unattended with full access to its machine.
 */
import type { BoardScheduleImportRow, EnvironmentId } from "@t3tools/contracts";
import { Clock3Icon, TriangleAlertIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { BoardScheduleMachinePicker } from "../schedules/BoardScheduleMachinePicker";
import {
  BOARD_IMPORT_SCHEDULE_KIND_LABELS,
  boardImportScheduleExplanation,
  boardImportScheduleVerdict,
  boardPromptChangeSummary,
  boardPromptLineDiff,
  boardScheduleWhenText,
  orderBoardImportSchedules,
  revealBoardPromptInvisibles,
  type BoardImportScheduleSummary,
  type BoardSchedulePlacements,
  boardSchedulePlacement,
} from "./boardProjectSettings.logic";

export function BoardImportSchedulesSection(props: {
  readonly rows: ReadonlyArray<BoardScheduleImportRow>;
  readonly summary: BoardImportScheduleSummary;
  readonly placements: BoardSchedulePlacements;
  readonly onPlace: (fileId: string, environmentId: EnvironmentId | null) => void;
  readonly serverEnvironmentId: EnvironmentId;
  readonly serverUtcOffsetMinutes: number | null;
  readonly projectTitle: string;
  /** Picking a machine needs the operate scope; without it every row stays Don't schedule. */
  readonly canPlace: boolean;
}) {
  const machineLabel = (environmentId: EnvironmentId | null) =>
    environmentId === null
      ? "Not scheduled"
      : environmentId === props.serverEnvironmentId
        ? "This server"
        : environmentId;
  const verdict = boardImportScheduleVerdict({
    summary: props.summary,
    placements: props.placements,
    projectTitle: props.projectTitle,
    machineLabel,
  });
  const removed = props.summary.deletes.length;
  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-col">
        <span className="text-board-13 font-medium text-foreground">Schedules</span>
        <span className="text-muted-foreground">
          {props.summary.placeable} in the file{removed > 0 ? ` · ${removed} removed` : ""} · where
          each runs is picked here and never written to the file
        </span>
      </div>
      <div
        className={cn(
          "flex flex-col gap-1 rounded-lg border px-3 py-2",
          verdict.tone === "warning"
            ? "border-warning-foreground/40 bg-warning/8"
            : "border-border bg-muted/40",
        )}
      >
        <span className="flex items-start gap-2 text-foreground">
          {verdict.tone === "warning" ? (
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0 text-warning-foreground" />
          ) : (
            <Clock3Icon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
          )}
          {verdict.text}
        </span>
        {verdict.stops.map((line) => (
          <span className="text-warning-foreground" key={`stop:${line}`}>
            ! {line}
          </span>
        ))}
        {verdict.deletes.map((line) => (
          <span className="text-muted-foreground" key={`delete:${line}`}>
            {"−"} {line}
          </span>
        ))}
      </div>
      {orderBoardImportSchedules(props.rows).map((row) => (
        <ScheduleRow
          canPlace={props.canPlace}
          key={row.fileId}
          machineLabel={machineLabel}
          onPlace={props.onPlace}
          placement={boardSchedulePlacement(props.placements, row.fileId)}
          row={row}
          serverEnvironmentId={props.serverEnvironmentId}
          serverUtcOffsetMinutes={props.serverUtcOffsetMinutes}
        />
      ))}
    </section>
  );
}

function ScheduleRow(props: {
  readonly row: BoardScheduleImportRow;
  readonly placement: EnvironmentId | null;
  readonly onPlace: (fileId: string, environmentId: EnvironmentId | null) => void;
  readonly serverEnvironmentId: EnvironmentId;
  readonly serverUtcOffsetMinutes: number | null;
  readonly machineLabel: (environmentId: EnvironmentId | null) => string;
  readonly canPlace: boolean;
}) {
  const { row, placement } = props;
  const current = row.currentEnvironmentId ?? null;
  const deleting = row.kind === "delete";
  const picked = placement !== null;
  const where = props.machineLabel(placement);
  const changes = [
    ...row.changes.filter((change) => change.label !== "Machine"),
    ...(row.kind === "update" || row.kind === "adopt"
      ? [
          {
            label: "Machine",
            from: props.machineLabel(current),
            to:
              placement === current
                ? `${props.machineLabel(current)} (unchanged)`
                : placement === null && current !== null
                  ? `Not scheduled · stops running on ${props.machineLabel(current)}`
                  : where,
            stops: placement === null && current !== null,
          },
        ]
      : []),
  ];
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5",
        picked && "border-l-3 border-l-primary",
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span
              className={cn(
                "rounded-full border border-border px-1.5 text-board-11 font-medium",
                deleting ? "text-destructive-foreground" : "text-muted-foreground",
              )}
            >
              {BOARD_IMPORT_SCHEDULE_KIND_LABELS[row.kind]}
            </span>
            <b className="text-foreground">{row.title}</b>
            <code className="font-mono text-board-11 text-muted-foreground">{row.fileId}</code>
          </span>
          <span className="text-foreground">
            {boardScheduleWhenText(row.schedule, props.serverUtcOffsetMinutes)}
          </span>
          {row.enabled ? null : (
            <span className="w-fit rounded-md bg-accent px-1.5 text-board-11 text-muted-foreground">
              Disabled in file
            </span>
          )}
          <span className="text-muted-foreground">
            {boardImportScheduleExplanation(row, props.machineLabel)}
          </span>
        </div>
        {deleting ? null : (
          <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
            <span className="text-board-11 text-muted-foreground">Run on</span>
            <BoardScheduleMachinePicker
              className="w-44"
              disabled={!props.canPlace}
              noneLabel="Don't schedule"
              noneSub="Import it without running it anywhere"
              note={`Run '${row.title}' on one machine. Usually only one machine should run a given schedule.`}
              onSelect={(environmentId) => props.onPlace(row.fileId, environmentId)}
              serverEnvironmentId={props.serverEnvironmentId}
              value={placement}
            />
            {current !== null && placement !== current && props.canPlace ? (
              <button
                className="cursor-pointer text-board-11 text-muted-foreground hover:text-foreground hover:underline"
                onClick={() => props.onPlace(row.fileId, current)}
                type="button"
              >
                Keep on {props.machineLabel(current)}
              </button>
            ) : null}
          </div>
        )}
      </div>
      {changes.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {changes.map((change) => (
            <li
              className={cn(
                "grid grid-cols-[6rem_1fr] gap-2",
                "stops" in change && change.stops ? "text-warning-foreground" : "text-foreground",
              )}
              key={change.label}
            >
              <span className="text-muted-foreground">{change.label}</span>
              <span className="min-w-0 break-words">
                {change.label === "Prompt" && row.previousPrompt !== undefined
                  ? boardPromptChangeSummary(row.previousPrompt, row.prompt)
                  : `${change.from} → ${change.to}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {deleting ? null : <SchedulePrompt row={row} where={picked ? where : null} />}
    </div>
  );
}

function SchedulePrompt(props: {
  readonly row: BoardScheduleImportRow;
  readonly where: string | null;
}) {
  const { row } = props;
  const changed = row.previousPrompt !== undefined && row.previousPrompt !== row.prompt;
  return (
    <div className="flex flex-col gap-1">
      <span className="rounded-md border border-warning-foreground/40 bg-warning/8 px-2 py-1 text-warning-foreground">
        {props.where === null
          ? "If you schedule it, it runs unattended with full access to that machine, in a fresh worktree off the default branch. It can use board tools, such as filing a card."
          : `Runs unattended on ${props.where} with full access to that machine, in a fresh worktree off the default branch. It can use board tools, such as filing a card.`}
      </span>
      <span className="text-muted-foreground">
        {changed
          ? "Prompt · new version from the file · changed lines marked"
          : "Prompt · full text"}
      </span>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-board-11 whitespace-pre-wrap">
        {changed
          ? boardPromptLineDiff(row.previousPrompt ?? "", row.prompt).map((line, index) => (
              <span
                className={cn(
                  "block",
                  line.kind === "add" && "bg-primary/10",
                  line.kind === "remove" && "text-muted-foreground line-through",
                )}
                // oxlint-disable-next-line react/no-array-index-key -- diff lines repeat; position is their identity.
                key={index}
              >
                {line.kind === "add" ? "+ " : line.kind === "remove" ? "− " : "  "}
                {revealBoardPromptInvisibles(line.text)}
              </span>
            ))
          : revealBoardPromptInvisibles(row.prompt)}
      </pre>
    </div>
  );
}

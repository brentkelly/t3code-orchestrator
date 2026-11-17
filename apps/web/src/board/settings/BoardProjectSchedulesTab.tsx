/**
 * T3o: a project's Schedules tab (T3O-117). Lists the schedules its
 * t3o.json declares and is where each one's machine is picked or changed.
 * What a schedule does comes from the file; where it runs never goes into it.
 */
import type {
  BoardScheduleHandMadeTask,
  BoardScheduleListResult,
  BoardScheduleRow,
  EnvironmentId,
  ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PlayIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoardHint } from "../BoardHint";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import { BoardScheduleMachinePicker } from "../schedules/BoardScheduleMachinePicker";
import { BoardScheduleRunThreadLink } from "../schedules/BoardScheduleRunThreadLink";
import {
  refreshBoardSchedules,
  useBoardScheduleMachines,
  useCanOperateSchedules,
  useScheduleNow,
  type BoardScheduleMachines,
} from "../schedules/useBoardSchedules";
import {
  boardScheduleLastResultView,
  boardScheduleRelative,
  boardScheduleWhenText,
  revealBoardPromptInvisibles,
} from "./boardProjectSettings.logic";
import {
  BOARD_SCHEDULE_RESULT_DOT,
  BOARD_SCHEDULE_RESULT_TEXT,
} from "../schedules/boardScheduleResultTone";
import { useBoardSettingsContext } from "./BoardSettingsLayout";

const EXAMPLE = `"schedules": [
  {
    "id": "nightly-tests",
    "title": "Nightly full test run",
    "schedule": { "type": "fixed_time", "timeOfDay": "02:00" },
    "enabled": true,
    "prompt": "Run the full test suite. File a card for each new failure."
  }
]`;

export function BoardProjectSchedulesTab(props: {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly list: BoardScheduleListResult | null;
}) {
  const { list } = props;
  const { environmentId } = useBoardSettingsContext();
  const machines = useBoardScheduleMachines(
    environmentId,
    props.projectId,
    list?.serverEnvironmentId ?? environmentId,
  );
  if (list === null) {
    return <p className="mx-3 text-sm text-muted-foreground sm:mx-4">Loading schedules…</p>;
  }
  const rows = list.schedules.filter((row) => row.projectId === props.projectId);
  const handMade = list.handMade.filter((task) => task.projectId === props.projectId);
  return (
    <div className="mx-3 flex flex-col gap-3 sm:mx-4">
      <p className="max-w-2xl text-board-13 leading-board-1-55 text-muted-foreground">
        Recurring runs declared in this project&apos;s t3o.json. Each runs unattended on the one
        machine you pick, with full access to it, in a fresh worktree off the default branch. What a
        schedule does comes from the file; where it runs is set here and never written to the file.
      </p>
      {rows.length === 0 ? (
        <EmptyState projectTitle={props.projectTitle} />
      ) : (
        <div className="flex flex-col rounded-xl border border-border bg-card shadow-xs">
          <div className="hidden grid-cols-[minmax(0,2fr)_11rem_9rem_minmax(0,1.3fr)_auto] gap-3 border-b border-border px-4 py-2 text-board-11 font-medium text-muted-foreground md:grid">
            <span>Schedule</span>
            <span>Runs on</span>
            <span>Next run</span>
            <span>Last result</span>
            <span className="w-44" />
          </div>
          {rows.map((row) => (
            <ScheduleRow key={row.fileId} list={list} machines={machines} row={row} />
          ))}
        </div>
      )}
      {handMade.length > 0 ? (
        <HandMadeNote
          machines={machines}
          projectId={props.projectId}
          tasks={handMade}
          title={props.projectTitle}
        />
      ) : null}
      <Link
        className="w-fit text-xs text-muted-foreground hover:text-foreground hover:underline"
        to="/settings/scheduled-tasks"
      >
        Open Scheduled tasks
      </Link>
    </div>
  );
}

function ScheduleRow(props: {
  readonly row: BoardScheduleRow;
  readonly list: BoardScheduleListResult;
  readonly machines: BoardScheduleMachines;
}) {
  const { row, list, machines } = props;
  const { environmentId } = useBoardSettingsContext();
  const canOperate = useCanOperateSchedules(environmentId);
  const setMachine = useAtomCommand(boardEnvironment.setScheduleMachine, { reportFailure: false });
  const runNow = useAtomCommand(boardEnvironment.runScheduleNow, { reportFailure: false });
  const now = useScheduleNow();
  const [showPrompt, setShowPrompt] = useState(false);
  const [confirmUnschedule, setConfirmUnschedule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const namer = machines.name;
  const machine = row.environmentId === null ? null : namer(row.environmentId);
  // A worker that can't take a run now: its due runs are skipped until it can.
  const targetStatus = machines.status(row.environmentId);
  const targetDown = targetStatus?.warning === true;
  const result = boardScheduleLastResultView(row, machine, now);

  const move = (target: EnvironmentId | null) => {
    setBusy(true);
    void setMachine({
      environmentId,
      input: { projectId: row.projectId, fileId: row.fileId, environmentId: target },
    }).then((outcome) => {
      setBusy(false);
      refreshBoardSchedules(environmentId, row.projectId);
      if (outcome._tag === "Failure") {
        boardToast({
          title: target === null ? "Couldn't unschedule" : "Couldn't schedule",
          description: describeBoardCommandFailure(outcome),
          tone: "error",
        });
        return;
      }
      const next = outcome.value.nextRunAt;
      const nextText =
        next === null
          ? ""
          : ` Next run ${new Date(next).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}.`;
      boardToast({
        title:
          target === null
            ? `Unscheduled '${row.title}'.`
            : machine === null
              ? `Scheduled '${row.title}' on ${namer(target)}.${nextText}`
              : `Moved '${row.title}' from ${machine} to ${namer(target)}.${nextText}`,
        ...(outcome.value.lastError === null
          ? {}
          : { description: outcome.value.lastError, tone: "warning" as const }),
      });
    });
  };

  const onRunNow = () => {
    setBusy(true);
    void runNow({ environmentId, input: { projectId: row.projectId, fileId: row.fileId } }).then(
      (outcome) => {
        setBusy(false);
        refreshBoardSchedules(environmentId, row.projectId);
        boardToast(
          outcome._tag === "Failure"
            ? {
                title: `Couldn't run '${row.title}'`,
                description: describeBoardCommandFailure(outcome),
                tone: "error",
              }
            : { title: `Running '${row.title}' on ${machine ?? "this server"}.` },
        );
      },
    );
  };

  const runNowBlock =
    row.environmentId === null
      ? "Pick a machine first"
      : targetDown
        ? `${machine} can't take a run now: ${targetStatus.text}`
        : row.running
          ? "Already running"
          : !canOperate
            ? "Running a schedule needs permission to operate the board"
            : null;
  const nextRun = !row.enabled ? (
    <>
      <span>Paused</span>
      <span className="text-muted-foreground">enabled: false in t3o.json</span>
    </>
  ) : row.environmentId === null || row.nextRunAt === null ? (
    <span className="text-muted-foreground">Not scheduled</span>
  ) : (
    <>
      <span>
        {new Date(row.nextRunAt).toLocaleString([], {
          weekday: "short",
          hour: "2-digit",
          minute: "2-digit",
        })}
      </span>
      <span className="text-muted-foreground">{boardScheduleRelative(row.nextRunAt, now)}</span>
      {targetDown ? (
        <span className="text-warning-foreground">
          {targetStatus.offline
            ? `Skipped unless ${machine} reconnects`
            : `Skipped unless ${machine} is ready`}
        </span>
      ) : null}
    </>
  );

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-b-0">
      <div className="grid grid-cols-1 items-start gap-2 text-xs md:grid-cols-[minmax(0,2fr)_11rem_9rem_minmax(0,1.3fr)_auto] md:gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <b className="text-board-13 text-foreground">{row.title}</b>
            {row.enabled ? null : <Tag>Paused in file</Tag>}
            {row.editedByHand ? <Tag>Edited by hand</Tag> : null}
          </span>
          <span className="text-foreground">
            {boardScheduleWhenText(row.schedule, list.serverUtcOffsetMinutes)}
          </span>
          <span className="flex items-center gap-2 text-muted-foreground">
            <code className="font-mono text-board-11">{row.fileId}</code>
            <button
              className="cursor-pointer hover:text-foreground hover:underline"
              onClick={() => setShowPrompt((value) => !value)}
              type="button"
            >
              {showPrompt ? "Hide prompt" : "Show prompt"}
            </button>
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground md:hidden">Runs on</span>
          <BoardScheduleMachinePicker
            className="min-h-7 w-full max-w-44"
            disabled={busy || !canOperate}
            noneLabel="Not scheduled"
            noneSub="Runs nowhere until you pick a machine"
            note={`Run '${row.title}' on one machine. Moving it changes nothing in t3o.json.`}
            choices={machines.choices}
            name={namer}
            onOpenChange={setPickerOpen}
            onSelect={(target) => (target === null ? setConfirmUnschedule(true) : move(target))}
            open={pickerOpen}
            value={row.environmentId}
            warning={targetDown}
          />
          {row.environmentId === null ? (
            <span className="text-board-11 text-muted-foreground">
              Runs nowhere until you pick a machine
            </span>
          ) : null}
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-muted-foreground md:hidden">Next run</span>
          {nextRun}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-muted-foreground md:hidden">Last result</span>
          <span className={cn("flex items-start gap-1.5", BOARD_SCHEDULE_RESULT_TEXT[result.tone])}>
            <span
              className={cn(
                "mt-1 size-2 shrink-0 rounded-full",
                BOARD_SCHEDULE_RESULT_DOT[result.tone],
              )}
            />
            <span className="min-w-0 break-words">{result.text}</span>
          </span>
          {row.lastResult.threadId === null ? null : (
            <BoardScheduleRunThreadLink
              boardEnvironmentId={environmentId}
              className="text-board-11 text-muted-foreground hover:text-foreground hover:underline"
              label="Open run thread"
              name={namer}
              ranOn={row.lastResult.ranOn ?? null}
              serverEnvironmentId={list.serverEnvironmentId}
              threadId={row.lastResult.threadId}
            />
          )}
          {row.lastError === null || row.lastResult.kind === "schedule-failed" ? null : (
            <span className="text-board-11 text-warning-foreground">{row.lastError}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 md:w-44 md:justify-end">
          <BoardHint
            label={
              runNowBlock ??
              `Run once now on ${machine}: unattended, full access, fresh worktree off the default branch`
            }
          >
            <span>
              <Button
                disabled={busy || runNowBlock !== null}
                onClick={onRunNow}
                size="xs"
                variant="outline"
              >
                <PlayIcon />
                Run now
              </Button>
            </span>
          </BoardHint>
          <Button
            disabled={busy || row.environmentId === null || !canOperate}
            onClick={() => setConfirmUnschedule(true)}
            size="xs"
            variant="ghost"
          >
            Unschedule
          </Button>
        </div>
      </div>
      {targetDown ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-warning-foreground/40 bg-warning/8 px-2.5 py-1.5 text-xs text-warning-foreground">
          <span className="min-w-0 flex-1">
            {targetStatus.offline
              ? `${machine} is offline. Runs due while it's away are skipped.`
              : `${machine} can't take a run now (${targetStatus.text}). Runs due meanwhile are skipped.`}
          </span>
          {canOperate ? (
            <Button onClick={() => setPickerOpen(true)} size="xs" variant="outline">
              Move to another machine…
            </Button>
          ) : null}
        </div>
      ) : null}
      {showPrompt ? (
        <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-board-11 whitespace-pre-wrap">
          {revealBoardPromptInvisibles(row.prompt)}
        </pre>
      ) : null}
      {confirmUnschedule ? (
        <AlertDialog open onOpenChange={(open) => (open ? undefined : setConfirmUnschedule(false))}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Unschedule &apos;{row.title}&apos;?</AlertDialogTitle>
              <AlertDialogDescription>
                It stops running on {machine ?? "its machine"}. It stays in t3o.json and is listed
                here as Not scheduled; importing the file doesn&apos;t schedule it again unless a
                machine is picked in the import.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
              <Button
                onClick={() => {
                  setConfirmUnschedule(false);
                  move(null);
                }}
                variant="destructive"
              >
                Unschedule
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      ) : null}
    </div>
  );
}

function Tag(props: { readonly children: string }) {
  return (
    <span className="rounded-md bg-accent px-1.5 text-board-11 text-muted-foreground">
      {props.children}
    </span>
  );
}

function HandMadeNote(props: {
  readonly tasks: ReadonlyArray<BoardScheduleHandMadeTask>;
  readonly machines: BoardScheduleMachines;
  readonly projectId: ProjectId;
  readonly title: string;
}) {
  const namer = props.machines.name;
  const count = props.tasks.length;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1">
        {count === 1
          ? "1 hand-made scheduled task also runs"
          : `${count} hand-made scheduled tasks also run`}{" "}
        for {props.title}:{" "}
        {props.tasks.map((task) => `'${task.title}' on ${namer(task.environmentId)}`).join(", ")}.
        {count === 1 ? " It isn't" : " They aren't"} in t3o.json; Export adds{" "}
        {count === 1 ? "it" : "them"}.
      </span>
      <Link
        className="text-foreground hover:underline"
        params={{ projectId: props.projectId, tab: "import" }}
        to="/settings/board/projects/$projectId/$tab"
      >
        Go to Export
      </Link>
    </div>
  );
}

function EmptyState(props: { readonly projectTitle: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 text-xs shadow-xs">
      <span className="text-board-13-5 font-medium text-foreground">
        No schedules in {props.projectTitle}&apos;s t3o.json
      </span>
      <span className="text-muted-foreground">
        Each entry needs an id, a title, when it runs (an interval, or a time of day with optional
        weekdays), whether it&apos;s enabled, and the prompt. Every run is a new thread in a fresh
        worktree. The machine is picked when you import the file.
      </span>
      <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-board-11">
        {EXAMPLE}
      </pre>
    </div>
  );
}

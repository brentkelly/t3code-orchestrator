/**
 * T3o: what upstream's Scheduled tasks page shows for tasks a project's
 * t3o.json manages (T3O-117), reached through one-line seams in
 * `ScheduledTasksSettings.tsx`. A managed task's upstream status records only
 * the timer's dispatch, so the board's own outcome replaces it.
 */
import type {
  BoardScheduleManagedTask,
  BoardScheduleManagedTasksResult,
  EnvironmentId,
  ProjectId,
  ScheduledTask,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { FileJsonIcon } from "lucide-react";
import * as Option from "effect/Option";
import type { ReactNode } from "react";

import { buildThreadRouteParams } from "../../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useEnvironmentQuery } from "../../state/query";
import { environmentShell } from "../../state/shell";
import { boardScheduleLastResultView } from "../settings/boardProjectSettings.logic";
import { BOARD_SCHEDULE_RESULT_DOT, BOARD_SCHEDULE_RESULT_TEXT } from "./boardScheduleResultTone";
import { useBoardEnvironment } from "../useBoardEnvironmentId";
import { useScheduleNow } from "./useBoardSchedules";

function useManagedScheduleTasks(): {
  readonly boardEnvironmentId: EnvironmentId | null;
  readonly data: BoardScheduleManagedTasksResult | null;
} {
  const resolution = useBoardEnvironment();
  const boardEnvironmentId = resolution.kind === "ready" ? resolution.environmentId : null;
  const query = useEnvironmentQuery(
    boardEnvironmentId === null
      ? null
      : boardEnvironment.managedScheduleTasksAtom({
          environmentId: boardEnvironmentId,
          input: {},
        }),
  );
  return { boardEnvironmentId, data: query.data };
}

function useProjectTitle(environmentId: EnvironmentId, projectId: ProjectId) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  return (
    Option.getOrNull(shell.snapshot)?.projects.find((project) => project.id === projectId)?.title ??
    projectId
  );
}

const managedFor = (
  data: BoardScheduleManagedTasksResult | null,
  environmentId: EnvironmentId,
  task: Pick<ScheduledTask, "id">,
): BoardScheduleManagedTask | null =>
  data?.tasks.find((entry) => entry.environmentId === environmentId && entry.taskId === task.id) ??
  null;

function FileMarker(props: {
  readonly managed: BoardScheduleManagedTask;
  readonly projectTitle: string;
}) {
  return (
    <Link
      className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-board-11 text-muted-foreground hover:text-foreground"
      onClick={(event) => event.stopPropagation()}
      params={{ projectId: props.managed.projectId, tab: "schedules" }}
      title={`Managed by ${props.projectTitle}'s t3o.json (${props.managed.fileId}). Edits made here are overwritten by its next import.`}
      to="/settings/board/projects/$projectId/$tab"
    >
      <FileJsonIcon className="size-3" />
      From t3o.json · {props.projectTitle}
    </Link>
  );
}

/** The row's status: for a managed task, the marker and the board's outcome
    in place of upstream's dispatch status (`children`). */
export function BoardScheduledTaskStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask;
  readonly children: ReactNode;
}) {
  const { boardEnvironmentId, data } = useManagedScheduleTasks();
  const managed = managedFor(data, props.environmentId, props.task);
  if (managed === null || boardEnvironmentId === null) return props.children;
  return <ManagedStatus boardEnvironmentId={boardEnvironmentId} managed={managed} />;
}

function ManagedStatus(props: {
  readonly managed: BoardScheduleManagedTask;
  readonly boardEnvironmentId: EnvironmentId;
}) {
  const { managed } = props;
  const now = useScheduleNow();
  const projectTitle = useProjectTitle(props.boardEnvironmentId, managed.projectId);
  const machine =
    managed.targetEnvironmentId === null
      ? null
      : managed.targetEnvironmentId === managed.environmentId
        ? "This server"
        : managed.targetEnvironmentId;
  const result = boardScheduleLastResultView(
    {
      lastResult: managed.lastResult,
      missing: false,
      lastError: null,
      environmentId: managed.targetEnvironmentId,
    },
    machine,
    now,
  );
  return (
    <>
      <FileMarker managed={managed} projectTitle={projectTitle} />
      {managed.editedByHand ? (
        <span className="text-muted-foreground">Edited here · the next import overwrites it</span>
      ) : null}
      <span
        className={cn("inline-flex items-center gap-1.5", BOARD_SCHEDULE_RESULT_TEXT[result.tone])}
      >
        <span
          className={cn("size-2 shrink-0 rounded-full", BOARD_SCHEDULE_RESULT_DOT[result.tone])}
        />
        {result.text}
      </span>
      {managed.lastResult.threadId === null ? null : (
        <Link
          className="underline underline-offset-2 hover:text-foreground"
          params={buildThreadRouteParams(
            scopeThreadRef(props.boardEnvironmentId, managed.lastResult.threadId),
          )}
          to="/$environmentId/$threadId"
        >
          Open run thread
        </Link>
      )}
    </>
  );
}

/** Above the editor's fields: the managed-task banner, or the hand-made note. */
export function BoardScheduledTaskEditNote(props: {
  readonly environmentId: EnvironmentId;
  readonly task: ScheduledTask | null;
}) {
  const { boardEnvironmentId, data } = useManagedScheduleTasks();
  if (props.task === null || boardEnvironmentId === null) return null;
  const managed = managedFor(data, props.environmentId, props.task);
  const handMade =
    managed === null &&
    props.environmentId === boardEnvironmentId &&
    (data?.handMade.some((task) => task.taskId === props.task?.id && task.schedule !== null) ??
      false);
  if (managed === null && !handMade) return null;
  return (
    <EditNote
      boardEnvironmentId={boardEnvironmentId}
      managed={managed}
      projectId={managed?.projectId ?? props.task.projectId}
    />
  );
}

function EditNote(props: {
  readonly managed: BoardScheduleManagedTask | null;
  readonly projectId: ProjectId;
  readonly boardEnvironmentId: EnvironmentId;
}) {
  const projectTitle = useProjectTitle(props.boardEnvironmentId, props.projectId);
  if (props.managed === null) {
    return (
      <p className="mx-6 mt-4 text-xs text-muted-foreground">
        Made by hand for {projectTitle}. If you export its t3o.json, this task goes into the file
        and the file manages it from then on.
      </p>
    );
  }
  return (
    <div className="mx-6 mt-4 flex flex-col gap-1 rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-xs text-foreground">
      <span>
        Managed by {projectTitle}&apos;s t3o.json. You can edit it here, but the next import of that
        file puts back what the file says
        {props.managed.editedByHand ? ", undoing the edits you made" : ""}. To change it for good,
        edit t3o.json, commit, then import.
      </span>
      <Link
        className="w-fit underline underline-offset-2"
        params={{ projectId: props.projectId, tab: "schedules" }}
        to="/settings/board/projects/$projectId/$tab"
      >
        Open {projectTitle} › Schedules
      </Link>
    </div>
  );
}

/** The page intro's sentence, shown only when a file manages any task. */
export function BoardScheduledTasksIntro() {
  const { data } = useManagedScheduleTasks();
  if (data === null || data.tasks.length === 0) return null;
  return (
    <p className="mb-3 flex flex-wrap items-center gap-1 px-3 text-xs text-muted-foreground sm:px-4">
      A task marked
      <span className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-board-11">
        <FileJsonIcon className="size-3" />
        From t3o.json
      </span>
      is managed by a project&apos;s file: you can edit it here, but that project&apos;s next import
      puts back what the file says.
    </p>
  );
}

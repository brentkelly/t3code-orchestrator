/**
 * T3o: a project's Import & export tab. Import reads the `t3o.json`
 * committed on the default branch and replaces this project's differences,
 * after the confirmation. Export writes the file into the project's checkout,
 * uncommitted; with no checkout it is a download.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  BoardProjectExportResult,
  BoardProjectStageConfigShell,
  ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Clock3Icon, CopyIcon, DownloadIcon, UploadIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import type { BoardImportCandidates } from "./BoardImportNotice";
import { BoardImportConfirmDialog } from "./BoardImportConfirmDialog";
import { useBoardSettingsContext } from "./BoardSettingsLayout";
import {
  boardScheduleMachineNamer,
  refreshBoardSchedules,
  useBoardSchedules,
} from "../schedules/useBoardSchedules";
import {
  boardImportScheduleMark,
  boardImportScheduleReason,
  orderBoardImportSchedules,
} from "./boardProjectSettings.logic";

const COMMIT_COMMAND = 'git add t3o.json && git commit -m "chore: export t3o pipeline" && git push';

export function BoardProjectImportTab(props: {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly config: BoardProjectStageConfigShell;
  readonly imports: BoardImportCandidates;
}) {
  const { environmentId, canWrite } = useBoardSettingsContext();
  const { candidates, refresh } = props.imports;
  const exportFile = useAtomCommand(boardEnvironment.exportProjectFile, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const [exported, setExported] = useState<BoardProjectExportResult | null>(null);
  const candidate = candidates?.[0] ?? null;
  const schedules = useBoardSchedules(environmentId);
  const workers = useAtomValue(boardEnvironment.workersAtom(environmentId));
  const namer = boardScheduleMachineNamer(schedules, workers);
  const fileSchedules = (schedules?.schedules ?? []).filter(
    (row) => row.projectId === props.projectId,
  );
  const handMade = (schedules?.handMade ?? []).filter(
    (task) => task.projectId === props.projectId && task.schedule !== null,
  );
  const schedulesOnly = candidate?.preview?.schedulesOnly === true;

  if (!canWrite) {
    return (
      <p className="mx-3 text-sm text-muted-foreground sm:mx-4">
        Importing and exporting a project&apos;s pipeline needs permission to change settings.
      </p>
    );
  }

  const status =
    candidate === null
      ? "Checking the repo…"
      : candidate.status === "none"
        ? "No t3o.json on the default branch."
        : candidate.status === "unavailable"
          ? (candidate.reason ?? "The project's checkout can't be read.")
          : candidate.status === "matches"
            ? "Matches this project."
            : schedulesOnly
              ? "Differs · schedules only."
              : "Differs from this project.";

  const onExport = (excludeHandMade = false) => {
    void exportFile({
      environmentId,
      input: { projectId: props.projectId, ...(excludeHandMade ? { excludeHandMade } : {}) },
    }).then((result) => {
      if (result._tag === "Failure") {
        boardToast({
          title: "Couldn't export",
          description: describeBoardCommandFailure(result),
          tone: "error",
        });
        return;
      }
      setExported(result.value);
      refreshBoardSchedules(environmentId, props.projectId);
      if (result.value.outcome === "download") download(result.value.content);
      if (excludeHandMade) {
        boardToast({
          title: "Exported again without the hand-made tasks.",
          description: "They keep running as hand-made scheduled tasks.",
        });
      }
    });
  };
  const exportedHandMade = exported?.handMade ?? [];

  return (
    <div className="mx-3 flex flex-col gap-3 sm:mx-4">
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
        <div className="flex items-center gap-2">
          <UploadIcon className="size-4 text-muted-foreground" />
          <span className="text-board-13-5 font-medium text-foreground">Import from the repo</span>
          <span className="flex-1" />
          <Button size="xs" variant="ghost" onClick={refresh}>
            Check again
          </Button>
          <Button
            disabled={candidate?.status !== "differs"}
            onClick={() => setConfirming(true)}
            size="xs"
          >
            Import…
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          The board is where this project&apos;s pipeline, CI and schedules live. Import reads
          t3o.json at the root of the default branch and replaces this project&apos;s differences.{" "}
          {status}
          {candidate?.blobSha
            ? ` (${candidate.blobSha.slice(0, 7)}${candidate.asOfLastFetch ? ", as of last fetch" : ""})`
            : ""}
        </span>
        {schedulesOnly && candidate?.preview?.schedules !== undefined ? (
          <div className="flex flex-col gap-0.5 text-xs">
            <span className="text-foreground">
              Pipeline and CI match. Only the schedules differ:
            </span>
            {orderBoardImportSchedules(candidate.preview.schedules).map((row) => (
              <span className="text-muted-foreground" key={row.fileId}>
                {boardImportScheduleMark(row.kind)} {boardImportScheduleReason(row)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
        <div className="flex items-center gap-2">
          <DownloadIcon className="size-4 text-muted-foreground" />
          <span className="text-board-13-5 font-medium text-foreground">Export to the repo</span>
          <span className="flex-1" />
          <Button size="xs" variant="outline" onClick={() => onExport()}>
            Export
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          Writes this project&apos;s differences, CI steps and schedules to t3o.json in the project
          root, overwriting the file if there is one. Machines aren&apos;t written. Nothing is
          committed for you.
        </span>
        <span className="text-xs text-muted-foreground">
          Right now:{" "}
          {fileSchedules.length + handMade.length === 0
            ? "no schedules"
            : `${fileSchedules.length + handMade.length} ${fileSchedules.length + handMade.length === 1 ? "schedule" : "schedules"}${handMade.length === 0 ? "" : ` (${handMade.length} made by hand)`}`}
          .
        </span>
        {handMade.length > 0 && exported === null ? (
          <span className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Clock3Icon className="mt-px size-3.5 shrink-0" />
            Includes{" "}
            {handMade.length === 1
              ? "1 hand-made scheduled task"
              : `${handMade.length} hand-made scheduled tasks`}
            : {handMade.map((task) => `'${task.title}'`).join(", ")}. Once exported, t3o.json
            manages {handMade.length === 1 ? "it" : "them"} and the next import overwrites hand
            edits.
          </span>
        ) : null}
        {exported?.warnings?.map((warning) => (
          <span className="text-xs text-warning-foreground" key={warning}>
            ! {warning}
          </span>
        ))}
        {exported?.outcome === "written" ? (
          <div className="flex flex-col gap-1.5 rounded-lg border border-attention/40 bg-attention/8 px-3 py-2 text-xs">
            <span className="font-medium text-foreground">Written, but not committed</span>
            <span className="text-muted-foreground">
              {exported.path} is uncommitted. Nobody else sees it until you commit and push it.
            </span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1 font-mono text-board-11">
                {COMMIT_COMMAND}
              </code>
              <Button
                aria-label="Copy the git command"
                onClick={() => void navigator.clipboard.writeText(COMMIT_COMMAND)}
                size="icon-xs"
                variant="ghost"
              >
                <CopyIcon />
              </Button>
            </div>
            {exportedHandMade.length > 0 ? (
              <div className="mt-1 flex flex-col gap-1 border-t border-attention/30 pt-2">
                <span className="font-medium text-foreground">
                  Also added{" "}
                  {exportedHandMade.length === 1
                    ? "1 hand-made scheduled task"
                    : `${exportedHandMade.length} hand-made scheduled tasks`}{" "}
                  to the file
                </span>
                {exportedHandMade.map((task) => (
                  <span className="flex flex-wrap items-center gap-1.5" key={task.taskId}>
                    <span className="text-foreground">{task.title}</span>
                    <code className="font-mono text-board-11 text-muted-foreground">
                      {task.fileId}
                    </code>
                    <span className="text-muted-foreground">
                      runs on {namer(task.environmentId)} · machine not written to the file
                    </span>
                  </span>
                ))}
                <span className="text-muted-foreground">
                  It now shows &apos;From t3o.json&apos; on Scheduled tasks, and the next import of
                  this file overwrites hand edits to it. Anyone who imports the file picks their own
                  machine.
                </span>
                <span className="flex gap-3">
                  <Link className="text-foreground hover:underline" to="/settings/scheduled-tasks">
                    Open Scheduled tasks
                  </Link>
                  <button
                    className="cursor-pointer text-foreground hover:underline"
                    onClick={() => onExport(true)}
                    type="button"
                  >
                    Export again without them
                  </button>
                </span>
              </div>
            ) : null}
          </div>
        ) : exported?.outcome === "download" ? (
          <span className="text-xs text-muted-foreground">
            Downloaded instead: {exported.reason}
          </span>
        ) : null}
      </div>
      {confirming && candidate !== null ? (
        <BoardImportConfirmDialog
          candidate={candidate}
          onCancel={() => setConfirming(false)}
          onImporting={(done) => {
            setConfirming(false);
            props.imports.hide(candidate);
            void done.then((imported) => (imported ? refresh() : props.imports.restore(candidate)));
          }}
          projectTitle={props.projectTitle}
        />
      ) : null}
    </div>
  );
}

function download(content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "t3o.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

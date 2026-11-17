/**
 * T3o: the import confirmation — the only place an import applies.
 * It shows the summary chips, every warning, the stages it creates, and the
 * full text of every new or changed command and prompt, so a merged
 * `t3o.json` can't install commands behind a "3 steps" chip.
 */
import {
  BOARD_SEED_STAGES,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  type BoardProjectImportCandidate,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
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
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import {
  boardScheduleMachineNamer,
  refreshBoardSchedules,
  useBoardSchedules,
  useCanOperateSchedules,
} from "../schedules/useBoardSchedules";
import { BoardImportSchedulesSection } from "./BoardImportSchedulesSection";
import {
  boardImportFooterText,
  boardImportPrimaryLabel,
  boardImportResultToast,
  boardImportScheduleChips,
  boardImportScheduleMark,
  boardImportScheduleSummary,
  boardSchedulePlacement,
  boardImportSummaryChips,
  type BoardSchedulePlacements,
} from "./boardProjectSettings.logic";
import { useBoardSettingsContext } from "./BoardSettingsLayout";

export function BoardImportConfirmDialog(props: {
  readonly candidate: BoardProjectImportCandidate;
  readonly projectTitle: string;
  readonly onCancel: () => void;
  /** Fired as the import starts, so the caller can close and hide at once;
      `done` settles true once the server has imported. Failures toast here. */
  readonly onImporting: (done: Promise<boolean>) => void;
}) {
  const { environmentId } = useBoardSettingsContext();
  const configs = useAtomValue(boardEnvironment.projectStageConfigsAtom(environmentId));
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const stages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  const importFile = useAtomCommand(boardEnvironment.importProjectFile, { reportFailure: false });
  const retrySchedules = useAtomCommand(boardEnvironment.retrySchedules, { reportFailure: false });
  const navigate = useNavigate();
  const schedulesList = useBoardSchedules(environmentId);
  const canPlace = useCanOperateSchedules(environmentId);
  const [placements, setPlacements] = useState<BoardSchedulePlacements>({});
  const { candidate } = props;
  const preview = candidate.preview;
  if (preview === null || candidate.blobSha === null) return null;
  const scheduleRows = preview.schedules ?? [];
  const summary = boardImportScheduleSummary(scheduleRows, placements);
  const scheduleChips = boardImportScheduleChips(summary);
  const footer = boardImportFooterText(summary);
  // "This server" is the board server this client reads the board from.
  const serverEnvironmentId = schedulesList?.serverEnvironmentId ?? environmentId;
  const machineLabel = boardScheduleMachineNamer({ serverEnvironmentId });
  const pipelineListed =
    preview.createStages.length +
      Object.keys(preview.delta.stageSwitches).length +
      Object.keys(preview.delta.overrides).length >
    0;
  const labelOf = (stageId: string) =>
    preview.createStages.find((stage) => stage.stageId === stageId)?.label ??
    stages.find((stage) => stage.stageId === stageId)?.label ??
    stageId;
  const version = configs[candidate.projectId]?.version ?? EMPTY_BOARD_PROJECT_STAGE_CONFIG.version;

  const onImport = () => {
    if (candidate.blobSha === null) return;
    const done = importFile({
      environmentId,
      input: {
        projectId: candidate.projectId,
        blobSha: candidate.blobSha,
        expectedConfigVersion: version,
        // Only rows in the preview can be placed; the server ignores the rest.
        schedulePlacements: Object.fromEntries(
          scheduleRows
            .filter((row) => row.kind !== "delete")
            .map((row) => [row.fileId, boardSchedulePlacement(placements, row.fileId)]),
        ),
      },
    }).then((result) => {
      if (result._tag === "Failure") {
        boardToast({
          title: "Couldn't import",
          description: describeBoardCommandFailure(result),
          tone: "error",
        });
        return false;
      }
      const outcome = result.value;
      if (outcome.outcome === "imported") {
        refreshBoardSchedules(environmentId, candidate.projectId);
        const toast = boardImportResultToast({
          projectTitle: props.projectTitle,
          outcome: outcome.schedules,
          machineLabel,
        });
        const failedIds = outcome.schedules?.failures.map((failure) => failure.fileId) ?? [];
        const openSchedules = () =>
          void navigate({
            to: "/settings/board/projects/$projectId/$tab",
            params: { projectId: candidate.projectId, tab: "schedules" },
          });
        boardToast({
          title: toast.title,
          ...(toast.description === null ? {} : { description: toast.description }),
          ...(toast.failed
            ? {
                tone: "warning" as const,
                persistent: true,
                actions: [
                  {
                    label: "Retry",
                    run: () => void retry(failedIds),
                  },
                  { label: "Open Schedules", run: openSchedules },
                ],
              }
            : {}),
        });
        return true;
      }
      boardToast({
        title: "Nothing imported",
        description:
          outcome.outcome === "file-changed"
            ? "The committed file changed since you opened this. Check again."
            : outcome.outcome === "version-mismatch"
              ? "Changed elsewhere, reload."
              : outcome.reason,
        tone: "error",
      });
      return false;
    });
    props.onImporting(done);
  };

  const retry = (fileIds: ReadonlyArray<string>) =>
    retrySchedules({
      environmentId,
      input: { projectId: candidate.projectId, fileIds: [...fileIds] },
    }).then((result) => {
      refreshBoardSchedules(environmentId, candidate.projectId);
      if (result._tag === "Failure") {
        boardToast({
          title: "Couldn't retry",
          description: describeBoardCommandFailure(result),
          tone: "error",
        });
        return;
      }
      const { failures, setUp } = result.value;
      if (failures.length === 0) {
        boardToast({ title: `${setUp === 1 ? "1 schedule" : `${setUp} schedules`} scheduled.` });
        return;
      }
      boardToast({
        title: `${failures.length === 1 ? "1 schedule" : `${failures.length} schedules`} still failed.`,
        description: failures
          .map(
            (failure) =>
              `'${failure.title}' on ${machineLabel(failure.environmentId)}: ${failure.reason}.`,
          )
          .join(" "),
        tone: "warning",
        persistent: true,
        actions: [
          { label: "Retry", run: () => void retry(failures.map((failure) => failure.fileId)) },
        ],
      });
    });

  const place = (fileId: string, target: EnvironmentId | null) =>
    setPlacements((current) => ({ ...current, [fileId]: target }));

  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : props.onCancel())}>
      <AlertDialogPopup className="max-w-180">
        <AlertDialogHeader>
          <AlertDialogTitle>Import {props.projectTitle}&apos;s t3o.json?</AlertDialogTitle>
          <AlertDialogDescription>
            {preview.schedulesOnly === true
              ? `Only the schedules differ; ${props.projectTitle}'s pipeline and CI already match the file.`
              : `Replaces ${props.projectTitle}'s differences with the file. Global settings and other projects are untouched.`}
          </AlertDialogDescription>
          <div className="flex flex-wrap gap-1 text-xs">
            {[...boardImportSummaryChips(preview), ...scheduleChips.counts].map((chip) => (
              <span className="rounded-md bg-accent px-1.5 py-px text-muted-foreground" key={chip}>
                {chip}
              </span>
            ))}
            {scheduleChips.live === null ? null : (
              <span
                className={
                  summary.scheduled.length === 0
                    ? "rounded-md bg-accent px-1.5 py-px text-muted-foreground"
                    : "rounded-md bg-primary/12 px-1.5 py-px text-foreground"
                }
              >
                {scheduleChips.live}
              </span>
            )}
          </div>
        </AlertDialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-6 pb-6 text-xs max-sm:max-h-none">
          <ul className="flex flex-col gap-1">
            {preview.createStages.map((stage) => (
              <li key={`create:${stage.stageId}`}>
                + creates global stage <b>{stage.label}</b> (off for other projects)
              </li>
            ))}
            {Object.entries(preview.delta.stageSwitches).map(([stageId, on]) => (
              <li key={`switch:${stageId}`}>
                {on ? "+" : "−"} {labelOf(stageId)} {on ? "on" : "off"} for this project
              </li>
            ))}
            {Object.entries(preview.delta.overrides).map(([stageId, patch]) => (
              <li key={`override:${stageId}`}>
                ± {labelOf(stageId)}: {Object.keys(patch).join(", ")}
              </li>
            ))}
            {scheduleRows.map((row) => (
              <li key={`schedule:${row.fileId}`}>
                <span className={row.kind === "create" ? "text-primary" : undefined}>
                  {boardImportScheduleMark(row.kind)}
                </span>{" "}
                schedule <b>{row.title}</b>
              </li>
            ))}
            {preview.schedulesOnly === true && !pipelineListed ? (
              <li className="text-muted-foreground">= pipeline and CI unchanged</li>
            ) : null}
            {preview.delta.warnings.map((warning) => (
              <li className="text-warning-foreground" key={`warning:${warning}`}>
                ! {warning}
              </li>
            ))}
          </ul>
          {scheduleRows.length > 0 ? (
            <BoardImportSchedulesSection
              canPlace={canPlace}
              onPlace={place}
              placements={placements}
              projectTitle={props.projectTitle}
              rows={scheduleRows}
              serverEnvironmentId={serverEnvironmentId}
              serverUtcOffsetMinutes={schedulesList?.serverUtcOffsetMinutes ?? null}
              summary={summary}
            />
          ) : null}
          {preview.texts.length > 0 ? (
            <div className="flex flex-col gap-2">
              <span className="font-medium text-foreground">
                Review every command, prompt and permission setting this import installs:
              </span>
              {preview.texts.map((text) => (
                <div className="flex flex-col gap-1" key={`${text.where}:${text.text}`}>
                  <span className="text-muted-foreground">
                    {text.kind === "command"
                      ? "Command"
                      : text.kind === "prompt"
                        ? "Prompt"
                        : "Setting"}{" "}
                    · {text.where}
                  </span>
                  <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-board-11 whitespace-pre-wrap">
                    {text.text}
                  </pre>
                </div>
              ))}
            </div>
          ) : null}
          {scheduleRows.length > 0 ? (
            <span className="text-muted-foreground">
              {preview.texts.length > 0
                ? "Schedule prompts are shown in full with each schedule above."
                : "Nothing else: the pipeline and CI already match."}
            </span>
          ) : null}
        </div>
        <AlertDialogFooter>
          {footer === null ? null : (
            <span className="mr-auto self-center text-xs text-muted-foreground">{footer}</span>
          )}
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button onClick={onImport}>{boardImportPrimaryLabel(summary)}</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

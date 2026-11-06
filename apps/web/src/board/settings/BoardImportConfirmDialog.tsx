/**
 * T3o: the import confirmation (T3O-49) — the only place an import applies.
 * It shows the summary chips, every warning, the stages it creates, and the
 * full text of every new or changed command and prompt, so a merged
 * `t3o.json` can't install commands behind a "3 steps" chip.
 */
import {
  BOARD_SEED_STAGES,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  type BoardProjectImportCandidate,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
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
import { boardImportSummaryChips } from "./boardProjectSettings.logic";
import { useBoardSettingsContext } from "./BoardSettingsLayout";

export function BoardImportConfirmDialog(props: {
  readonly candidate: BoardProjectImportCandidate;
  readonly projectTitle: string;
  readonly onClose: (imported: boolean) => void;
}) {
  const { environmentId } = useBoardSettingsContext();
  const configs = useAtomValue(boardEnvironment.projectStageConfigsAtom(environmentId));
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const stages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  const importFile = useAtomCommand(boardEnvironment.importProjectFile, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const { candidate } = props;
  const preview = candidate.preview;
  if (preview === null || candidate.blobSha === null) return null;
  const labelOf = (stageId: string) =>
    preview.createStages.find((stage) => stage.stageId === stageId)?.label ??
    stages.find((stage) => stage.stageId === stageId)?.label ??
    stageId;
  const version = configs[candidate.projectId]?.version ?? EMPTY_BOARD_PROJECT_STAGE_CONFIG.version;

  const onImport = () => {
    if (candidate.blobSha === null) return;
    setPending(true);
    void importFile({
      environmentId,
      input: {
        projectId: candidate.projectId,
        blobSha: candidate.blobSha,
        expectedConfigVersion: version,
      },
    }).then((result) => {
      setPending(false);
      if (result._tag === "Failure") {
        boardToast({
          title: "Couldn't import",
          description: describeBoardCommandFailure(result),
          tone: "error",
        });
        return;
      }
      const outcome = result.value;
      if (outcome.outcome === "imported") {
        boardToast({ title: `Imported ${props.projectTitle}'s t3o.json` });
        props.onClose(true);
      } else {
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
      }
    });
  };

  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : props.onClose(false))}>
      <AlertDialogPopup className="max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Import {props.projectTitle}&apos;s t3o.json?</AlertDialogTitle>
          <AlertDialogDescription>
            Replaces {props.projectTitle}&apos;s differences with the file. Global settings and
            other projects are untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto px-6 text-xs">
          <div className="flex flex-wrap gap-1">
            {boardImportSummaryChips(preview).map((chip) => (
              <span className="rounded-md bg-accent px-1.5 py-px text-muted-foreground" key={chip}>
                {chip}
              </span>
            ))}
          </div>
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
            {preview.delta.warnings.map((warning) => (
              <li className="text-warning-foreground" key={`warning:${warning}`}>
                ! {warning}
              </li>
            ))}
          </ul>
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
                  <pre className="overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap">
                    {text.text}
                  </pre>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button disabled={pending} onClick={onImport}>
            Replace and import
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

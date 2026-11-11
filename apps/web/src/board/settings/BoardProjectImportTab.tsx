/**
 * T3o: a project's Import & export tab. Import reads the `t3o.json`
 * committed on the default branch and replaces this project's differences,
 * after the confirmation. Export writes the file into the project's checkout,
 * uncommitted; with no checkout it is a download.
 */
import type {
  BoardProjectExportResult,
  BoardProjectStageConfigShell,
  ProjectId,
} from "@t3tools/contracts";
import { CopyIcon, DownloadIcon, UploadIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import type { BoardImportCandidates } from "./BoardImportNotice";
import { BoardImportConfirmDialog } from "./BoardImportConfirmDialog";
import { useBoardSettingsContext } from "./BoardSettingsLayout";

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
            ? "Imported · up to date."
            : "The committed t3o.json differs from this project's pipeline.";

  const onExport = () => {
    void exportFile({ environmentId, input: { projectId: props.projectId } }).then((result) => {
      if (result._tag === "Failure") {
        boardToast({
          title: "Couldn't export",
          description: describeBoardCommandFailure(result),
          tone: "error",
        });
        return;
      }
      setExported(result.value);
      if (result.value.outcome === "download") download(result.value.content);
    });
  };

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
          Reads t3o.json at the root of the default branch and replaces this project&apos;s
          differences. {status}
          {candidate?.blobSha
            ? ` (${candidate.blobSha.slice(0, 7)}${candidate.asOfLastFetch ? ", as of last fetch" : ""})`
            : ""}
        </span>
      </div>
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
        <div className="flex items-center gap-2">
          <DownloadIcon className="size-4 text-muted-foreground" />
          <span className="text-board-13-5 font-medium text-foreground">Export to the repo</span>
          <span className="flex-1" />
          <Button size="xs" variant="outline" onClick={onExport}>
            Export
          </Button>
        </div>
        <span className="text-xs text-muted-foreground">
          Writes this project&apos;s differences to t3o.json in its checkout, so the pipeline can
          travel with the repo. Nothing is committed for you.
        </span>
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
          onClose={(imported) => {
            setConfirming(false);
            if (imported) refresh();
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

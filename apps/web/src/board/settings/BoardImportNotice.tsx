/**
 * T3o: committed `t3o.json` files waiting to import (T3O-49). The notice
 * lives at the top of Settings → Board and, slim, on the project's page;
 * it never interrupts the board. "No thanks" remembers the file's blob sha,
 * so the notice returns only when the committed file changes.
 */
import { type BoardProjectImportCandidate, type ProjectId } from "@t3tools/contracts";
import { FileJsonIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import { BoardImportConfirmDialog } from "./BoardImportConfirmDialog";
import { boardImportSummaryChips } from "./boardProjectSettings.logic";
import { useBoardSettingsContext, useBoardSettingsProjects } from "./BoardSettingsLayout";

/** Import candidates for some projects, read when the caller mounts (and on
    "Check again"). Only for clients that may edit settings. */
export function useBoardImportCandidates(projectIds: ReadonlyArray<ProjectId>) {
  const { environmentId, canWrite, setImportWaiting } = useBoardSettingsContext();
  const read = useAtomCommand(boardEnvironment.projectImportCandidates, { reportFailure: false });
  const [candidates, setCandidates] = useState<ReadonlyArray<BoardProjectImportCandidate> | null>(
    null,
  );
  const [nonce, setNonce] = useState(0);
  const key = projectIds.join("\u0000");
  useEffect(() => {
    if (!canWrite || projectIds.length === 0) return;
    let cancelled = false;
    void read({
      environmentId,
      input: { projectIds, refresh: nonce > 0 },
    }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setCandidates(result.value);
      for (const candidate of result.value) {
        setImportWaiting(
          candidate.projectId,
          candidate.status === "differs" && !candidate.dismissed,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [canWrite, environmentId, key, nonce]);
  return { candidates, refresh: () => setNonce((value) => value + 1) };
}

/** Settings → Board: one row per project whose committed file differs. */
export function BoardImportNotices() {
  const { environmentId } = useBoardSettingsContext();
  const projects = useBoardSettingsProjects(environmentId);
  const ids = useMemo(() => projects.map((project) => project.id), [projects]);
  const { candidates, refresh } = useBoardImportCandidates(ids);
  const waiting = (candidates ?? []).filter(
    (candidate) => candidate.status === "differs" && !candidate.dismissed,
  );
  if (waiting.length === 0) return null;
  const titleOf = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.title ?? projectId;
  return (
    <div className="mx-3 flex flex-col gap-1 rounded-xl border border-info/40 bg-info/6 px-4 py-3 sm:mx-4">
      {waiting.length > 1 ? (
        <span className="text-[13px] font-medium text-foreground">
          {waiting.length} projects have a t3o.json to import
        </span>
      ) : null}
      {waiting.map((candidate) => (
        <ImportNoticeRow
          candidate={candidate}
          key={candidate.projectId}
          onDone={refresh}
          title={titleOf(candidate.projectId)}
        />
      ))}
    </div>
  );
}

/** The slim version at the top of a project's page. */
export function BoardImportNoticeForProject(props: {
  readonly projectId: ProjectId;
  readonly title: string;
}) {
  const ids = useMemo(() => [props.projectId], [props.projectId]);
  const { candidates, refresh } = useBoardImportCandidates(ids);
  const candidate = candidates?.[0];
  if (candidate === undefined || candidate.status !== "differs" || candidate.dismissed) return null;
  return (
    <div className="mx-3 rounded-xl border border-info/40 bg-info/6 px-4 py-2 sm:mx-4">
      <ImportNoticeRow candidate={candidate} onDone={refresh} title={props.title} />
    </div>
  );
}

function ImportNoticeRow(props: {
  readonly candidate: BoardProjectImportCandidate;
  readonly title: string;
  readonly onDone: () => void;
}) {
  const { environmentId } = useBoardSettingsContext();
  const dismiss = useAtomCommand(boardEnvironment.dismissProjectImport, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const { candidate } = props;
  const chips = candidate.preview === null ? [] : boardImportSummaryChips(candidate.preview);
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <FileJsonIcon className="size-4 text-info" />
      <div className="flex min-w-0 flex-col">
        <span className="text-[13px] text-foreground">
          {props.title} has a t3o.json. Import its pipeline and CI settings?
        </span>
        <span className="text-xs text-muted-foreground">
          {candidate.blobSha?.slice(0, 7)}
          {candidate.asOfLastFetch ? " · as of last fetch" : ""}
          {chips.length > 0 ? ` · ${chips.join(", ")}` : ""}
        </span>
      </div>
      <span className="flex-1" />
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          if (candidate.blobSha === null) return;
          void dismiss({
            environmentId,
            input: { projectId: candidate.projectId, blobSha: candidate.blobSha },
          }).then((result) => {
            if (result._tag === "Failure") {
              boardToast({
                title: "Couldn't dismiss",
                description: describeBoardCommandFailure(result),
                tone: "error",
              });
            }
            props.onDone();
          });
        }}
      >
        No thanks
      </Button>
      <Button size="xs" onClick={() => setConfirming(true)}>
        Import…
      </Button>
      {confirming ? (
        <BoardImportConfirmDialog
          candidate={candidate}
          onClose={(imported) => {
            setConfirming(false);
            if (imported) props.onDone();
          }}
          projectTitle={props.title}
        />
      ) : null}
    </div>
  );
}

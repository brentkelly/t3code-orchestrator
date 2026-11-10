/**
 * T3o: committed `t3o.json` files waiting to import (T3O-49). The notice
 * lives at the top of Settings → Board and, slim, on the project's page;
 * it never interrupts the board. "No thanks" remembers the file's blob sha,
 * so the notice returns only when the committed file changes.
 */
import { type BoardProjectImportCandidate, type ProjectId } from "@t3tools/contracts";
import { FileJsonIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

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
  const readCandidates = useEffectEvent((forEnvironment: typeof environmentId, refresh: boolean) =>
    projectIds.length === 0
      ? null
      : read({ environmentId: forEnvironment, input: { projectIds, refresh } }),
  );
  const applyCandidates = useEffectEvent((value: ReadonlyArray<BoardProjectImportCandidate>) => {
    setCandidates(value);
    for (const candidate of value) {
      setImportWaiting(candidate.projectId, candidate.status === "differs" && !candidate.dismissed);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads import candidates from the board server; they are not on the live board stream.
  useEffect(() => {
    if (!canWrite) return;
    const pending = readCandidates(environmentId, nonce > 0);
    if (pending === null) return;
    let cancelled = false;
    void pending.then((result) => {
      if (cancelled || result._tag !== "Success") return;
      applyCandidates(result.value);
    });
    return () => {
      cancelled = true;
    };
  }, [
    canWrite,
    environmentId,
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A different set of projects must read its own candidates.
    key,
    nonce,
  ]);
  return { candidates, refresh: () => setNonce((value) => value + 1) };
}

/** Settings → Board: one row per project whose committed file differs. */
export function BoardImportNotices() {
  const { environmentId } = useBoardSettingsContext();
  const projects = useBoardSettingsProjects(environmentId);
  const ids = projects.map((project) => project.id);
  const { candidates, refresh } = useBoardImportCandidates(ids);
  const waiting = (candidates ?? []).filter(
    (candidate) => candidate.status === "differs" && !candidate.dismissed,
  );
  if (waiting.length === 0) return null;
  const titleOf = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.title ?? projectId;
  return (
    <div className="mx-3 flex flex-col gap-1 rounded-xl border border-attention/40 bg-attention/6 px-4 py-3 sm:mx-4">
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

export type BoardImportCandidates = ReturnType<typeof useBoardImportCandidates>;

/** The slim version at the top of a project's page. It shares the page's
    candidates with the Import tab, so an import or dismiss updates both. */
export function BoardImportNoticeForProject(props: {
  readonly imports: BoardImportCandidates;
  readonly title: string;
}) {
  const { candidates, refresh } = props.imports;
  const candidate = candidates?.[0];
  if (candidate === undefined || candidate.status !== "differs" || candidate.dismissed) return null;
  return (
    <div className="mx-3 rounded-xl border border-attention/40 bg-attention/6 px-4 py-2 sm:mx-4">
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
      <FileJsonIcon className="size-4 text-attention-foreground" />
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

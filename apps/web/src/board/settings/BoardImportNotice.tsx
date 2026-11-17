/**
 * T3o: committed `t3o.json` files waiting to import. The notice
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
import {
  boardImportScheduleChips,
  boardImportScheduleSummary,
  boardImportSummaryChips,
} from "./boardProjectSettings.logic";
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
  // Rows imported or dismissed here hide at once; the server persists behind them.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
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
  const setHiddenFor = (candidate: BoardProjectImportCandidate, hide: boolean) => {
    const id = hiddenKey(candidate);
    setHidden((current) => {
      const next = new Set(current);
      if (hide) next.add(id);
      else next.delete(id);
      return next;
    });
    setImportWaiting(candidate.projectId, !hide);
  };
  return {
    candidates,
    refresh: () => setNonce((value) => value + 1),
    isWaiting: (candidate: BoardProjectImportCandidate) =>
      candidate.status === "differs" && !candidate.dismissed && !hidden.has(hiddenKey(candidate)),
    hide: (candidate: BoardProjectImportCandidate) => setHiddenFor(candidate, true),
    restore: (candidate: BoardProjectImportCandidate) => setHiddenFor(candidate, false),
  };
}

const hiddenKey = (candidate: BoardProjectImportCandidate) =>
  `${candidate.projectId}\u0000${candidate.blobSha ?? ""}`;

/** Settings → Board: one row per project whose committed file differs. */
export function BoardImportNotices() {
  const { environmentId } = useBoardSettingsContext();
  const projects = useBoardSettingsProjects(environmentId);
  const ids = projects.map((project) => project.id);
  const imports = useBoardImportCandidates(ids);
  const waiting = (imports.candidates ?? []).filter(imports.isWaiting);
  if (waiting.length === 0) return null;
  const titleOf = (projectId: string) =>
    projects.find((project) => project.id === projectId)?.title ?? projectId;
  return (
    <div className="mx-3 flex flex-col gap-1 rounded-xl border border-attention/40 bg-attention/6 px-4 py-3 sm:mx-4">
      {waiting.length > 1 ? (
        <span className="text-board-13 font-medium text-foreground">
          {waiting.length} projects have a t3o.json to import
        </span>
      ) : null}
      {waiting.map((candidate) => (
        <ImportNoticeRow
          candidate={candidate}
          imports={imports}
          key={candidate.projectId}
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
  const candidate = props.imports.candidates?.[0];
  if (candidate === undefined || !props.imports.isWaiting(candidate)) return null;
  return (
    <div className="mx-3 rounded-xl border border-attention/40 bg-attention/6 px-4 py-2 sm:mx-4">
      <ImportNoticeRow candidate={candidate} imports={props.imports} title={props.title} />
    </div>
  );
}

function ImportNoticeRow(props: {
  readonly candidate: BoardProjectImportCandidate;
  readonly title: string;
  readonly imports: BoardImportCandidates;
}) {
  const { environmentId } = useBoardSettingsContext();
  const dismiss = useAtomCommand(boardEnvironment.dismissProjectImport, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const { candidate, imports } = props;
  const preview = candidate.preview;
  const schedulesOnly = preview?.schedulesOnly === true;
  const scheduleCounts =
    preview === null
      ? []
      : boardImportScheduleChips(boardImportScheduleSummary(preview.schedules ?? [], {})).counts;
  const chips =
    preview === null
      ? []
      : [
          ...(schedulesOnly ? ["Schedules only"] : boardImportSummaryChips(preview)),
          ...scheduleCounts,
        ];
  return (
    <div className="flex flex-wrap items-center gap-2 py-1">
      <FileJsonIcon className="size-4 text-attention-foreground" />
      <div className="flex min-w-0 flex-col">
        <span className="text-board-13 text-foreground">
          {schedulesOnly
            ? `${props.title}'s t3o.json differs only in its schedules. Import to review them; nothing runs until you pick a machine.`
            : `${props.title} has a t3o.json. Import its ${scheduleCounts.length > 0 ? "pipeline, CI and schedules" : "pipeline and CI settings"}?`}
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
          imports.hide(candidate);
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
              imports.restore(candidate);
              return;
            }
            imports.refresh();
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
          onCancel={() => setConfirming(false)}
          onImporting={(done) => {
            setConfirming(false);
            imports.hide(candidate);
            void done.then((imported) =>
              imported ? imports.refresh() : imports.restore(candidate),
            );
          }}
          projectTitle={props.title}
        />
      ) : null}
    </div>
  );
}

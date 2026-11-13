/**
 * Settings → Workers (prototype 3.1, 3.2). This server's row is first and
 * permanent; the rest are machines that joined with a code and dial the
 * board. Connected stays grey; amber means blocked. Status is live from the
 * board server.
 */
import {
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  type BoardWorkerId,
  type BoardWorkerJoinCodeCreated,
  type BoardWorkerView,
  type EnvironmentId,
} from "@t3tools/contracts";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState, type ReactNode } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoardHint } from "../BoardHint";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { AddWorkerDialog } from "./AddWorkerDialog";
import { useNowAtDeadlines, type BoardWorkersView } from "./boardWorkersState";
import { joinCodeInPlay, joinDialogPhase, openJoinCodes } from "./joinDialog";
import { RemoveWorkerDialog } from "./RemoveWorkerDialog";
import { RenameWorkerDialog } from "./RenameWorkerDialog";
import { localWorkerLabel } from "./threadWorker";
import {
  clockTime,
  T3O_UPDATE_COMMAND,
  workerLastSeenDeadlines,
  workerStatusPresentation,
  type WorkerStatusPresentation,
  type WorkerTone,
} from "./workerCopy";
import { boardWorkerCapacityLines, boardWorkerHoldLine } from "./workerCapacity";
import { CopyCommand, WorkerAbbreviationBadge } from "./workerUi";

const TONE_BADGE: Record<WorkerTone, "outline" | "info" | "warning" | "success"> = {
  neutral: "outline",
  running: "info",
  warning: "warning",
  done: "success",
};

/** The board server as a worker, for the Rename dialog: its label lives in board settings. */
const localWorkerView = (label: string): BoardWorkerView =>
  ({
    id: BOARD_LOCAL_WORKER_ID,
    label,
    abbreviation: BOARD_LOCAL_WORKER_ABBREVIATION,
    addedAt: "1970-01-01T00:00:00.000Z",
    status: { state: "online", lastSeenAt: null, t3oVersion: null, protocolVersion: null },
    snapshot: null,
  }) as unknown as BoardWorkerView;

function joinedDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The Add worker button and everything it opens, so the page header can hold the button. */
export function useAddWorker(input: {
  readonly environmentId: EnvironmentId;
  readonly workers: BoardWorkersView;
}) {
  const createJoinCode = useAtomCommand(boardEnvironment.createWorkerJoinCode, {
    reportFailure: false,
  });
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<BoardWorkerJoinCodeCreated | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const createCode = async () => {
    setCreated(null);
    setCreating(true);
    setCreateError(null);
    const result = await createJoinCode({ environmentId: input.environmentId, input: {} });
    setCreating(false);
    if (result._tag === "Success") setCreated(result.value);
    else setCreateError(describeBoardCommandFailure(result));
  };

  const start = () => {
    setOpen(true);
    // A code being created is the one this opens on; never mint a second.
    if (creating) return;
    // A code still in play reopens where it was; anything else starts a new one.
    if (created !== null) {
      const phase = joinDialogPhase({
        codeId: created.codeId,
        expiresAt: created.expiresAt,
        state: input.workers.state,
        nowMs: Date.now(),
      });
      if (joinCodeInPlay(phase)) return;
    }
    void createCode();
  };

  return {
    start,
    dialogProps: {
      open,
      onOpenChange: setOpen,
      created,
      creating,
      createError,
      onCreateCode: () => void createCode(),
    },
    forget: (codeId: string) => {
      if (created?.codeId === codeId) setCreated(null);
    },
  };
}

export function AddWorkerButton(props: { readonly onClick: () => void }) {
  return (
    <Button size="sm" onClick={props.onClick}>
      <PlusIcon />
      Add worker
    </Button>
  );
}

export function WorkersSection(props: {
  readonly environmentId: EnvironmentId;
  readonly workers: BoardWorkersView;
  readonly addWorker: ReturnType<typeof useAddWorker>;
  readonly boardUrl: string;
  readonly boardUrlIsFallback: boolean;
  readonly onSetBoardAddress: () => void;
  readonly onSetUpProjects: () => void;
}) {
  const { environmentId, workers, addWorker } = props;
  const boardServer = useEnvironment(environmentId);
  const localVersion = boardServer?.serverConfig?.environment.serverVersion ?? null;
  const removeWorker = useAtomCommand(boardEnvironment.removeWorker, { reportFailure: false });
  const cancelJoinCode = useAtomCommand(boardEnvironment.cancelWorkerJoinCode, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<BoardWorkerView | null>(null);
  const [removing, setRemoving] = useState<BoardWorkerView | null>(null);
  const { state } = workers;
  // "Last seen" and the open codes' expiry are coarse: re-read the clock only when one changes.
  const nowMs = useNowAtDeadlines([
    ...state.workers.flatMap(workerLastSeenDeadlines),
    ...state.joinCodes.map((code) => Date.parse(code.expiresAt)),
  ]);
  const openCodes = openJoinCodes(state, nowMs);

  const confirmRemove = async (worker: BoardWorkerView) => {
    setRemoving(null);
    const result = await removeWorker({ environmentId, input: { workerId: worker.id } });
    if (result._tag !== "Success") {
      toastManager.add({ type: "error", title: describeBoardCommandFailure(result) });
      return;
    }
    toastManager.add({
      type: "success",
      title: `${worker.label} was removed`,
      description: result.value.revoked
        ? undefined
        : `${worker.label} couldn't be reached, so the board's sessions there weren't revoked.`,
    });
  };

  const cancelCodes = async () => {
    for (const code of openCodes) {
      const result = await cancelJoinCode({ environmentId, input: { codeId: code.codeId } });
      if (result._tag !== "Success") {
        toastManager.add({ type: "error", title: describeBoardCommandFailure(result) });
        return;
      }
      addWorker.forget(code.codeId);
    }
  };

  const firstExpiry = openCodes
    .map((code) => code.expiresAt)
    .toSorted()
    .at(0);

  return (
    <>
      {firstExpiry === undefined ? null : (
        <div className="mx-3 mb-2 flex items-center gap-2 text-board-12-5 text-muted-foreground sm:mx-4">
          <span>
            {openCodes.length} join {openCodes.length === 1 ? "code" : "codes"} open ·{" "}
            {openCodes.length === 1 ? "expires" : "first expires"} {clockTime(firstExpiry)}
          </span>
          <Button size="xs" variant="ghost" onClick={() => void cancelCodes()}>
            {openCodes.length === 1 ? "Cancel" : "Cancel all"}
          </Button>
        </div>
      )}
      <div className="mx-3 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs sm:mx-4">
        <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_88px] gap-3 border-b border-border px-4 py-2 text-board-11-5 font-medium text-muted-foreground max-md:hidden">
          <span>Worker</span>
          <span>Status</span>
          <span />
        </div>
        <WorkerRow
          id="board-worker-local"
          name={`${localWorkerLabel(state)} (local)`}
          abbreviation={BOARD_LOCAL_WORKER_ABBREVIATION}
          tags={<Badge variant="secondary">Board</Badge>}
          subline={`${localVersion === null ? "" : `T3o ${localVersion} · `}runs planning`}
          status={{ label: "Connected", detail: null, tone: "neutral", tooltip: null }}
          extra={
            <WorkerCapacity
              environmentId={environmentId}
              workerId={BOARD_LOCAL_WORKER_ID}
              name={localWorkerLabel(state)}
              live
            />
          }
          actions={
            <>
              <BoardHint label="The server hosting the board can't be removed.">
                <Badge variant="secondary">Built-in</Badge>
              </BoardHint>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setRenaming(localWorkerView(localWorkerLabel(state)))}
              >
                Rename…
              </Button>
            </>
          }
        />
        {state.workers.map((worker) => {
          const release = worker.t3oRelease ?? worker.status.t3oVersion;
          const joined = worker.joinedAt ?? worker.addedAt;
          return (
            <WorkerRow
              key={worker.id}
              id={`board-worker-${worker.id}`}
              name={worker.label}
              abbreviation={worker.abbreviation ?? null}
              subline={`${release === null ? "" : `T3o ${release} · `}joined ${joinedDate(joined)}`}
              status={workerStatusPresentation(worker, nowMs)}
              extra={
                worker.status.state === "incompatible" ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-board-11-5 text-muted-foreground">
                      Needs T3o {BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer. On{" "}
                      {worker.label}, run:
                    </span>
                    <CopyCommand command={T3O_UPDATE_COMMAND} target="update command" />
                  </div>
                ) : (
                  <WorkerCapacity
                    environmentId={environmentId}
                    workerId={worker.id}
                    name={worker.label}
                    live={worker.status.state === "online"}
                  />
                )
              }
              actions={
                <WorkerMenu
                  worker={worker}
                  onRename={() => setRenaming(worker)}
                  onRemove={() => setRemoving(worker)}
                />
              }
            />
          );
        })}
        {state.workers.length === 0 ? (
          <div className="flex flex-col border-t border-border px-4 py-3">
            <span className="text-board-13 font-medium">No other workers</span>
            <span className="max-w-md text-xs text-muted-foreground">
              Add a worker to run cards on another machine. It joins with a one-time code and
              connects out to this board.
            </span>
          </div>
        ) : null}
      </div>

      <AddWorkerDialog
        environmentId={environmentId}
        {...addWorker.dialogProps}
        boardUrl={props.boardUrl}
        boardUrlIsFallback={props.boardUrlIsFallback}
        onSetBoardAddress={props.onSetBoardAddress}
        onSetUpProjects={props.onSetUpProjects}
      />
      <RenameWorkerDialog
        environmentId={environmentId}
        worker={renaming}
        onClose={() => setRenaming(null)}
      />
      <RemoveWorkerDialog
        environmentId={environmentId}
        worker={removing}
        onCancel={() => setRemoving(null)}
        onConfirm={(worker) => void confirmRemove(worker)}
      />
    </>
  );
}

/** A worker's free capacity, agents, quota and readiness, from its latest snapshot. */
function WorkerCapacity(props: {
  readonly environmentId: EnvironmentId;
  readonly workerId: BoardWorkerId;
  readonly name: string;
  readonly live: boolean;
}) {
  const result = useAtomValue(
    boardEnvironment.capacityAtom({ environmentId: props.environmentId, input: {} }),
  );
  const capacityAction = useAtomCommand(boardEnvironment.capacityAction);
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(props.environmentId));
  const snapshot = AsyncResult.isSuccess(result) ? result.value.get(props.workerId) : undefined;
  if (snapshot === undefined) return null;
  const lines = boardWorkerCapacityLines(snapshot, clockTime, props.name, props.live);
  const holdLine = boardWorkerHoldLine(
    snapshot.hold,
    (cardId) =>
      [...cardsByProject.values()]
        .flatMap((columns) => Object.values(columns).flat())
        .find((card) => card.cardId === cardId)?.key ?? null,
    clockTime,
  );
  return (
    <div
      className={cn(
        "flex w-full max-w-72 flex-col gap-1 text-board-11-5 text-muted-foreground",
        lines.stale !== null && "opacity-60",
      )}
    >
      {lines.stale === null ? null : <span>{lines.stale}</span>}
      {holdLine === null ? null : (
        <span className="font-medium text-info-foreground">{holdLine}</span>
      )}
      {lines.bars.map((bar) => (
        <div key={bar.label} className="grid grid-cols-[2.5rem_1fr] items-center gap-2">
          <span>{bar.label}</span>
          <BoardHint label={bar.tooltip}>
            <MeterBar used={bar.used} amber={bar.used >= 1} label={bar.text} />
          </BoardHint>
        </div>
      ))}
      <span>{lines.agents}</span>
      {lines.over === null ? null : <span className="text-warning-foreground">{lines.over}</span>}
      {lines.providers.map((provider) => (
        <div key={provider.title} className="flex flex-col gap-1 pt-1">
          <span className="truncate text-foreground">{provider.title}</span>
          {provider.signedOut === null ? null : (
            <span className="text-attention-foreground">{provider.signedOut}</span>
          )}
          {provider.windows.map((window) => (
            <div key={window.label} className="grid grid-cols-[6rem_1fr] items-center gap-2">
              <span className="truncate">{window.label}</span>
              <BoardHint label={window.text}>
                <MeterBar used={window.used} amber={window.nearLimit} label={window.text} />
              </BoardHint>
            </div>
          ))}
          {provider.nearLimit === null ? null : (
            <span className="text-warning-foreground">{provider.nearLimit}</span>
          )}
        </div>
      ))}
      {lines.readiness === null ? null : (
        <span className="flex items-center gap-2">
          <span className={lines.notReady > 0 ? "text-warning-foreground" : undefined}>
            {lines.readiness}
          </span>
          <Button
            disabled={lines.stale !== null}
            size="xs"
            variant="ghost"
            onClick={() =>
              void capacityAction({
                environmentId: props.environmentId,
                input: { action: "recheck", workerId: props.workerId, projectId: null },
              })
            }
          >
            Re-check all
          </Button>
        </span>
      )}
      {lines.projects.map((line) => (
        <span key={line} className="truncate pl-2 text-warning-foreground">
          {line}
        </span>
      ))}
    </div>
  );
}

/** A read-only fill bar: amber when it refuses new work. */
function MeterBar(props: {
  readonly used: number;
  readonly amber: boolean;
  readonly label: string;
}) {
  return (
    <span
      className="block h-1.5 overflow-hidden rounded-full bg-accent"
      role="meter"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(props.used * 100)}
    >
      <span
        className={cn(
          "block h-full rounded-full",
          props.amber ? "bg-warning" : "bg-muted-foreground",
        )}
        style={{ width: `${Math.round(props.used * 100)}%` }}
      />
    </span>
  );
}

function WorkerRow(props: {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string | null;
  readonly tags?: ReactNode;
  readonly subline: string;
  readonly status: WorkerStatusPresentation;
  readonly extra?: ReactNode;
  readonly actions: ReactNode;
}) {
  return (
    <div
      id={props.id}
      className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.2fr)_88px] items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-y-1"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5 text-board-13 font-medium">
          <span className="truncate">{props.name}</span>
          {props.abbreviation === null ? null : (
            <WorkerAbbreviationBadge abbreviation={props.abbreviation} />
          )}
          {props.tags}
        </span>
        <span className="truncate font-mono text-board-11-5 text-muted-foreground">
          {props.subline}
        </span>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-1 max-md:col-span-2 max-md:row-start-2">
        <BoardHint label={props.status.tooltip}>
          <Badge variant={TONE_BADGE[props.status.tone]}>{props.status.label}</Badge>
        </BoardHint>
        {props.status.detail === null ? null : (
          <span className="truncate text-board-11-5 text-muted-foreground">
            {props.status.detail}
          </span>
        )}
        {props.extra}
      </div>
      <div className="flex justify-end max-md:row-start-1 max-md:col-start-2">{props.actions}</div>
    </div>
  );
}

function WorkerMenu(props: {
  readonly worker: BoardWorkerView;
  readonly onRename: () => void;
  readonly onRemove: () => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            aria-label={`Actions for ${props.worker.label}`}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={props.onRename}>Rename…</MenuItem>
        <MenuSeparator />
        <MenuItem variant="destructive" onClick={props.onRemove}>
          Remove worker…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

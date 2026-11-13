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
  canBeDefaultBoardWorker,
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
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
import { boardWorkerCapacityLines } from "./workerCapacity";
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
  const setDefault = useAtomCommand(boardEnvironment.setDefaultWorker, { reportFailure: false });
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

  const runDefault = async (workerId: BoardWorkerId) => {
    const result = await setDefault({ environmentId, input: { workerId } });
    if (result._tag !== "Success") {
      toastManager.add({ type: "error", title: describeBoardCommandFailure(result) });
    }
  };

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

  const defaultItems: ReadonlyArray<{ readonly value: BoardWorkerId; readonly label: string }> = [
    { value: BOARD_LOCAL_WORKER_ID, label: `${localWorkerLabel(state)} (local)` },
    ...state.workers.map((worker) => ({ value: worker.id, label: worker.label })),
  ];
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
          isDefault={state.defaultWorkerId === BOARD_LOCAL_WORKER_ID}
          subline={`${localVersion === null ? "" : `T3o ${localVersion} · `}runs planning`}
          status={{ label: "Connected", detail: null, tone: "neutral", tooltip: null }}
          extra={<WorkerCapacity environmentId={environmentId} workerId={BOARD_LOCAL_WORKER_ID} />}
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
          const isDefault = state.defaultWorkerId === worker.id;
          const release = worker.t3oRelease ?? worker.status.t3oVersion;
          const joined = worker.joinedAt ?? worker.addedAt;
          return (
            <WorkerRow
              key={worker.id}
              id={`board-worker-${worker.id}`}
              name={worker.label}
              abbreviation={worker.abbreviation ?? null}
              isDefault={isDefault}
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
                  <WorkerCapacity environmentId={environmentId} workerId={worker.id} />
                )
              }
              actions={
                <WorkerMenu
                  worker={worker}
                  isDefault={isDefault}
                  onRename={() => setRenaming(worker)}
                  onMakeDefault={() => void runDefault(worker.id)}
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

      {state.workers.length === 0 ? null : (
        <div className="mx-3 mt-2 flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:mx-4">
          <div className="flex min-w-0 flex-col">
            <span className="text-board-13-5 text-foreground">Default worker</span>
            <span className="max-w-md text-xs text-muted-foreground">
              Where unpinned cards run. Changing it only affects cards that don't have a worktree
              yet; cards already working stay where they are.
            </span>
          </div>
          <Select<BoardWorkerId>
            value={state.defaultWorkerId}
            onValueChange={(value) => {
              if (value !== null && value !== state.defaultWorkerId) void runDefault(value);
            }}
            items={defaultItems}
          >
            <SelectTrigger size="sm" className="w-48" aria-label="Default worker">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem
                value={BOARD_LOCAL_WORKER_ID}
              >{`${localWorkerLabel(state)} (local)`}</SelectItem>
              {state.workers.filter(canBeDefaultBoardWorker).map((worker) => (
                <SelectItem key={worker.id} value={worker.id}>
                  {worker.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}

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
}) {
  const result = useAtomValue(
    boardEnvironment.capacityAtom({ environmentId: props.environmentId, input: {} }),
  );
  const capacityAction = useAtomCommand(boardEnvironment.capacityAction);
  const snapshot = AsyncResult.isSuccess(result) ? result.value.get(props.workerId) : undefined;
  if (snapshot === undefined) return null;
  const lines = boardWorkerCapacityLines(snapshot, clockTime);
  return (
    <div className="flex w-full max-w-72 flex-col gap-1 text-board-11-5 text-muted-foreground">
      {lines.bars.map((bar) => (
        <div key={bar.label} className="grid grid-cols-[2.5rem_1fr] items-center gap-2">
          <span>{bar.label}</span>
          <BoardHint label={bar.text}>
            <span className="h-1.5 overflow-hidden rounded-full bg-accent" aria-label={bar.text}>
              <span
                className={cn(
                  "block h-full rounded-full",
                  bar.used >= 1 ? "bg-warning" : "bg-muted-foreground",
                )}
                style={{ width: `${Math.round(bar.used * 100)}%` }}
              />
            </span>
          </BoardHint>
        </div>
      ))}
      <span>{lines.agents}</span>
      {lines.over === null ? null : <span className="text-warning-foreground">{lines.over}</span>}
      {lines.quota.map((line) => (
        <span key={line} className="text-warning-foreground">
          {line}
        </span>
      ))}
      {lines.readiness === null ? null : (
        <span className="flex items-center gap-2">
          <span className={lines.notReady > 0 ? "text-warning-foreground" : undefined}>
            {lines.readiness}
          </span>
          <Button
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
    </div>
  );
}

function WorkerRow(props: {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string | null;
  readonly tags?: ReactNode;
  readonly isDefault: boolean;
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
          {props.isDefault ? <Badge variant="outline">Default</Badge> : null}
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
  readonly isDefault: boolean;
  readonly onRename: () => void;
  readonly onMakeDefault: () => void;
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
        <MenuItem
          disabled={props.isDefault || !canBeDefaultBoardWorker(props.worker)}
          onClick={props.onMakeDefault}
        >
          Make default
        </MenuItem>
        <MenuSeparator />
        {props.isDefault ? (
          <BoardHint label="Make another worker the default first." side="left">
            <MenuItem variant="destructive" disabled>
              Remove worker…
            </MenuItem>
          </BoardHint>
        ) : (
          <MenuItem variant="destructive" onClick={props.onRemove}>
            Remove worker…
          </MenuItem>
        )}
      </MenuPopup>
    </Menu>
  );
}

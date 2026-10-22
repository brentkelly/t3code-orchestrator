/**
 * T3o (T3O-62): Settings → Board → Workers (prototype 1.1–1.3, 1.11).
 *
 * The built-in row is always first and can't be removed. Every other row is a
 * worker the board server dials with its own session (D19). Online is the
 * steady state and stays grey; colour appears only when a worker needs a
 * human. Status comes live from the board server, so every client shows the
 * same list.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  canBeDefaultBoardWorker,
  type BoardWorkerId,
  type BoardWorkerRemovePreview,
  type BoardWorkerRemovePreviewCard,
  type BoardWorkerView,
  type EnvironmentId,
} from "@t3tools/contracts";
import { EllipsisIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { boardEnvironment } from "../../state/board";
import { usePrimaryEnvironment } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoardHint } from "../BoardHint";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { AddWorkerDialog, type AddWorkerMode } from "./AddWorkerDialog";
import { useBoardWorkers, useNowAtDeadlines } from "./boardWorkersState";
import { workerLastSeen, workerStatusPresentation, type WorkerTone } from "./workerCopy";

const LOCAL_LABEL = "This server (local)";
const EMPTY_DEADLINES: ReadonlyArray<number> = [];

const TONE_BADGE: Record<WorkerTone, "outline" | "info" | "warning" | "success"> = {
  neutral: "outline",
  running: "info",
  warning: "warning",
  done: "success",
};

export function WorkersSection(props: {
  readonly environmentId: EnvironmentId;
  readonly onSetUpProjects: () => void;
}) {
  const { environmentId } = props;
  const workers = useBoardWorkers(environmentId);
  const primary = usePrimaryEnvironment();
  const boardLabel = primary?.label ?? "this board";
  const localVersion = primary?.serverConfig?.environment.serverVersion ?? null;
  const localUrl = primary?.displayUrl ?? null;
  const setDefault = useAtomCommand(boardEnvironment.setDefaultWorker, { reportFailure: false });
  const removeWorker = useAtomCommand(boardEnvironment.removeWorker, { reportFailure: false });
  const [dialog, setDialog] = useState<AddWorkerMode | null>(null);
  const [removing, setRemoving] = useState<BoardWorkerView | null>(null);
  // Last seen is coarse ("2 min ago"); every status change re-renders it.
  const nowMs = useNowAtDeadlines(EMPTY_DEADLINES);

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
        : `${worker.label} couldn't be reached, so the board's access there wasn't revoked. Remove “T3o board (${boardLabel})” under Settings → Connections → Clients on that machine.`,
    });
  };

  if (workers.loading || workers.failed) {
    return (
      <div className="mx-3 flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:mx-4">
        {workers.failed ? (
          <div className="flex items-center justify-between gap-3 py-2">
            <div className="flex flex-col">
              <span className="text-[13.5px] font-medium">Couldn't load workers</span>
              <span className="text-xs text-muted-foreground">
                The board server didn't answer. Your workers and cards are unchanged.
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={workers.retry}>
              Retry
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
            <Spinner className="size-3.5" /> Checking…
          </div>
        )}
      </div>
    );
  }

  const { state } = workers;
  const localOnly = state.workers.length === 0;
  const defaultChoices = state.workers.filter(canBeDefaultBoardWorker);
  const defaultItems: ReadonlyArray<{ readonly value: BoardWorkerId; readonly label: string }> = [
    { value: BOARD_LOCAL_WORKER_ID, label: LOCAL_LABEL },
    ...state.workers.map((worker) => ({ value: worker.id, label: worker.label })),
  ];

  return (
    <>
      <div className="mx-3 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs sm:mx-4">
        {localOnly ? null : (
          <div className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.3fr)_80px_minmax(0,1fr)_88px] gap-3 border-b border-border px-4 py-2 text-[11.5px] font-medium text-muted-foreground max-md:hidden">
            <span>Worker</span>
            <span>Status</span>
            <span>T3o</span>
            <span>Last seen</span>
            <span />
          </div>
        )}
        <WorkerRow
          name={LOCAL_LABEL}
          url={localUrl}
          isDefault={state.defaultWorkerId === BOARD_LOCAL_WORKER_ID}
          status={{ label: "Online", detail: null, tone: "neutral", tooltip: null }}
          version={localVersion}
          lastSeen="Now"
          actions={
            <BoardHint label="The server hosting the board can't be removed.">
              <Badge variant="secondary">Built-in</Badge>
            </BoardHint>
          }
        />
        {state.workers.map((worker) => {
          const isDefault = state.defaultWorkerId === worker.id;
          return (
            <WorkerRow
              key={worker.id}
              name={worker.label}
              url={worker.url}
              isDefault={isDefault}
              status={workerStatusPresentation(worker, boardLabel)}
              version={worker.status.t3oVersion}
              lastSeen={workerLastSeen(worker, nowMs)}
              actions={
                <WorkerMenu
                  worker={worker}
                  isDefault={isDefault}
                  onRepair={() => setDialog({ kind: "repair", worker })}
                  onCopyUrl={() => {
                    void navigator.clipboard.writeText(worker.url);
                    toastManager.add({ type: "success", title: "URL copied" });
                  }}
                  onMakeDefault={() => void runDefault(worker.id)}
                  onRemove={() => setRemoving(worker)}
                />
              }
            />
          );
        })}
        {localOnly ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <div className="flex flex-col">
              <span className="text-[13px] font-medium">No other workers</span>
              <span className="max-w-md text-xs text-muted-foreground">
                To run cards on another machine, connect to it in Settings → Connections, then use
                it as a worker here.
              </span>
            </div>
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "add" })}>
              <PlusIcon />
              Add worker
            </Button>
          </div>
        ) : (
          <div className="flex justify-end border-t border-border px-4 py-2.5">
            <Button size="sm" variant="outline" onClick={() => setDialog({ kind: "add" })}>
              <PlusIcon />
              Add worker
            </Button>
          </div>
        )}
      </div>

      {localOnly ? null : (
        <div className="mx-3 mt-2 flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:mx-4">
          <div className="flex min-w-0 flex-col">
            <span className="text-[13.5px] text-foreground">Default worker</span>
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
              <SelectItem value={BOARD_LOCAL_WORKER_ID}>{LOCAL_LABEL}</SelectItem>
              {defaultChoices.map((worker) => (
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
        boardLabel={boardLabel}
        mode={dialog ?? { kind: "add" }}
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        onSetUpProjects={props.onSetUpProjects}
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

function WorkerRow(props: {
  readonly name: string;
  readonly url: string | null;
  readonly isDefault: boolean;
  readonly status: ReturnType<typeof workerStatusPresentation>;
  readonly version: string | null;
  readonly lastSeen: string;
  readonly actions: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1.7fr)_minmax(0,1.3fr)_80px_minmax(0,1fr)_88px] items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 max-md:grid-cols-[minmax(0,1fr)_auto] max-md:gap-y-1">
      <div className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2 text-[13px] font-medium">
          <span className="truncate">{props.name}</span>
          {props.isDefault ? <Badge variant="outline">Default</Badge> : null}
        </span>
        {props.url === null ? null : (
          <span className="truncate font-mono text-[11.5px] text-muted-foreground">
            {props.url}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col items-start">
        <BoardHint label={props.status.tooltip}>
          <Badge variant={TONE_BADGE[props.status.tone]}>{props.status.label}</Badge>
        </BoardHint>
        {props.status.detail === null ? null : (
          <span className="truncate text-[11.5px] text-muted-foreground">
            {props.status.detail}
          </span>
        )}
      </div>
      <span className="font-mono text-[11.5px] text-muted-foreground max-md:hidden">
        {props.version ?? "—"}
      </span>
      <span className="text-[12px] text-muted-foreground max-md:hidden">{props.lastSeen}</span>
      <div className="flex justify-end">{props.actions}</div>
    </div>
  );
}

function WorkerMenu(props: {
  readonly worker: BoardWorkerView;
  readonly isDefault: boolean;
  readonly onRepair: () => void;
  readonly onCopyUrl: () => void;
  readonly onMakeDefault: () => void;
  readonly onRemove: () => void;
}) {
  const needsRepair = props.worker.status.state === "unauthorized";
  return (
    <div className="flex items-center gap-1">
      {needsRepair ? (
        <Button size="xs" variant="outline" onClick={props.onRepair}>
          Re-pair…
        </Button>
      ) : null}
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
          <MenuItem onClick={props.onRepair}>Re-pair…</MenuItem>
          <MenuItem onClick={props.onCopyUrl}>Copy URL</MenuItem>
          <MenuItem
            disabled={props.isDefault || !canBeDefaultBoardWorker(props.worker)}
            onClick={props.onMakeDefault}
          >
            Make default
          </MenuItem>
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
    </div>
  );
}

/**
 * The remove confirmation (1.11): the cards removal affects, from the board
 * server — those with no worktree yet move to the default worker, and those
 * with work there hold until they are moved (D22).
 */
function RemoveWorkerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly worker: BoardWorkerView | null;
  readonly onCancel: () => void;
  readonly onConfirm: (worker: BoardWorkerView) => void;
}) {
  const worker = props.worker;
  const { environmentId } = props;
  const previewRemoval = useAtomCommand(boardEnvironment.previewWorkerRemoval, {
    reportFailure: false,
  });
  const [preview, setPreview] = useState<
    | { readonly workerId: BoardWorkerId; readonly result: BoardWorkerRemovePreview | null }
    | undefined
  >(undefined);
  const workerId = worker?.id ?? null;
  useEffect(() => {
    if (workerId === null) return;
    let live = true;
    void previewRemoval({ environmentId, input: { workerId } }).then((result) => {
      if (live) setPreview({ workerId, result: result._tag === "Success" ? result.value : null });
    });
    return () => {
      live = false;
    };
  }, [environmentId, previewRemoval, workerId]);
  const current = preview !== undefined && preview.workerId === workerId ? preview : undefined;
  const name = worker?.label ?? "";
  const affected =
    current?.result == null ? 0 : current.result.toDefault.length + current.result.byHand.length;
  const stopsAStep = current?.result?.byHand.some((card) => card.running) ?? false;
  return (
    <AlertDialog
      open={worker !== null}
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {current === undefined
              ? `Checking which cards are on ${name}…`
              : current.result === null
                ? `Couldn't list the cards on ${name}.`
                : affected === 0
                  ? `No cards are assigned to ${name}.`
                  : `${affected} ${affected === 1 ? "card is" : "cards are"} assigned to ${name}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 px-6 pb-4 text-[13px]">
          {current === undefined ? <Spinner className="size-4" /> : null}
          {current?.result != null && current.result.toDefault.length > 0 ? (
            <RemovePreviewGroup
              title="Will move to the default worker"
              subtitle={`${current.result.defaultWorkerLabel} · no worktree yet`}
              cards={current.result.toDefault}
            />
          ) : null}
          {current?.result != null && current.result.byHand.length > 0 ? (
            <>
              <RemovePreviewGroup
                title="Will need moving by hand"
                subtitle={`work exists on ${name}`}
                cards={current.result.byHand}
              />
              <span className="text-muted-foreground">
                These cards hold and show “Worker removed — move this card” until you move them.
                {stopsAStep ? " The running step is stopped." : ""}
              </span>
            </>
          ) : null}
          <span className="text-muted-foreground">
            Nothing on {name} is deleted. Its worktrees, branches and thread history stay on that
            machine; this board just stops using it. Removing also revokes the board's access on{" "}
            {name}, if it can be reached.
          </span>
        </div>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            disabled={current === undefined}
            onClick={() => {
              if (worker !== null) props.onConfirm(worker);
            }}
          >
            Remove {name}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function RemovePreviewGroup(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly cards: ReadonlyArray<BoardWorkerRemovePreviewCard>;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
      <span>
        <span className="text-[12.5px] font-semibold">{props.title}</span>
        <span className="text-[12px] text-muted-foreground"> · {props.subtitle}</span>
      </span>
      <ul className="flex flex-col gap-1">
        {props.cards.map((card) => (
          <li className="flex min-w-0 items-center gap-2 text-[12.5px]" key={card.cardId}>
            <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
              {card.key}
            </span>
            <span className="min-w-0 flex-1 truncate">{card.title}</span>
            <span className="shrink-0 text-[11.5px] text-muted-foreground">{card.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

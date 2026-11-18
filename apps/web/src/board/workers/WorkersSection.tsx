/**
 * Settings → Board → Workers (Remote Workers prototype 2.1). One row per worker, its
 * projects nested beneath it. This server's row is first and permanent; the rest are
 * machines that joined with a code and dial the board. Every number is the worker's own
 * report and capacity is read-only. Connected and Ready stay grey; amber means blocked.
 */
import {
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
  type BoardWorkerJoinCodeCreated,
  type BoardWorkerView,
  type EnvironmentId,
} from "@t3tools/contracts";
import { CircleHelpIcon, EllipsisIcon, PlusIcon, ServerIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useEnvironment } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoardHint } from "../BoardHint";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { AddWorkerDialog } from "./AddWorkerDialog";
import { BoardServerPlanningCallouts } from "./BoardServerPlanningCallouts";
import { useNowAtDeadlines, type BoardWorkersView } from "./boardWorkersState";
import { joinCodeInPlay, joinDialogPhase, openJoinCodes } from "./joinDialog";
import { RemoveWorkerDialog } from "./RemoveWorkerDialog";
import { RenameWorkerDialog } from "./RenameWorkerDialog";
import { localWorkerLabel } from "./threadWorker";
import {
  clockTime,
  SETUP_JUST_NOW_MS,
  T3O_UPDATE_COMMAND,
  workerLastSeenDeadlines,
  workerStatusPresentation,
  type WorkerStatusPresentation,
  type WorkerTone,
} from "./workerCopy";
import { boardWorkerCapacityLines, boardWorkerHoldLine } from "./workerCapacity";
import {
  SetupFailureDialog,
  WorkerProjectRows,
  workerProject,
  type FailedSetupDetails,
} from "./WorkerProjectRows";
import { CopyCommand, WorkerAbbreviationBadge } from "./workerUi";

/** Status is a still dot and a word: grey while steady, blue while it changes, amber blocked. */
const TONE_DOT: Record<WorkerTone, string> = {
  neutral: "bg-muted-foreground",
  running: "bg-info",
  warning: "bg-warning",
  done: "bg-success",
};
const TONE_TEXT: Record<WorkerTone, string> = {
  neutral: "text-foreground",
  running: "text-info-foreground",
  warning: "text-warning-foreground",
  done: "text-success-foreground",
};

/** Sized by the table's own width: Worker · Status · Headroom · Provider quota · menu when
    there's room, else Worker and Status over Headroom and quota, else one column. */
const COLUMNS =
  "grid-cols-[minmax(0,1fr)_auto] @xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_4.5rem] @4xl:grid-cols-[minmax(0,1.1fr)_9rem_minmax(0,1.3fr)_minmax(0,1fr)_4.5rem]";

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
}) {
  const { environmentId, workers, addWorker } = props;
  const boardServer = useEnvironment(environmentId);
  const localVersion = boardServer?.serverConfig?.environment.serverVersion ?? null;
  const removeWorker = useAtomCommand(boardEnvironment.removeWorker, { reportFailure: false });
  const cancelJoinCode = useAtomCommand(boardEnvironment.cancelWorkerJoinCode, {
    reportFailure: false,
  });
  const capacityResult = useAtomValue(boardEnvironment.capacityAtom({ environmentId, input: {} }));
  const capacity = AsyncResult.isSuccess(capacityResult) ? capacityResult.value : null;
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const projects = (Option.getOrNull(shellState.snapshot)?.projects ?? []).map(workerProject);
  const cardsByProject = useAtomValue(boardEnvironment.cardsByProjectAtom(environmentId));
  const cardKeyOf = (cardId: string) =>
    [...cardsByProject.values()]
      .flatMap((columns) => Object.values(columns).flat())
      .find((card) => card.cardId === cardId)?.key ?? null;
  const [renaming, setRenaming] = useState<BoardWorkerView | null>(null);
  const [removing, setRemoving] = useState<BoardWorkerView | null>(null);
  const [failedSetup, setFailedSetup] = useState<FailedSetupDetails | null>(null);
  const { state } = workers;
  // "Last seen", the open codes' expiry and "Set up just now" are coarse: re-read the clock
  // only when one changes.
  const nowMs = useNowAtDeadlines([
    ...state.workers.flatMap(workerLastSeenDeadlines),
    ...state.joinCodes.map((code) => Date.parse(code.expiresAt)),
    ...state.setups.flatMap((setup) =>
      setup.phase === "done" && setup.endedAt !== null
        ? [Date.parse(setup.endedAt) + SETUP_JUST_NOW_MS]
        : [],
    ),
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
  const localName = localWorkerLabel(state);
  const localSnapshot = capacity?.get(BOARD_LOCAL_WORKER_ID);

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
      <div className="@container mx-3 flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs sm:mx-4">
        <div
          className={cn(
            "hidden gap-x-3 border-b border-border bg-muted/50 px-4 py-2 text-board-10-5 font-semibold tracking-wider text-muted-foreground uppercase @4xl:grid",
            COLUMNS,
          )}
        >
          <span>Worker</span>
          <span>Status</span>
          <span className="flex items-center gap-1">
            Headroom offered
            <BoardHint label="Each worker measures its CPU, RAM and disk and reports them to the board as they change. Headroom is what it can take on now. To hold some back, set capacity.cpuCores, capacity.ramGiB or capacity.diskGB with pnpm t3o-worker config on that machine.">
              <CircleHelpIcon
                aria-label="How headroom is measured"
                className="size-3 text-muted-foreground/70"
              />
            </BoardHint>
          </span>
          <span>Provider quota · account</span>
          <span />
        </div>
        <WorkerBlock
          id="board-worker-local"
          name={localName}
          abbreviation={BOARD_LOCAL_WORKER_ABBREVIATION}
          tags={<Badge variant="secondary">Board</Badge>}
          subline={`${localVersion === null ? "" : `T3o ${localVersion} · `}runs planning`}
          status={{ label: "Connected", detail: null, tone: "neutral", tooltip: null }}
          snapshot={localSnapshot}
          cardKeyOf={cardKeyOf}
          live
          actions={
            <WorkerMenu
              environmentId={environmentId}
              workerId={BOARD_LOCAL_WORKER_ID}
              label={localName}
              live
              onRename={() => setRenaming(localWorkerView(localName))}
            />
          }
        >
          <WorkerProjectRows
            environmentId={environmentId}
            workerId={BOARD_LOCAL_WORKER_ID}
            workerLabel={localName}
            worker={null}
            projects={projects}
            setups={state.setups}
            readiness={localSnapshot?.readiness ?? []}
            readinessProtocol={
              localSnapshot == null ? null : (localSnapshot.readinessProtocol ?? 0)
            }
            live
            nowMs={nowMs}
            onDetails={setFailedSetup}
          />
          <BoardServerPlanningCallouts environmentId={environmentId} />
        </WorkerBlock>
        {state.workers.map((worker) => {
          const release = worker.t3oRelease ?? worker.status.t3oVersion;
          const joined = worker.joinedAt ?? worker.addedAt;
          const live = worker.status.state === "online";
          const snapshot = capacity?.get(worker.id);
          return (
            <WorkerBlock
              key={worker.id}
              id={`board-worker-${worker.id}`}
              name={worker.label}
              abbreviation={worker.abbreviation ?? null}
              subline={`${release === null ? "" : `T3o ${release} · `}joined ${joinedDate(joined)}`}
              status={workerStatusPresentation(worker, nowMs)}
              snapshot={snapshot}
              cardKeyOf={cardKeyOf}
              live={live}
              notice={
                worker.status.state === "incompatible" ? (
                  <div className="flex flex-col gap-1">
                    <span className="text-board-11-5 text-muted-foreground">
                      Needs T3o {BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer. On{" "}
                      {worker.label}, run:
                    </span>
                    <CopyCommand command={T3O_UPDATE_COMMAND} target="update command" />
                  </div>
                ) : null
              }
              actions={
                <WorkerMenu
                  environmentId={environmentId}
                  workerId={worker.id}
                  label={worker.label}
                  live={live}
                  onRename={() => setRenaming(worker)}
                  onRemove={() => setRemoving(worker)}
                />
              }
            >
              <WorkerProjectRows
                environmentId={environmentId}
                workerId={worker.id}
                workerLabel={worker.label}
                worker={worker}
                projects={projects}
                setups={state.setups}
                readiness={snapshot?.readiness ?? []}
                readinessProtocol={
                  snapshot == null ? null : (snapshot.readinessProtocol ?? 0)
                }
                live={live}
                nowMs={nowMs}
                onDetails={setFailedSetup}
              />
            </WorkerBlock>
          );
        })}
        {state.workers.length === 0 ? (
          <div className="flex flex-col px-4 py-3">
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
        onSetUpProjects={(workerId) =>
          document
            .getElementById(`board-worker-${workerId}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
        }
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
      <SetupFailureDialog
        environmentId={environmentId}
        details={failedSetup}
        onClose={() => setFailedSetup(null)}
      />
    </>
  );
}

/** One worker: its row, then its projects. */
function WorkerBlock(props: {
  readonly id: string;
  readonly name: string;
  readonly abbreviation: string | null;
  readonly tags?: ReactNode;
  readonly subline: string;
  readonly status: WorkerStatusPresentation;
  readonly snapshot: BoardWorkerCapacitySnapshot | undefined;
  readonly cardKeyOf: (cardId: string) => string | null;
  readonly live: boolean;
  readonly notice?: ReactNode;
  readonly actions: ReactNode;
  readonly children: ReactNode;
}) {
  const lines =
    props.snapshot === undefined
      ? null
      : boardWorkerCapacityLines(props.snapshot, clockTime, props.name, props.live);
  const statusDetail = [props.status.detail, lines?.agents ?? null].filter(
    (line): line is string => line !== null,
  );
  return (
    <div id={props.id} className="border-b border-border last:border-b-0">
      <div className={cn("grid items-start gap-x-3 gap-y-3 px-4 py-3", COLUMNS)}>
        <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2.5">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <ServerIcon className="size-3.5" />
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex min-w-0 items-center gap-1.5 text-board-13 font-medium">
              <span className="truncate">{props.name}</span>
              {props.abbreviation === null ? null : (
                <WorkerAbbreviationBadge abbreviation={props.abbreviation} />
              )}
              {props.tags}
            </span>
            <span className="truncate font-mono text-board-11 text-muted-foreground">
              {props.subline}
            </span>
          </div>
        </div>
        <div className="col-span-2 row-start-2 flex min-w-0 flex-col gap-0.5 pt-1 @xl:col-span-1 @xl:col-start-2 @xl:row-start-1">
          <BoardHint label={props.status.tooltip}>
            <span
              className={cn(
                "inline-flex items-center gap-1.5 text-board-12-5 font-medium",
                TONE_TEXT[props.status.tone],
              )}
            >
              <span className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[props.status.tone])} />
              {props.status.label}
            </span>
          </BoardHint>
          {statusDetail.map((line) => (
            <span key={line} className="text-board-11 text-muted-foreground">
              {line}
            </span>
          ))}
        </div>
        <div className="col-span-2 row-start-3 min-w-0 @xl:col-span-1 @xl:col-start-1 @xl:row-start-2 @4xl:col-start-3 @4xl:row-start-1">
          {props.notice ??
            (lines === null ? null : (
              <Headroom
                lines={lines}
                holdLine={boardWorkerHoldLine(props.snapshot?.hold, props.cardKeyOf, clockTime)}
              />
            ))}
        </div>
        <div className="col-span-2 row-start-4 min-w-0 @xl:col-span-1 @xl:col-start-2 @xl:row-start-2 @4xl:col-start-4 @4xl:row-start-1">
          {lines === null ? null : <ProviderQuota lines={lines} />}
        </div>
        <div className="col-start-2 row-start-1 flex items-center justify-end gap-1.5 @xl:col-start-3 @4xl:col-start-5">
          {props.actions}
        </div>
      </div>
      <div className="flex flex-col gap-2 px-4 pb-3 @xl:pl-13.5">{props.children}</div>
    </div>
  );
}

type CapacityLines = ReturnType<typeof boardWorkerCapacityLines>;

/** Capacity in use against what the worker declares; the bold number is what it offers. */
function Headroom(props: { readonly lines: CapacityLines; readonly holdLine: string | null }) {
  const { lines, holdLine } = props;
  return (
    <div
      className={cn("flex flex-col gap-1.5 text-board-11-5", lines.stale !== null && "opacity-60")}
    >
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_minmax(6.5rem,auto)] items-center gap-x-2.5 gap-y-1">
        {lines.bars.map((bar) => (
          <BoardHint key={bar.label} label={bar.tooltip}>
            <div className="contents">
              <span className="text-muted-foreground">{bar.label}</span>
              <MeterBar used={bar.used} amber={bar.used >= 1} label={bar.text} />
              <span className="tabular-nums">
                <span className="font-semibold">{bar.free}</span> / {bar.declared} {bar.unit}
              </span>
            </div>
          </BoardHint>
        ))}
      </div>
      {lines.stale === null ? null : (
        <span className="text-board-11 text-muted-foreground">{lines.stale}</span>
      )}
      {holdLine === null ? null : (
        <span className="text-board-11 font-medium text-info-foreground">{holdLine}</span>
      )}
      {lines.over === null ? null : (
        <span className="text-board-11 text-warning-foreground">{lines.over}</span>
      )}
    </div>
  );
}

/** Each provider's usage windows, with the account they belong to beneath its name. */
function ProviderQuota(props: { readonly lines: CapacityLines }) {
  const { lines } = props;
  if (lines.providers.length === 0) return null;
  return (
    <div
      className={cn("flex flex-col gap-2 text-board-11-5", lines.stale !== null && "opacity-60")}
    >
      {lines.providers.map((provider) => (
        <div key={provider.name} className="flex min-w-0 flex-col gap-1">
          <div className="flex min-w-0 flex-col">
            <span className="font-medium">
              {provider.name}
              {/* A signed-out provider is just unavailable here: the sign-in hint waits on hover. */}
              {provider.signedOut === null ? null : (
                <BoardHint label={provider.signedOut}>
                  <span className="font-normal text-muted-foreground"> · Signed out</span>
                </BoardHint>
              )}
            </span>
            {provider.account === null ? null : (
              <span className="truncate font-mono text-board-10-5 text-muted-foreground">
                {provider.account}
              </span>
            )}
          </div>
          {provider.windows.length === 0 ? null : (
            <div className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)_2.5rem] items-center gap-x-2 gap-y-1">
              {provider.windows.map((window) => (
                <BoardHint key={window.label} label={window.text}>
                  <div className="contents">
                    <span className="truncate text-muted-foreground">{window.label}</span>
                    <MeterBar used={window.used} amber={window.nearLimit} label={window.text} />
                    <span
                      className={cn(
                        "text-right tabular-nums",
                        window.nearLimit && "font-medium text-warning-foreground",
                      )}
                    >
                      {window.percent}%
                    </span>
                  </div>
                </BoardHint>
              ))}
            </div>
          )}
          {provider.nearLimit === null ? null : (
            <span className="text-warning-foreground">{provider.nearLimit}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** A read-only fill bar: ink for what's in use, amber when it refuses new work. */
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
        className={cn("block h-full rounded-full", props.amber ? "bg-warning" : "bg-foreground/60")}
        style={{ width: `${Math.round(props.used * 100)}%` }}
      />
    </span>
  );
}

function WorkerMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly workerId: BoardWorkerId;
  readonly label: string;
  readonly live: boolean;
  readonly onRename: () => void;
  /** Absent for the board server, which can't be removed. */
  readonly onRemove?: () => void;
}) {
  const navigate = useNavigate();
  const capacityAction = useAtomCommand(boardEnvironment.capacityAction);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            aria-label={`Actions for ${props.label}`}
          />
        }
      >
        <EllipsisIcon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem
          disabled={!props.live}
          onClick={() =>
            void capacityAction({
              environmentId: props.environmentId,
              input: { action: "recheck", workerId: props.workerId, projectId: null },
            })
          }
        >
          Re-check all projects
        </MenuItem>
        <MenuItem onClick={props.onRename}>Rename…</MenuItem>
        {/* T3o: the board's worker filter, set to this worker (T3O-87). */}
        <MenuItem
          onClick={() => void navigate({ to: "/board", search: { worker: props.workerId } })}
        >
          Show cards on {props.label}
        </MenuItem>
        {props.onRemove === undefined ? null : (
          <>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={props.onRemove}>
              Remove worker…
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

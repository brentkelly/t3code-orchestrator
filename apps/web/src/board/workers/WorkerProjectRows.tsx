/**
 * T3o: the projects nested under each worker on the Workers page (prototype 2.1): whether the
 * worker has a checkout of each board project and what its readiness script last said, with
 * Re-check, Set up on worker, and a failed clone's Retry and Details. Set up clones on the
 * server, so leaving the page doesn't cancel it.
 */
import {
  boardReadinessIsFor,
  boardRepositoryGroupingKey,
  boardWorkerSpeaksReadiness,
  resolveBoardWorkerCheckout,
  type BoardWorkerId,
  type BoardWorkerReadiness,
  type BoardWorkerSetup,
  type BoardWorkerView,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import { CheckIcon, ChevronRightIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../components/ui/popover";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoardHint } from "../BoardHint";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import {
  checkoutCell,
  clockTime,
  cloneStageLabel,
  readyDetail,
  remoteHost,
  setupFailureCopy,
  workerProjectState,
  type CheckoutCell,
  type WorkerProjectState,
} from "./workerCopy";

/** A board project, as the rows need it. */
export interface WorkerProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryKey: string | null;
  readonly repositoryName: string;
}

export function workerProject(project: OrchestrationProjectShell): WorkerProject {
  const repositoryKey = boardRepositoryGroupingKey(project.repositoryIdentity);
  return {
    id: project.id,
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    repositoryKey,
    repositoryName:
      project.repositoryIdentity?.name ?? repositoryKey?.split("/").at(-1) ?? project.title,
  };
}

export interface FailedSetupDetails {
  readonly setup: BoardWorkerSetup;
  readonly worker: BoardWorkerView;
  readonly project: WorkerProject;
}

/** The rows under one worker. `worker` is null for the board server, where every board
    project is checked out by definition. */
export function WorkerProjectRows(props: {
  readonly environmentId: EnvironmentId;
  readonly workerId: BoardWorkerId;
  readonly workerLabel: string;
  readonly worker: BoardWorkerView | null;
  readonly projects: ReadonlyArray<WorkerProject>;
  readonly setups: ReadonlyArray<BoardWorkerSetup>;
  readonly readiness: ReadonlyArray<BoardWorkerReadiness>;
  /** T3o (T3O-124): the worker's `readinessProtocol`, or null before its first snapshot. */
  readonly readinessProtocol: number | null;
  /** False while the worker is out of reach: what it last reported, and no actions. */
  readonly live: boolean;
  readonly nowMs: number;
  readonly onDetails: (details: FailedSetupDetails) => void;
}) {
  const { worker } = props;
  if (props.projects.length === 0) return null;
  return (
    <div className={cn("flex flex-col", !props.live && "opacity-60")}>
      {props.projects.map((project) => {
        const readiness =
          props.readiness.find((entry) =>
            boardReadinessIsFor(entry, project.repositoryKey, project.id),
          ) ?? null;
        const setup =
          worker === null
            ? null
            : (props.setups.find(
                (candidate) =>
                  candidate.workerId === worker.id && candidate.projectId === project.id,
              ) ?? null);
        const cell: CheckoutCell | "connecting" =
          worker === null
            ? { kind: "checked-out", path: project.workspaceRoot, lastKnown: false }
            : worker.snapshot === null && worker.status.state === "connecting"
              ? "connecting"
              : checkoutCell({
                  worker,
                  checkout: resolveBoardWorkerCheckout(
                    project.repositoryKey,
                    worker.snapshot?.checkouts ?? [],
                  ),
                  setup,
                  projectHasRemote: project.repositoryKey !== null,
                  nowMs: props.nowMs,
                });
        return (
          <ProjectRow
            key={project.id}
            environmentId={props.environmentId}
            workerId={props.workerId}
            workerLabel={props.workerLabel}
            worker={worker}
            project={project}
            live={props.live}
            state={
              cell === "connecting"
                ? { kind: "checking" }
                : cell.kind === "checked-out" &&
                    props.readinessProtocol !== null &&
                    !boardWorkerSpeaksReadiness({ readinessProtocol: props.readinessProtocol })
                  ? { kind: "update-readiness" }
                  : workerProjectState(cell, readiness)
            }
            onDetails={props.onDetails}
          />
        );
      })}
    </div>
  );
}

function ProjectRow(props: {
  readonly environmentId: EnvironmentId;
  readonly workerId: BoardWorkerId;
  readonly workerLabel: string;
  readonly worker: BoardWorkerView | null;
  readonly project: WorkerProject;
  readonly live: boolean;
  readonly state: WorkerProjectState;
  readonly onDetails: (details: FailedSetupDetails) => void;
}) {
  const { state, worker, project } = props;
  const capacityAction = useAtomCommand(boardEnvironment.capacityAction);
  // The script's full output, read from the worker on demand and tied to the run it came from.
  const [output, setOutput] = useState<{
    readonly checkedAt: string | null;
    readonly text: string | null;
  } | null>(null);
  const offlineHint = `Available when ${props.workerLabel} reconnects`;
  const recheck = (
    <BoardHint label={props.live ? "Re-check: run the readiness script again" : offlineHint}>
      <span>
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Re-check ${project.title} on ${props.workerLabel}`}
          disabled={!props.live}
          onClick={() =>
            void capacityAction({
              environmentId: props.environmentId,
              input: { action: "recheck", workerId: props.workerId, projectId: project.id },
            })
          }
        >
          <RefreshCwIcon />
        </Button>
      </span>
    </BoardHint>
  );

  /** The checks' and script's full output, read from the worker for the run it came from. */
  const outputViewer = (checkedAt: string | null, lastLine: string | null) => (
    <ReadinessOutput
      lastLine={lastLine}
      output={output?.checkedAt === checkedAt ? output.text : undefined}
      canRead={props.live}
      onToggle={() => {
        if (output?.checkedAt === checkedAt) {
          setOutput(null);
          return;
        }
        setOutput({ checkedAt, text: null });
        void capacityAction({
          environmentId: props.environmentId,
          input: {
            action: "readinessOutput",
            workerId: props.workerId,
            projectId: project.id,
          },
        }).then((result) =>
          setOutput((current) =>
            current?.checkedAt !== checkedAt
              ? current
              : {
                  checkedAt,
                  text:
                    result._tag === "Success"
                      ? result.value || "The script printed nothing."
                      : `Couldn't read the output from ${props.workerLabel}.`,
                },
          ),
        );
      }}
    />
  );

  let status: ReactNode;
  let detail: ReactNode = null;
  let actions: ReactNode = null;
  switch (state.kind) {
    case "ready": {
      status = <Status icon="tick">Ready</Status>;
      const line = `${readyDetail(state)}${state.checkedAt === null ? "" : ` · ${clockTime(state.checkedAt)}`}`;
      // T3o (T3O-124): warnings and a skipped script are worth reading even when ready.
      detail =
        (state.checks?.warned ?? 0) > 0 || state.scriptSkipped ? (
          <span className="flex min-w-0 flex-col gap-1">
            <span>{line}</span>
            {outputViewer(state.checkedAt, null)}
          </span>
        ) : (
          line
        );
      actions = recheck;
      break;
    }
    case "update-readiness":
      status = <Status icon="tick">Checked out</Status>;
      detail = "Update this worker to check readiness";
      break;
    case "checked-out":
      status = <Status icon="tick">Checked out</Status>;
      detail = (
        <span className="font-mono text-board-11">
          {state.lastKnown ? "Last known · offline" : state.path}
        </span>
      );
      actions = recheck;
      break;
    case "set-up-just-now":
      status = (
        <Status icon="tick" tone="text-success-foreground">
          Set up just now
        </Status>
      );
      detail = <span className="font-mono text-board-11">{state.path}</span>;
      break;
    case "not-ready":
      status = (
        <Status icon="warning" tone="text-warning-foreground">
          Not ready
        </Status>
      );
      detail = (
        <span className="flex min-w-0 flex-col gap-1">
          {state.checkFailed ? (
            <span>
              A readiness check failed
              {state.checkedAt === null ? "" : ` · ${clockTime(state.checkedAt)}`}
            </span>
          ) : (
            <span>
              Readiness script <span className="font-mono text-board-11">{state.path}</span>
              {state.exitCode === null ? " failed" : ` exited ${state.exitCode}`}
              {state.checkedAt === null ? "" : ` · ${clockTime(state.checkedAt)}`}
            </span>
          )}
          {outputViewer(state.checkedAt, state.lastLine)}
        </span>
      );
      actions = recheck;
      break;
    case "checking":
      status = <Status icon="running">Checking…</Status>;
      detail = "Running the readiness checks";
      break;
    case "cloning":
      status = (
        <Status icon="running">
          Cloning{state.percent === null ? "" : ` · ${state.percent}%`}
        </Status>
      );
      detail = cloneStageLabel(state.stage);
      break;
    case "failed": {
      status = (
        <Status icon="warning" tone="text-warning-foreground">
          Clone failed
        </Status>
      );
      detail = setupFailureCopy({
        kind: state.failureKind,
        worker: props.workerLabel,
        host: project.repositoryKey?.split("/")[0] ?? "the remote",
        path: state.setup.destinationPath,
      }).cell;
      if (worker !== null) {
        const setup = state.setup;
        actions = (
          <>
            <SetUpButton
              environmentId={props.environmentId}
              worker={worker}
              project={project}
              label="Retry"
              defaultFolder={setup.destinationPath}
              direct={state.failureKind !== "folder-exists"}
            />
            <Button
              size="xs"
              variant="ghost"
              onClick={() => props.onDetails({ setup, worker, project })}
            >
              Details
            </Button>
          </>
        );
      }
      break;
    }
    case "not-checked-out":
      status = <Status icon="none">Not set up</Status>;
      if (worker !== null) {
        actions = state.canSetUp ? (
          <SetUpButton
            environmentId={props.environmentId}
            worker={worker}
            project={project}
            label="Set up on worker"
            defaultFolder={null}
            direct={false}
          />
        ) : (
          <BoardHint
            label={`${project.title} has no git remote on the board server, so workers can't clone it. Add a remote and push.`}
          >
            <span>
              <Button size="xs" variant="outline" disabled>
                Set up on worker
              </Button>
            </span>
          </BoardHint>
        );
      }
      break;
    case "set-up-when-online":
      status = <Status icon="none">Not set up</Status>;
      detail = "Set up once it's back online";
      break;
    case "update-to-check":
      status = (
        <Status icon="warning" tone="text-warning-foreground">
          Update T3o to check
        </Status>
      );
      break;
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 border-b border-dashed border-border py-1.5 text-board-12 last:border-b-0 @xl:grid-cols-[minmax(0,8rem)_9rem_minmax(0,1fr)_auto]">
      <span className="truncate pt-0.5 font-mono text-board-11-5">{project.title}</span>
      <span className="pt-0.5 @max-xl:col-start-1 @max-xl:row-start-2">{status}</span>
      <span className="min-w-0 pt-0.5 text-muted-foreground @max-xl:col-span-2 @max-xl:row-start-3">
        {detail}
      </span>
      <span className="flex justify-end gap-1.5 @max-xl:col-start-2 @max-xl:row-start-1">
        {actions}
      </span>
    </div>
  );
}

/**
 * A failed readiness script's last line, which opens to the whole output. `output` is
 * undefined while closed and null while it's read from the worker.
 */
function ReadinessOutput(props: {
  readonly lastLine: string | null;
  readonly output: string | null | undefined;
  readonly canRead: boolean;
  readonly onToggle: () => void;
}) {
  const open = props.output !== undefined;
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-muted/50">
      <button
        aria-expanded={open}
        className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-left font-mono text-board-11 hover:text-foreground disabled:pointer-events-none"
        disabled={!props.canRead && !open}
        onClick={props.onToggle}
        type="button"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0", open && "rotate-90")} />
        <span className="truncate">{props.lastLine ?? "Show the output"}</span>
      </button>
      {open ? (
        <pre className="max-h-72 overflow-auto border-t border-border px-2 py-1.5 font-mono text-board-11 whitespace-pre-wrap">
          {props.output ?? "Reading the output…"}
        </pre>
      ) : null}
    </div>
  );
}

/** A still status: a tick, a warning, a blue dot while something runs, or an empty ring. */
function Status(props: {
  readonly icon: "tick" | "warning" | "running" | "none";
  readonly tone?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-medium",
        props.icon === "running"
          ? "text-info-foreground"
          : props.icon === "none"
            ? "text-muted-foreground"
            : "text-foreground",
        props.tone,
      )}
    >
      {props.icon === "tick" ? (
        <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
      ) : props.icon === "warning" ? (
        <TriangleAlertIcon className="size-3 shrink-0" />
      ) : props.icon === "running" ? (
        <span className="size-1.5 shrink-0 rounded-full bg-info" />
      ) : (
        <span className="size-2.5 shrink-0 rounded-full border-2 border-input" />
      )}
      {props.children}
    </span>
  );
}

/**
 * Set up (2.2): a popover naming the remote and the folder, editable. Retry
 * of a failure that wasn't the folder's fault skips the popover.
 */
function SetUpButton(props: {
  readonly environmentId: EnvironmentId;
  readonly worker: BoardWorkerView;
  readonly project: WorkerProject;
  readonly label: string;
  readonly defaultFolder: string | null;
  readonly direct: boolean;
}) {
  const setup = useAtomCommand(boardEnvironment.setupWorkerProject, { reportFailure: false });
  const projectsFolder = (props.worker.snapshot?.projectsFolder ?? "~").replace(/\/+$/, "");
  const [folder, setFolder] = useState(
    props.defaultFolder ?? `${projectsFolder}/${props.project.repositoryName}`,
  );
  const [open, setOpen] = useState(false);

  const run = async (destination: string) => {
    setOpen(false);
    const result = await setup({
      environmentId: props.environmentId,
      input: {
        projectId: props.project.id,
        workerId: props.worker.id,
        folder: destination.trim(),
      },
    });
    if (result._tag !== "Success") {
      toastManager.add({ type: "error", title: describeBoardCommandFailure(result) });
    }
  };

  if (props.direct) {
    return (
      <Button size="xs" variant="outline" onClick={() => void run(folder)}>
        {props.label}
      </Button>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button size="xs" variant="outline" />}>{props.label}</PopoverTrigger>
      <PopoverPopup className="w-80">
        <div className="flex flex-col gap-3">
          <PopoverTitle>
            Set up {props.project.title} on {props.worker.label}
          </PopoverTitle>
          <p className="text-board-12-5 text-muted-foreground">
            Clones{" "}
            <span className="font-mono text-board-11-5 text-foreground">
              {props.project.repositoryKey}
            </span>{" "}
            using {props.worker.label}'s git credentials.
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`setup-folder-${props.worker.id}-${props.project.id}`}>
              Folder on {props.worker.label}
            </Label>
            <Input
              id={`setup-folder-${props.worker.id}-${props.project.id}`}
              value={folder}
              onChange={(event) => setFolder(event.target.value)}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={folder.trim().length === 0}
              onClick={() => void run(folder)}
            >
              Clone
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Clone failed — Details (2.3): why, and git's own words. */
export function SetupFailureDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly details: FailedSetupDetails | null;
  readonly onClose: () => void;
}) {
  const setupProject = useAtomCommand(boardEnvironment.setupWorkerProject, {
    reportFailure: false,
  });
  const details = props.details;
  const failure = details?.setup.failure ?? null;
  const copy =
    details === null || failure === null
      ? null
      : setupFailureCopy({
          kind: failure.kind,
          worker: details.worker.label,
          host: remoteHost(details.project.repositoryKey ?? ""),
          path: details.setup.destinationPath,
        });
  const log =
    details === null || failure === null
      ? ""
      : `$ git clone ${details.project.repositoryKey ?? ""} ${details.setup.destinationPath}\n${failure.log}`;
  return (
    <Dialog
      open={details !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Couldn't clone {details?.project.title} on {details?.worker.label}
          </DialogTitle>
          <DialogDescription>{copy?.detail}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <pre
            className={cn(
              "max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/50 p-3 font-mono text-board-11-5",
            )}
          >
            {log}
          </pre>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              void navigator.clipboard.writeText(log);
              toastManager.add({ type: "success", title: "Log copied" });
            }}
          >
            Copy log
          </Button>
          <Button
            onClick={() => {
              if (details === null) return;
              props.onClose();
              void setupProject({
                environmentId: props.environmentId,
                input: {
                  projectId: details.project.id,
                  workerId: details.worker.id,
                  folder: details.setup.destinationPath,
                },
              });
            }}
          >
            Retry
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

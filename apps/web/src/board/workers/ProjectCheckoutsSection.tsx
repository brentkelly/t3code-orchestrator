/**
 * T3o (T3O-62): Settings → Board → Project checkouts (prototype 2.1–2.4).
 *
 * Board projects down, workers across. A worker can only run cards for a
 * project it has a checkout of — the checkout whose repository grouping key
 * matches the board project's (D20). Set up clones the project's remote onto
 * the worker, with that machine's git credentials; the clone runs on the
 * server, so leaving the page doesn't cancel it. Hidden on a local-only board.
 */
import {
  boardRepositoryGroupingKey,
  resolveBoardWorkerCheckout,
  type BoardWorkerSetup,
  type BoardWorkerView,
  type EnvironmentId,
  type OrchestrationProjectShell,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { CheckIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useMemo, useState } from "react";

import { Badge } from "../../components/ui/badge";
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
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { BoardHint } from "../BoardHint";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { useBoardWorkers, useNowAtDeadlines } from "./boardWorkersState";
import {
  checkoutCell,
  cloneStageLabel,
  remoteHost,
  SETUP_JUST_NOW_MS,
  setupFailureCopy,
  workerStatusPresentation,
  type CheckoutCell,
} from "./workerCopy";

/** A board project, as the matrix needs it. */
interface MatrixProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryKey: string | null;
  readonly repositoryName: string;
}

function matrixProject(project: OrchestrationProjectShell): MatrixProject {
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

export function ProjectCheckoutsSection(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const workers = useBoardWorkers(environmentId);
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const projects = useMemo(
    () => (Option.getOrNull(shellState.snapshot)?.projects ?? []).map(matrixProject),
    [shellState.snapshot],
  );
  const setups = workers.state.setups;
  // Re-read the clock only when a "Set up just now" cell is due to settle.
  const justNowDeadlines = useMemo(
    () =>
      setups.flatMap((setup) =>
        setup.phase === "done" && setup.endedAt !== null
          ? [Date.parse(setup.endedAt) + SETUP_JUST_NOW_MS]
          : [],
      ),
    [setups],
  );
  const nowMs = useNowAtDeadlines(justNowDeadlines);
  const [details, setDetails] = useState<{
    readonly setup: BoardWorkerSetup;
    readonly worker: BoardWorkerView;
    readonly project: MatrixProject;
  } | null>(null);

  if (projects.length === 0) {
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Add a project to the board to see where it's checked out.
      </p>
    );
  }

  const columns = workers.state.workers;
  return (
    <>
      <div className="mx-3 overflow-x-auto rounded-xl border border-border bg-card shadow-xs sm:mx-4">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-border text-left text-[11.5px] text-muted-foreground">
              <th className="px-4 py-2 font-medium">Project</th>
              <th className="px-3 py-2 font-medium">
                <div className="flex flex-col gap-0.5">
                  <span className="text-foreground">This server</span>
                  <span>Online</span>
                </div>
              </th>
              {columns.map((worker) => {
                const status = workerStatusPresentation(worker, "");
                return (
                  <th key={worker.id} className="px-3 py-2 font-medium">
                    <div className="flex flex-col items-start gap-0.5">
                      <span className="text-foreground">{worker.label}</span>
                      <Badge
                        variant={
                          status.tone === "warning"
                            ? "warning"
                            : status.tone === "running"
                              ? "info"
                              : "outline"
                        }
                      >
                        {status.label === "Incompatible version" ? "Incompatible" : status.label}
                      </Badge>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr key={project.id} className="border-b border-border last:border-b-0">
                <td className="px-4 py-2.5 align-top">
                  <div className="flex flex-col">
                    <span className="font-medium text-foreground">{project.title}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {project.repositoryKey ?? "No git remote"}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-2.5 align-top">
                  <CellCheckedOut path={project.workspaceRoot} lastKnown={false} />
                </td>
                {columns.map((worker) => {
                  const setup =
                    setups.find(
                      (candidate) =>
                        candidate.workerId === worker.id && candidate.projectId === project.id,
                    ) ?? null;
                  return (
                    <td key={worker.id} className="px-3 py-2.5 align-top">
                      {worker.snapshot === null && worker.status.state === "connecting" ? (
                        <span className="flex items-center gap-1.5 text-muted-foreground">
                          <Spinner className="size-3" /> Checking…
                        </span>
                      ) : (
                        <Cell
                          environmentId={environmentId}
                          worker={worker}
                          project={project}
                          setup={setup}
                          cell={checkoutCell({
                            worker,
                            checkout: resolveBoardWorkerCheckout(
                              project.repositoryKey,
                              worker.snapshot?.checkouts ?? [],
                            ),
                            setup,
                            projectHasRemote: project.repositoryKey !== null,
                            nowMs,
                          })}
                          onDetails={(failed) => setDetails({ setup: failed, worker, project })}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SetupFailureDialog
        environmentId={environmentId}
        details={details}
        onClose={() => setDetails(null)}
      />
    </>
  );
}

function CellCheckedOut(props: { readonly path: string; readonly lastKnown: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="flex items-center gap-1 text-muted-foreground">
        <CheckIcon className="size-3.5" /> Checked out
      </span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">
        {props.lastKnown ? "Last known · offline" : props.path}
      </span>
    </div>
  );
}

function Cell(props: {
  readonly environmentId: EnvironmentId;
  readonly worker: BoardWorkerView;
  readonly project: MatrixProject;
  readonly setup: BoardWorkerSetup | null;
  readonly cell: CheckoutCell;
  readonly onDetails: (setup: BoardWorkerSetup) => void;
}) {
  const { cell, worker, project } = props;
  switch (cell.kind) {
    case "checked-out":
      return <CellCheckedOut path={cell.path} lastKnown={cell.lastKnown} />;
    case "set-up-just-now":
      return (
        <div className="flex flex-col">
          <span className="flex items-center gap-1 text-success-foreground">
            <CheckIcon className="size-3.5" /> Set up just now
          </span>
          <span className="truncate font-mono text-[11px] text-muted-foreground">{cell.path}</span>
        </div>
      );
    case "cloning":
      return (
        <div className="flex flex-col">
          <span className="flex items-center gap-1.5 text-info-foreground">
            <Spinner className="size-3" /> Cloning
            {cell.percent === null ? "" : ` · ${cell.percent}%`}
          </span>
          <span className="text-[11px] text-muted-foreground">{cloneStageLabel(cell.stage)}</span>
        </div>
      );
    case "failed": {
      const copy = setupFailureCopy({
        kind: cell.failureKind,
        worker: worker.label,
        host: project.repositoryKey?.split("/")[0] ?? "the remote",
        path: cell.setup.destinationPath,
      });
      return (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-warning-foreground">Clone failed</span>
          <span className="text-[11px] text-muted-foreground">{copy.cell}</span>
          <div className="flex gap-1">
            <SetUpButton
              environmentId={props.environmentId}
              worker={worker}
              project={project}
              label="Retry"
              defaultFolder={cell.setup.destinationPath}
              direct={cell.failureKind !== "folder-exists"}
            />
            <Button size="xs" variant="ghost" onClick={() => props.onDetails(cell.setup)}>
              Details
            </Button>
          </div>
        </div>
      );
    }
    case "not-checked-out":
      return (
        <div className="flex flex-col items-start gap-1">
          <span className="text-muted-foreground">Not checked out</span>
          {cell.canSetUp ? (
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
              label={`${project.title} has no git remote on This server, so workers can't clone it. Add a remote and push.`}
            >
              <span>
                <Button size="xs" variant="outline" disabled>
                  Set up on worker
                </Button>
              </span>
            </BoardHint>
          )}
        </div>
      );
    case "set-up-when-online":
      return (
        <div className="flex flex-col">
          <span className="text-muted-foreground">Not checked out</span>
          <span className="text-[11px] text-muted-foreground">Set up when online</span>
        </div>
      );
    case "re-pair-to-check":
      return <span className="text-warning-foreground">Re-pair to check</span>;
    case "update-to-check":
      return <span className="text-warning-foreground">Update T3o to check</span>;
  }
}

/**
 * Set up (2.2): a popover naming the remote and the folder, editable. Retry
 * of a failure that wasn't the folder's fault skips the popover.
 */
function SetUpButton(props: {
  readonly environmentId: EnvironmentId;
  readonly worker: BoardWorkerView;
  readonly project: MatrixProject;
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
          <p className="text-[12.5px] text-muted-foreground">
            Clones{" "}
            <span className="font-mono text-[11.5px] text-foreground">
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
function SetupFailureDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly details: {
    readonly setup: BoardWorkerSetup;
    readonly worker: BoardWorkerView;
    readonly project: MatrixProject;
  } | null;
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
              "max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/50 p-3 font-mono text-[11.5px]",
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

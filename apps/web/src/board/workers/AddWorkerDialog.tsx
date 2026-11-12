/**
 * Add worker (prototype 3.5). The board issues a one-time join code; the
 * worker runs `pnpm t3o-worker join` and dials the board. The dialog follows
 * the code through the board's live join-code list: waiting, checking in,
 * joined, or why not. Closing it never cancels the code.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  BOARD_WORKER_JOIN_CODE_TTL_MINUTES,
  BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION,
  type BoardWorkerJoinCodeCreated,
  type BoardWorkerJoinMilestone,
  type EnvironmentId,
} from "@t3tools/contracts";
import { CheckIcon, CircleIcon, InfoIcon } from "lucide-react";
import { useState } from "react";

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
import { toastManager } from "../../components/ui/toast";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { BoardDialogTitle } from "../ui/BoardDialog";
import { useNowAtDeadlines } from "./boardWorkersState";
import {
  joinDialogDeadlines,
  joinDialogPhase,
  joinProgressKey,
  latchJoinDialogPhase,
  minutesLeft,
  type JoinDialogPhase,
} from "./joinDialog";
import { clockTime, T3O_UPDATE_COMMAND } from "./workerCopy";
import { initialWorkerAbbreviation, workerNameProblems } from "./workerNames";
import { CopyCommand, WorkerNameFields } from "./workerUi";

const BOARD_WORKERS_DOCS_URL =
  "https://github.com/brentkelly/t3code-orchestrator/blob/t3o/docs/user/board-workers.md#workers";

/** The join command a worker runs, with the board's address. */
function workerJoinCommand(boardUrl: string, code: string): string {
  return `pnpm t3o-worker join ${boardUrl} --code ${code}`;
}

export function AddWorkerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The code this client created and still holds, or null while one is being made. */
  readonly created: BoardWorkerJoinCodeCreated | null;
  readonly creating: boolean;
  readonly createError: string | null;
  readonly onCreateCode: () => void;
  readonly boardUrl: string;
  /** No board address is set: the URL is this browser's own. */
  readonly boardUrlIsFallback: boolean;
  readonly onSetBoardAddress: () => void;
  readonly onSetUpProjects: () => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-[500px]">
        {props.open ? <AddWorkerBody {...props} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function AddWorkerBody(props: Parameters<typeof AddWorkerDialog>[0]) {
  const close = () => props.onOpenChange(false);
  if (props.created === null) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Add a worker</DialogTitle>
          <DialogDescription>
            {props.createError ?? (props.creating ? "Creating a join code…" : "")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Close
          </Button>
          {props.createError === null ? null : (
            <Button disabled={props.creating} onClick={props.onCreateCode}>
              Try again
            </Button>
          )}
        </DialogFooter>
      </>
    );
  }
  // Keyed by code: the phase a code reached never carries over to the next one.
  return (
    <JoinCodeFlow key={props.created.codeId} {...props} created={props.created} close={close} />
  );
}

function JoinCodeFlow(
  props: Parameters<typeof AddWorkerDialog>[0] & {
    readonly created: BoardWorkerJoinCodeCreated;
    readonly close: () => void;
  },
) {
  const { created } = props;
  const state = useAtomValue(boardEnvironment.workersAtom(props.environmentId));
  const deadlines = joinDialogDeadlines({
    codeId: created.codeId,
    expiresAt: created.expiresAt,
    state,
  });
  // Minutes left only change once a minute; re-read the clock on those edges.
  const expiresMs = Date.parse(created.expiresAt);
  const minuteEdges = Array.from(
    { length: BOARD_WORKER_JOIN_CODE_TTL_MINUTES + 1 },
    (_, index) => expiresMs - index * 60_000,
  );
  const nowMs = useNowAtDeadlines([...deadlines, ...minuteEdges]);
  const [reached, setReached] = useState<JoinDialogPhase | null>(null);
  const listed = joinDialogPhase({
    codeId: created.codeId,
    expiresAt: created.expiresAt,
    state,
    nowMs,
  });
  if (
    (listed.kind === "checking" || listed.kind === "joined") &&
    joinProgressKey(listed) !== (reached === null ? null : joinProgressKey(reached))
  ) {
    setReached(listed);
  }
  const phase = latchJoinDialogPhase(reached, listed, state);
  const cancelCode = useAtomCommand(boardEnvironment.cancelWorkerJoinCode, {
    reportFailure: false,
  });

  const runCancel = async () => {
    const result = await cancelCode({
      environmentId: props.environmentId,
      input: { codeId: created.codeId },
    });
    if (result._tag !== "Success") {
      toastManager.add({ type: "error", title: describeBoardCommandFailure(result) });
      return;
    }
    props.close();
  };

  if (phase.kind === "joined") {
    return (
      <JoinedStep
        environmentId={props.environmentId}
        phase={phase}
        close={props.close}
        onSetUpProjects={props.onSetUpProjects}
      />
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add a worker</DialogTitle>
        <DialogDescription>
          Run the command below on the machine you want to add. It joins this board and takes cards
          from it.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col items-start gap-1">
            <span className="font-mono text-board-21 font-semibold tracking-wider">
              {created.code}
            </span>
            <span className="text-board-12 text-muted-foreground">
              {phase.kind === "expired"
                ? `Expired at ${clockTime(created.expiresAt)}`
                : `Expires at ${clockTime(created.expiresAt)} · in ${minutesLeft(created.expiresAt, nowMs)} min · works once`}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <CopyCommand
              command={workerJoinCommand(props.boardUrl, created.code)}
              target="join command"
            />
            <span className="text-board-12 text-muted-foreground">
              Run in a T3o checkout on a Linux worker.{" "}
              <a
                className="underline underline-offset-2"
                href={BOARD_WORKERS_DOCS_URL}
                rel="noreferrer"
                target="_blank"
              >
                How workers join
              </a>
            </span>
            {props.boardUrlIsFallback ? (
              <span className="text-board-12 text-muted-foreground">
                Make sure workers can reach this address.{" "}
                <button
                  className="underline underline-offset-2 hover:text-foreground"
                  onClick={() => {
                    props.close();
                    props.onSetBoardAddress();
                  }}
                  type="button"
                >
                  Set the board address
                </button>
              </span>
            ) : null}
          </div>
          <div className="flex gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-board-12-5 text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              The worker needs outbound HTTPS to this board only: no inbound ports or VPN. Anyone
              who uses this board can see the worker's threads.
            </span>
          </div>
          <JoinPhaseBox phase={phase} onCreateCode={props.onCreateCode} creating={props.creating} />
        </div>
      </DialogPanel>
      <DialogFooter>
        {phase.kind === "waiting" || (phase.kind === "needs-update" && phase.usedBy === null) ? (
          <Button variant="ghost-destructive" onClick={() => void runCancel()}>
            Cancel code
          </Button>
        ) : null}
        <Button variant="outline" onClick={props.close}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

const STEPS: ReadonlyArray<{
  readonly milestone: Exclude<BoardWorkerJoinMilestone, "joined">;
  readonly label: string;
}> = [
  { milestone: "code-accepted", label: "Code accepted" },
  { milestone: "connected", label: "Connected" },
  { milestone: "reading", label: "Reading capacity and providers" },
  { milestone: "checking", label: "Checking project checkouts" },
];

function JoinPhaseBox(props: {
  readonly phase: Exclude<JoinDialogPhase, { kind: "joined" }>;
  readonly onCreateCode: () => void;
  readonly creating: boolean;
}) {
  const { phase } = props;
  const newCode = (
    <div>
      <Button size="xs" variant="outline" disabled={props.creating} onClick={props.onCreateCode}>
        Create new code
      </Button>
    </div>
  );
  switch (phase.kind) {
    case "waiting":
      return (
        <div className="flex items-center gap-2 rounded-lg border border-attention/30 bg-attention/8 px-3 py-2.5 text-board-12-5 text-attention-foreground">
          <span className="size-2 shrink-0 rounded-full bg-attention" />
          Waiting for a worker to join. Closing this doesn't cancel the code.
        </div>
      );
    case "expired":
    case "cancelled":
    case "already-used":
      return (
        <WarningBox
          title={
            phase.kind === "expired"
              ? "This code expired"
              : phase.kind === "cancelled"
                ? "This code was cancelled"
                : "This code was already used"
          }
          body={
            phase.kind === "already-used"
              ? "A code works once. Create a new one for the next worker."
              : "Create a new code and run the new command on the worker."
          }
        >
          {newCode}
        </WarningBox>
      );
    case "needs-update":
      return (
        <WarningBox
          title={`${phase.usedBy?.label ?? "The worker"} needs a newer T3o`}
          body={`It runs T3o ${phase.release ?? "an older release"}; this board needs ${BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION} or newer. Update it, then run the join command again. ${
            phase.usedBy === null
              ? "This code stays valid until it expires."
              : "It's connected but takes no new cards until it's updated."
          }`}
        >
          <CopyCommand command={T3O_UPDATE_COMMAND} target="update command" />
          {phase.usedBy === null ? null : newCode}
        </WarningBox>
      );
    case "checking": {
      const reached = new Set(phase.milestones);
      const next = STEPS.find((step) => !reached.has(step.milestone));
      return (
        <div className="flex flex-col gap-2.5 rounded-lg border border-border px-3 py-2.5">
          <span className="text-board-12-5">
            Code was used by <span className="font-medium">{phase.usedBy.label}</span>
            {phase.usedBy.address === null ? "" : ` from ${phase.usedBy.address}`}
          </span>
          <ol className="flex flex-col gap-1.5">
            {STEPS.map((step) => {
              const done = reached.has(step.milestone);
              const current = step === next;
              return (
                <li
                  className="flex items-center gap-2 text-board-12-5"
                  key={step.milestone}
                  aria-current={current ? "step" : undefined}
                >
                  {done ? (
                    <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : current ? (
                    <span className="mx-[3px] size-2 shrink-0 rounded-full bg-info" />
                  ) : (
                    <CircleIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                  )}
                  <span className={done || current ? "text-foreground" : "text-muted-foreground"}>
                    {step.label}
                    {step.milestone === "connected" && done && phase.usedBy.t3oRelease !== null
                      ? ` · T3o ${phase.usedBy.t3oRelease}`
                      : ""}
                  </span>
                </li>
              );
            })}
          </ol>
          {phase.stalled ? (
            <WarningBox
              title={`${phase.usedBy.label} hasn't connected yet`}
              body="The code was accepted, but the worker hasn't opened its connection to the board. Check it on the worker:"
            >
              <CopyCommand command="pnpm t3o-worker status" target="status command" />
              {newCode}
            </WarningBox>
          ) : null}
        </div>
      );
    }
  }
}

function WarningBox(props: {
  readonly title: string;
  readonly body: string;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2.5">
      <span className="text-board-12-5 font-medium text-warning-foreground">{props.title}</span>
      <span className="text-board-12-5 text-muted-foreground">{props.body}</span>
      {props.children}
    </div>
  );
}

function JoinedStep(props: {
  readonly environmentId: EnvironmentId;
  readonly phase: Extract<JoinDialogPhase, { kind: "joined" }>;
  readonly close: () => void;
  readonly onSetUpProjects: () => void;
}) {
  const { usedBy, worker } = props.phase;
  const state = useAtomValue(boardEnvironment.workersAtom(props.environmentId));
  const rename = useAtomCommand(boardEnvironment.renameWorker, { reportFailure: false });
  const named = {
    id: usedBy.workerId,
    label: worker?.label ?? usedBy.label,
    abbreviation: worker?.abbreviation,
  };
  const [label, setLabel] = useState(named.label);
  const [abbreviation, setAbbreviation] = useState(() =>
    initialWorkerAbbreviation(
      worker ?? { id: usedBy.workerId, label: usedBy.label },
      state.workers,
    ),
  );
  const [saving, setSaving] = useState(false);
  const problems = workerNameProblems({
    workerId: usedBy.workerId,
    label,
    abbreviation,
    workers: state.workers,
  });
  const valid = problems.label === null && problems.abbreviation === null;
  const changed = label.trim() !== named.label || abbreviation !== named.abbreviation;
  const providers = worker?.snapshot?.providers.filter((provider) => provider.enabled) ?? [];
  const checkouts = worker?.snapshot?.checkouts.length ?? 0;

  const save = async (then: () => void) => {
    if (!changed) {
      then();
      return;
    }
    setSaving(true);
    const result = await rename({
      environmentId: props.environmentId,
      input: { workerId: usedBy.workerId, label: label.trim(), abbreviation },
    });
    setSaving(false);
    if (result._tag !== "Success") {
      toastManager.add({ type: "error", title: describeBoardCommandFailure(result) });
      return;
    }
    then();
  };

  return (
    <>
      <DialogHeader>
        <BoardDialogTitle look="with-icon">
          <CheckIcon className="size-4 text-muted-foreground" />
          {usedBy.rejoin ? `${named.label} rejoined` : `${named.label} joined`}
        </BoardDialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-board-13">
            <dt className="text-muted-foreground">T3o</dt>
            <dd>{worker?.status.t3oVersion ?? usedBy.t3oRelease ?? "Unknown"}</dd>
            <dt className="text-muted-foreground">Providers</dt>
            <dd>
              {providers.length === 0
                ? "None reported"
                : providers.map((provider) => provider.displayName ?? provider.driver).join(", ")}
            </dd>
            <dt className="text-muted-foreground">Projects</dt>
            <dd>
              {checkouts === 0
                ? "None set up yet"
                : `${checkouts} ${checkouts === 1 ? "checkout" : "checkouts"}`}
            </dd>
          </dl>
          <WorkerNameFields
            idPrefix="join-worker"
            label={label}
            abbreviation={abbreviation}
            problems={problems}
            onLabelChange={setLabel}
            onAbbreviationChange={setAbbreviation}
            hint="The abbreviation marks this worker on cards and thread rows."
          />
        </div>
      </DialogPanel>
      <DialogFooter>
        <Button
          variant="outline"
          disabled={!valid || saving}
          onClick={() =>
            void save(() => {
              props.close();
              props.onSetUpProjects();
            })
          }
        >
          Set up projects…
        </Button>
        <Button disabled={!valid || saving} onClick={() => void save(props.close)}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}

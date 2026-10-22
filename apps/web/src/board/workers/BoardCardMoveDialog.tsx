/**
 * T3o (T3O-65, prototype 5.1–5.4): moving a card that has a worktree to
 * another worker.
 *
 * Opening it checks the source worker first, and a refusal replaces the body
 * before anything happens: a step running (blue — it is work in progress, not a
 * fault), unpushed work with the commits and files that would be left behind,
 * no upstream branch, or a source that didn't answer. Otherwise it says what
 * the card continues from and the three things the move does, and once
 * started it follows the card's own move state — the card shows Moving until
 * the new worktree is ready, so closing this loses nothing.
 */
import {
  type BoardCard,
  type BoardCardWorkerMoveAnswer,
  type BoardWorkerId,
  type BoardWorkersState,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { CheckIcon, CircleIcon } from "lucide-react";
import { useEffect, useState } from "react";

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
import { Spinner } from "../../components/ui/spinner";
import { toastManager } from "../../components/ui/toast";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { boardMoveDialogStatus, boardWorkerLabel, type BoardMoveDialogStatus } from "./cardWorker";

type Phase =
  | { readonly kind: "checking" }
  | { readonly kind: "answer"; readonly answer: BoardCardWorkerMoveAnswer }
  | {
      readonly kind: "started";
      readonly fromWorkerId: BoardWorkerId | null;
      /** The card's last move when Move was pressed, so it isn't read as this one. */
      readonly priorStartedAt: string | null;
    }
  | { readonly kind: "failed"; readonly detail: string };

/** The move's progress rows, from where the move has got to. */
function moveProgress(status: BoardMoveDialogStatus, fromLabel: string | null, toLabel: string) {
  const checked = status !== "pending";
  const retired = status === "retired" || status === "done" || status === "failed";
  const done = status === "done";
  return [
    { label: "Checked for unpushed work", done: checked },
    ...(fromLabel === null ? [] : [{ label: `Retired worktree on ${fromLabel}`, done: retired }]),
    {
      label: done ? `Created worktree on ${toLabel}` : `Creating worktree on ${toLabel}…`,
      done,
    },
  ];
}

export function BoardCardMoveDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly card: BoardCard;
  readonly workers: BoardWorkersState;
  /** Where the card is moving; null closes the dialog. */
  readonly toWorkerId: BoardWorkerId | null;
  /** The human chose Follow default, so the card lands unpinned. */
  readonly followDefault: boolean;
  readonly onClose: () => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { card, toWorkerId } = props;
  const move = useAtomCommand(boardEnvironment.cardWorkerMove, { reportFailure: false });
  // Mounted afresh for each target (the row keys it), so it starts checking.
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  const { environmentId } = props;
  const cardId = card.id;

  useEffect(() => {
    if (toWorkerId === null) return;
    let live = true;
    void move({
      environmentId,
      input: { action: "check", cardId, toWorkerId },
    }).then((result) => {
      if (!live) return;
      setPhase(
        result._tag === "Failure"
          ? { kind: "failed", detail: "The board server didn't answer. Try again." }
          : { kind: "answer", answer: result.value },
      );
    });
    return () => {
      live = false;
    };
  }, [cardId, environmentId, move, toWorkerId]);

  if (toWorkerId === null) return null;
  const to = boardWorkerLabel(toWorkerId, props.workers);

  const start = (fromWorkerId: BoardWorkerId | null) => {
    setPhase({
      kind: "started",
      fromWorkerId,
      priorStartedAt: card.workerMove?.startedAt ?? null,
    });
    void move({
      environmentId: props.environmentId,
      // No worker is Follow default: the server moves to the board's default
      // and leaves the card unpinned.
      input: { action: "move", cardId: card.id, ...(props.followDefault ? {} : { toWorkerId }) },
    }).then((result) => {
      if (result._tag === "Failure") {
        setPhase({ kind: "failed", detail: "The board server didn't answer. Try again." });
        return;
      }
      if (result.value.outcome !== "started") setPhase({ kind: "answer", answer: result.value });
    });
  };

  const askToPush = () => {
    void move({
      environmentId: props.environmentId,
      input: { action: "ask-push", cardId: card.id },
    }).then((result) => {
      const sent = result._tag === "Success" && result.value.outcome === "sent";
      toastManager.add(
        sent
          ? { type: "success", title: "Asked the agent to push" }
          : {
              type: "error",
              title: "Couldn't reach the card's agent",
              description: "Push the branch yourself, then move the card.",
            },
      );
      if (sent) props.onClose();
    });
  };

  const body = (() => {
    if (phase.kind === "checking") {
      return {
        title: `Move ${card.key} to ${to}?`,
        description: "Checking for unpushed work…",
        content: <Spinner className="size-4" />,
        actions: null,
      };
    }
    if (phase.kind === "failed") {
      return {
        title: `Can't move ${card.key}`,
        description: phase.detail,
        content: null,
        actions: null,
      };
    }
    if (phase.kind === "started") {
      const status = boardMoveDialogStatus(card, {
        toWorkerId,
        priorStartedAt: phase.priorStartedAt,
      });
      const failed = status === "failed";
      return {
        title: failed ? `Move to ${to} failed` : `Moving ${card.key} to ${to}`,
        description: failed
          ? `${card.workerMove?.error ?? "Creating the worktree failed."} The old worktree is already retired, so pick a worker to try again.`
          : status === "done"
            ? `${card.key} is on ${to}. Its next step runs there.`
            : `You can close this. The card shows “Moving to ${to}” until it's done.`,
        content: (
          <ul className="flex flex-col gap-1.5 text-[12.5px]">
            {moveProgress(
              status,
              phase.fromWorkerId === null
                ? null
                : boardWorkerLabel(phase.fromWorkerId, props.workers),
              to,
            ).map((step) => (
              <li className="flex items-center gap-2" key={step.label}>
                {step.done ? (
                  <CheckIcon className="size-3.5 text-muted-foreground" />
                ) : failed ? (
                  <CircleIcon className="size-3.5 text-warning-foreground" />
                ) : (
                  <Spinner className="size-3.5" />
                )}
                <span>{step.label}</span>
              </li>
            ))}
          </ul>
        ),
        actions: null,
      };
    }
    const answer = phase.answer;
    switch (answer.outcome) {
      case "ready": {
        const from =
          answer.fromWorkerId === null
            ? null
            : boardWorkerLabel(answer.fromWorkerId, props.workers);
        return {
          title: `Move ${card.key} to ${to}?`,
          description: `Everything on ${answer.branch} is pushed, so the card can continue on ${to}.`,
          content: (
            <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[12.5px]">
              {from === null ? null : (
                <li>
                  The worktree on {from} is retired. Its files stay on disk; T3o stops using them.
                </li>
              )}
              <li>
                A new worktree is created on {to} from{" "}
                <code className="font-mono">origin/{answer.branch}</code>
                {answer.tip === null ? null : (
                  <>
                    {" "}
                    at <code className="font-mono">{answer.tip.sha.slice(0, 7)}</code>
                  </>
                )}
                .
              </li>
              <li>
                The next step runs on {to}.
                {from === null
                  ? null
                  : ` Earlier threads stay on ${from} and stay linked from the card.`}
              </li>
            </ol>
          ),
          actions: <Button onClick={() => start(answer.fromWorkerId)}>Move to {to}</Button>,
        };
      }
      case "step-running": {
        const where = boardWorkerLabel(answer.workerId, props.workers);
        const threadId = answer.threadId;
        return {
          title: `Can't move ${card.key} yet`,
          description: `The ${answer.stepLabel ?? "current"} step is running on ${where}. Wait for it to finish or stop it, then move the card.`,
          content: null,
          actions:
            threadId === null ? null : (
              <Button onClick={() => props.onOpenThread(threadId)}>Open thread</Button>
            ),
        };
      }
      case "unpushed": {
        const where = boardWorkerLabel(answer.workerId, props.workers);
        const files = answer.changedPaths.length;
        return {
          title: `Can't move ${card.key}: unpushed work`,
          description: `The worktree on ${where} has work that isn't on origin. Moving now would leave it behind. Push it (or ask the agent to), then move.`,
          content: (
            <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/40 p-2.5 text-[12px]">
              <span className="font-medium">
                {[
                  answer.unpushedCount > 0
                    ? `${answer.unpushedCount} ${answer.unpushedCount === 1 ? "commit" : "commits"} ahead of origin`
                    : null,
                  files > 0 ? `${files} uncommitted ${files === 1 ? "file" : "files"}` : null,
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
              {answer.commits.map((commit) => (
                <span className="truncate font-mono text-[11.5px]" key={commit.sha}>
                  {commit.sha} {commit.subject}
                </span>
              ))}
              {files === 0 ? null : (
                <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                  {answer.changedPaths.join(" · ")}
                </span>
              )}
            </div>
          ),
          actions: <Button onClick={askToPush}>Ask agent to push</Button>,
        };
      }
      case "no-upstream":
        return {
          title: `Can't move ${card.key}: unpushed work`,
          description: `No upstream branch yet. Push ${answer.branch} to origin, then move.`,
          content: null,
          actions: <Button onClick={askToPush}>Ask agent to push</Button>,
        };
      case "no-remote-branch":
        // Only a force-move asks for this; the Move dialog never does.
        return {
          title: `Can't move ${card.key}`,
          description: `${answer.branch} isn't on the remote, so there is nothing to continue from.`,
          content: null,
          actions: null,
        };
      case "source-unreachable":
        return {
          title: `Can't move ${card.key}`,
          description: `Couldn't check ${boardWorkerLabel(answer.workerId, props.workers)} for unpushed work: worker didn't answer.`,
          content: null,
          actions: null,
        };
      case "pin":
        return {
          title: `Move ${card.key} to ${to}?`,
          description: `${card.key} has no worktree, so it just runs its next step on ${to}.`,
          content: null,
          actions: null,
        };
      case "refused":
        return {
          title: `Can't move ${card.key}`,
          description: answer.detail,
          content: null,
          actions: null,
        };
      case "started":
      case "sent":
      case "no-thread":
      case "failed":
        return {
          title: `Moving ${card.key} to ${to}`,
          description: "",
          content: null,
          actions: null,
        };
    }
  })();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{body.title}</DialogTitle>
          <DialogDescription>{body.description}</DialogDescription>
        </DialogHeader>
        {body.content === null ? null : <DialogPanel>{body.content}</DialogPanel>}
        <DialogFooter>
          <Button onClick={props.onClose} variant="outline">
            {phase.kind === "answer" && phase.answer.outcome === "ready" ? "Cancel" : "Close"}
          </Button>
          {body.actions}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

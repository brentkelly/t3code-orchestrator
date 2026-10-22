/**
 * T3o (T3O-66, D22; prototype 5.5–5.6): force-moving a card off a worker the
 * board can't reach — offline, or removed.
 *
 * Nothing on the old worker can be checked, so the card continues from its
 * branch on the remote, and whatever wasn't pushed is abandoned there: the
 * move stays disabled until the human ticks that they accept it. With no
 * branch on the remote there is nothing to continue from, and a second
 * confirmation offers to restart the card's Build from its base instead.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  type BoardCard,
  type BoardCardWorkerMoveAnswer,
  type BoardWorkerId,
  type BoardWorkersState,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { boardWorkerLabel, type BoardWorkerChoice } from "./cardWorker";
import { LOCAL_WORKER_LABEL } from "./threadWorker";

/** "today 08:51", or "12 Mar 08:51" on another day. */
function pushedAtLabel(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return new Date().toDateString() === at.toDateString()
    ? `today ${time}`
    : `${at.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}

type Phase =
  | { readonly kind: "checking" }
  | { readonly kind: "answer"; readonly answer: BoardCardWorkerMoveAnswer }
  | { readonly kind: "confirm-restart"; readonly branch: string; readonly baseRefName: string }
  | { readonly kind: "moving" }
  | { readonly kind: "failed"; readonly detail: string };

export function BoardCardForceMoveDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly card: BoardCard;
  readonly workers: BoardWorkersState;
  /** The Pin to rows; the source and anything unpickable are left out. */
  readonly choices: ReadonlyArray<BoardWorkerChoice>;
  /** The worker the card is stuck on, and whether it was removed. */
  readonly source: { readonly label: string; readonly removed: boolean };
  readonly sourceWorkerId: BoardWorkerId | null;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { card, environmentId, source } = props;
  const move = useAtomCommand(boardEnvironment.cardWorkerMove, { reportFailure: false });
  const targets = useMemo(() => {
    const picked = props.choices.filter(
      (choice) => choice.selectable && choice.workerId !== props.sourceWorkerId,
    );
    // A board whose last worker was removed has only this server left.
    return picked.length > 0 || props.sourceWorkerId === BOARD_LOCAL_WORKER_ID
      ? picked
      : [
          {
            workerId: BOARD_LOCAL_WORKER_ID,
            label: `${LOCAL_WORKER_LABEL} (local)`,
            selectable: true,
            detail: "",
            tooltip: null,
            canSetUp: false,
            cloning: false,
          } satisfies BoardWorkerChoice,
        ];
  }, [props.choices, props.sourceWorkerId]);
  const initial =
    targets.find((choice) => choice.workerId === props.workers.defaultWorkerId)?.workerId ??
    targets[0]?.workerId ??
    null;
  // The rows can arrive after the dialog opens, so the default is derived
  // until the human picks.
  const [picked, setPicked] = useState<BoardWorkerId | null>(null);
  const target = picked ?? initial;
  const [abandon, setAbandon] = useState(false);
  /** The check's answer, for the target it was asked about. */
  const [checked, setChecked] = useState<{
    readonly target: BoardWorkerId;
    readonly phase: Phase;
  } | null>(null);
  /** What the human's own clicks led to, over the check's answer. */
  const [action, setAction] = useState<Phase | null>(null);
  const cardId = card.id;
  const open = props.open;
  const phase: Phase =
    action ??
    (checked !== null && checked.target === target ? checked.phase : { kind: "checking" });
  const setPhase = setAction;

  useEffect(() => {
    if (!open || target === null) return;
    let live = true;
    void move({
      environmentId,
      input: { action: "check", cardId, toWorkerId: target, force: true },
    }).then((result) => {
      if (!live) return;
      setChecked({
        target,
        phase:
          result._tag === "Failure"
            ? { kind: "failed", detail: "The board server didn't answer. Try again." }
            : { kind: "answer", answer: result.value },
      });
    });
    return () => {
      live = false;
    };
  }, [cardId, environmentId, move, open, target]);

  if (!open) return null;
  const to = target === null ? "another worker" : boardWorkerLabel(target, props.workers);

  const run = (restartFromBase: boolean) => {
    if (target === null) return;
    setPhase({ kind: "moving" });
    void move({
      environmentId,
      input: {
        action: "move",
        cardId,
        toWorkerId: target,
        force: true,
        ...(restartFromBase ? { restartFromBase: true } : {}),
      },
    }).then((result) => {
      if (result._tag === "Failure") {
        setPhase({ kind: "failed", detail: "The board server didn't answer. Try again." });
        return;
      }
      // Started: the card shows Moving, or its new worker, from here on.
      if (result.value.outcome === "started") props.onClose();
      else setPhase({ kind: "answer", answer: result.value });
    });
  };

  if (phase.kind === "confirm-restart") {
    return (
      <Dialog open onOpenChange={(next) => (next ? undefined : props.onClose())}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Restart {card.key} from {phase.baseRefName}?
            </DialogTitle>
            <DialogDescription>
              <code className="font-mono">origin/{phase.branch}</code> doesn't exist, so there's
              nothing pushed to continue from.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <p className="text-[13px]">
              {to} creates a fresh worktree from{" "}
              <code className="font-mono">{phase.baseRefName}</code> and the card goes back to the
              start of Build. All code work from {source.label} is abandoned. The brief, plan and
              thread history are kept.
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() =>
                setPhase({
                  kind: "answer",
                  answer: {
                    outcome: "no-remote-branch",
                    workerId: target ?? BOARD_LOCAL_WORKER_ID,
                    branch: phase.branch,
                    baseRefName: phase.baseRefName,
                  },
                })
              }
            >
              Go back
            </Button>
            <Button variant="destructive" onClick={() => run(true)}>
              Restart from {phase.baseRefName}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    );
  }

  const answer = phase.kind === "answer" ? phase.answer : null;
  const ready = answer?.outcome === "ready" ? answer : null;
  const noRemote = answer?.outcome === "no-remote-branch" ? answer : null;
  const pinOnly = answer?.outcome === "pin";
  const refusal =
    answer?.outcome === "refused" ? answer.detail : phase.kind === "failed" ? phase.detail : null;
  const pushedAt = ready?.tip == null ? null : pushedAtLabel(ready.tip.committedAt);
  const canMove =
    phase.kind === "answer" && (pinOnly || (abandon && (ready !== null || noRemote !== null)));

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Force-move {card.key} off {source.label}
          </DialogTitle>
          <DialogDescription>
            {source.removed
              ? `${source.label} was removed from the board, so T3o can't check it for unpushed work.`
              : `${source.label} is offline, so T3o can't check it for unpushed work.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-[13px]">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-muted-foreground">Move to</span>
              <Select<BoardWorkerId>
                value={target}
                onValueChange={(value) => {
                  if (value === null) return;
                  setPicked(value);
                  setAction(null);
                }}
                items={targets.map((choice) => ({ value: choice.workerId, label: choice.label }))}
              >
                <SelectTrigger size="sm" aria-label="Move to">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {targets.map((choice) => (
                    <SelectItem key={choice.workerId} value={choice.workerId}>
                      {choice.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </label>
            {targets.length === 0 ? (
              <span className="text-muted-foreground">
                No other worker can take this card now: each is offline, or has no checkout of its
                project.
              </span>
            ) : null}
            {phase.kind === "checking" || phase.kind === "moving" ? (
              <Spinner className="size-4" />
            ) : null}
            {pinOnly ? (
              <span>
                {card.key} has no worktree, so it just runs its next step on {to}.
              </span>
            ) : null}
            {ready !== null || noRemote !== null ? (
              <div className="flex flex-col gap-1">
                <span className="text-[12px] font-medium text-muted-foreground">
                  Continues from
                </span>
                <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-muted/40 p-2.5">
                  <span className="font-mono text-[12px]">
                    origin/{ready?.branch ?? noRemote?.branch}
                    {ready?.tip == null ? null : (
                      <span className="text-muted-foreground"> {ready.tip.sha.slice(0, 7)}</span>
                    )}
                  </span>
                  {ready?.tip == null ? (
                    <span className="text-muted-foreground">
                      {noRemote !== null
                        ? "Not on the remote: nothing was pushed."
                        : "The branch's tip couldn't be read."}
                    </span>
                  ) : (
                    <>
                      <span className="truncate">{ready.tip.subject}</span>
                      <span className="text-[12px] text-muted-foreground">
                        Pushed {pushedAt}
                        {ready.tip.author === "" ? "" : ` by ${ready.tip.author}`}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ) : null}
            {ready !== null || noRemote !== null ? (
              <>
                <span className="rounded-md bg-warning/10 px-2 py-1.5 text-warning-foreground">
                  {pushedAt === null
                    ? `Anything on ${source.label} that wasn't pushed is abandoned.`
                    : `Anything on ${source.label} that wasn't pushed after ${pushedAt} is abandoned.`}{" "}
                  It stays on that machine, but this card won't use it.
                </span>
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={abandon}
                    onCheckedChange={(checked) => setAbandon(checked === true)}
                  />
                  <span>Abandon unpushed work on {source.label}</span>
                </label>
              </>
            ) : null}
            {refusal === null ? null : <span className="text-warning-foreground">{refusal}</span>}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canMove}
            onClick={() => {
              if (noRemote !== null) {
                setPhase({
                  kind: "confirm-restart",
                  branch: noRemote.branch,
                  baseRefName: noRemote.baseRefName,
                });
                return;
              }
              run(false);
            }}
          >
            Force-move to {to}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Remove worker (prototype 3.7): the cards removal affects, from the board
 * server. Cards with no worktree yet move to the default worker; cards with
 * work there hold, showing "Worker removed: move this card", until moved.
 */
import type {
  BoardWorkerId,
  BoardWorkerRemovePreview,
  BoardWorkerRemovePreviewCard,
  BoardWorkerView,
  EnvironmentId,
} from "@t3tools/contracts";
import { InfoIcon } from "lucide-react";
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
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";

export function RemoveWorkerDialog(props: {
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the board server which cards the removal would affect while the confirm is open.
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
  const result = current?.result ?? null;
  const name = worker?.label ?? "";
  const offline = worker?.status.state === "offline";
  const affected = result === null ? 0 : result.toDefault.length + result.byHand.length;
  const waiting = result?.byHand.filter((card) => !card.running) ?? [];
  const running = result?.byHand.filter((card) => card.running) ?? [];
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
              : result === null
                ? `Couldn't list the cards on ${name}.`
                : affected === 0
                  ? `No cards are on ${name}.`
                  : `${affected} ${affected === 1 ? "card is" : "cards are"} on ${name}.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-3 px-6 pb-4 text-board-13">
          {result !== null && result.toDefault.length > 0 ? (
            <RemovePreviewGroup
              title="Move to the default worker"
              subtitle={`${result.defaultWorkerLabel} · no work on ${name} yet`}
              cards={result.toDefault}
            />
          ) : null}
          {waiting.length > 0 ? (
            <RemovePreviewGroup
              title="Wait for you to move them"
              subtitle={`work is on ${name}, nothing running`}
              cards={waiting}
            />
          ) : null}
          {running.length > 0 ? (
            <RemovePreviewGroup
              title="Stop, then wait for you to move them"
              subtitle={
                offline
                  ? `a step is running · unpushed work on ${name} may be lost`
                  : "a step is running"
              }
              cards={running}
              warning
            />
          ) : null}
          {waiting.length + running.length > 0 ? (
            <span className="text-muted-foreground">
              These cards show “Worker removed: move this card” until you pick a new worker. They
              continue from their pushed branch.
            </span>
          ) : null}
          <div className="flex gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-board-12-5 text-muted-foreground">
            <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Nothing on {name} is deleted: its worktrees, branches and thread history stay on that
              machine. To use it again, add it with a new join code.
            </span>
          </div>
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
  readonly warning?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 rounded-lg border p-2.5",
        props.warning === true ? "border-warning/50" : "border-border",
      )}
    >
      <span>
        <span className="text-board-12-5 font-semibold">{props.title}</span>
        <span
          className={cn(
            "text-board-12",
            props.warning === true ? "text-warning-foreground" : "text-muted-foreground",
          )}
        >
          {" "}
          · {props.subtitle}
        </span>
      </span>
      <ul className="flex flex-col gap-1">
        {props.cards.map((card) => (
          <li className="flex min-w-0 items-center gap-2 text-board-12-5" key={card.cardId}>
            <span className="shrink-0 font-mono text-board-11-5 text-muted-foreground">
              {card.key}
            </span>
            <span className="min-w-0 flex-1 truncate">{card.title}</span>
            <span className="shrink-0 text-board-11-5 text-muted-foreground">{card.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

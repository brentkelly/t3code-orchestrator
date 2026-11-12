/** Rename worker (prototype 3.6): label and abbreviation, checked as typed, with the chip it makes. */
import { useAtomValue } from "@effect/atom-react";
import {
  BOARD_LOCAL_WORKER_ID,
  type BoardWorkerView,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogClose,
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
import { initialWorkerAbbreviation, workerNameProblems } from "./workerNames";
import { WorkerAbbreviationBadge, WorkerNameFields } from "./workerUi";

export function RenameWorkerDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly worker: BoardWorkerView | null;
  readonly onClose: () => void;
}) {
  return (
    <Dialog
      open={props.worker !== null}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-[440px]">
        {props.worker === null ? null : (
          <RenameForm
            environmentId={props.environmentId}
            worker={props.worker}
            onClose={props.onClose}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
}

function RenameForm(props: {
  readonly environmentId: EnvironmentId;
  readonly worker: BoardWorkerView;
  readonly onClose: () => void;
}) {
  const { worker } = props;
  const state = useAtomValue(boardEnvironment.workersAtom(props.environmentId));
  const rename = useAtomCommand(boardEnvironment.renameWorker, { reportFailure: false });
  const [label, setLabel] = useState(worker.label);
  const [abbreviation, setAbbreviation] = useState(() =>
    initialWorkerAbbreviation(worker, state.workers),
  );
  const [saving, setSaving] = useState(false);
  const problems = workerNameProblems({
    workerId: worker.id,
    label,
    abbreviation,
    workers: state.workers,
  });
  const valid = problems.label === null && problems.abbreviation === null;

  const save = async () => {
    setSaving(true);
    const result = await rename({
      environmentId: props.environmentId,
      input: { workerId: worker.id, label: label.trim(), abbreviation },
    });
    setSaving(false);
    if (result._tag !== "Success") {
      toastManager.add({ type: "error", title: describeBoardCommandFailure(result) });
      return;
    }
    props.onClose();
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !saving) void save();
      }}
    >
      <DialogHeader>
        <DialogTitle>Rename {worker.label}</DialogTitle>
        <DialogDescription>
          The label is used on the Workers page and in dialogs; the abbreviation on cards, thread
          rows and filters.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <WorkerNameFields
            idPrefix="rename-worker"
            label={label}
            abbreviation={abbreviation}
            problems={problems}
            onLabelChange={setLabel}
            onAbbreviationChange={setAbbreviation}
            abbreviationLocked={worker.id === BOARD_LOCAL_WORKER_ID}
          />
          <div className="flex items-center gap-2 text-board-12-5 text-muted-foreground">
            <span>Preview</span>
            <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-1.5 py-0.5 text-foreground">
              <span className="truncate">{label.trim() || worker.label}</span>
              {abbreviation.length > 0 ? (
                <WorkerAbbreviationBadge abbreviation={abbreviation} />
              ) : null}
            </span>
            <span className="rounded-md border border-border px-1.5 py-0.5 font-mono text-board-11-5">
              {abbreviation || "None"}
            </span>
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
        <Button type="submit" disabled={!valid || saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

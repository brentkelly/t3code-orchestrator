/**
 * T3o card thread add menu (t3o-14) — the `+` in the card's thread tab strip.
 *
 * Three actions, one popover:
 *
 *   Auto-executing stage:  New thread — restart <stage label>   (board.card.start-stage-thread)
 *                          (the stage name reads mid-sentence, so lowercased)
 *                          New blank thread
 *                          Adopt an existing thread…
 *
 *   Otherwise:             New thread                            (blank)
 *                          Adopt an existing thread…
 *
 * The restart item appears ONLY when the card's current stage has `Auto execute`
 * on (t3o-15 generalised auto-kickoff to any stage), and is DISABLED while a
 * supervised run is in flight for the card — restarting under the supervisor
 * would leave two threads believing they own the same step (D1). Restart is a
 * server command, not a client-composed prompt: the reactor runs the stage's
 * configured prompt through the same envelope the automatic trigger uses (D2),
 * so the two entry points cannot drift.
 *
 * Adoption shares `BoardPickerSearchBody` with the standalone picker rather than
 * nesting a second popover inside a menu item — `mode` swaps this popover's
 * contents in place.
 */
import { MessageSquarePlusIcon, PlusIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { BoardPickerSearchBody, type BoardPickerOption } from "./BoardSearchAddPicker";

/**
 * The restart affordance's state, or `null` when the current stage does not
 * auto-execute (the item is absent, not disabled — D4). `label` names the stage
 * mid-sentence, so it reads lowercased ("restart planning"); a non-null
 * `disabledReason` disables the item and gives the tooltip / hint the reason a
 * supervised run in flight blocks a restart.
 */
export interface BoardThreadStageRestart {
  readonly label: string;
  readonly disabledReason: string | null;
}

function MenuRow({
  icon,
  title,
  hint,
  disabled,
  onClick,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly hint?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly onClick: () => void;
}) {
  // `disabled:pointer-events-none` would swallow a native `title` tooltip, so the
  // reason rides the always-visible `hint` sub-label instead — a disabled row is
  // still legible about WHY it is disabled.
  return (
    <button
      className="flex w-full items-start gap-2 rounded px-1.5 py-1.5 text-left hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="mt-px shrink-0 text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col">
        <span className="text-[12.5px] text-foreground">{title}</span>
        {hint === undefined ? null : (
          <span className="text-[11.5px] text-muted-foreground">{hint}</span>
        )}
      </span>
    </button>
  );
}

/**
 * The popover's contents. Exported and pure so the auto-execute gate — the
 * invariant this module exists to hold — is assertable in rendered markup: the
 * popup itself portals, and a portal renders nothing on the server, so the rows
 * are unreachable through `BoardCardThreadAddMenu`.
 */
export function BoardCardThreadAddMenuBody({
  mode,
  stageRestart,
  adoptableThreads,
  onRestartStage,
  onCreateBlankThread,
  onAdoptThread,
  onEnterAdoptMode,
}: {
  readonly mode: "menu" | "adopt";
  readonly stageRestart: BoardThreadStageRestart | null;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly onRestartStage: () => void;
  readonly onCreateBlankThread: () => void;
  readonly onAdoptThread: (threadId: string) => void;
  readonly onEnterAdoptMode: () => void;
}) {
  if (mode === "adopt") {
    return (
      <BoardPickerSearchBody
        onPick={onAdoptThread}
        options={adoptableThreads}
        placeholder="Search threads…"
      />
    );
  }
  return (
    <div className="flex flex-col gap-0.5">
      {stageRestart !== null ? (
        <MenuRow
          disabled={stageRestart.disabledReason !== null}
          hint={stageRestart.disabledReason ?? undefined}
          icon={<RotateCwIcon className="size-3.5" />}
          onClick={onRestartStage}
          title={`New thread — restart ${stageRestart.label.toLocaleLowerCase()}`}
        />
      ) : null}
      <MenuRow
        icon={<MessageSquarePlusIcon className="size-3.5" />}
        onClick={onCreateBlankThread}
        title={stageRestart !== null ? "New blank thread" : "New thread"}
      />
      <MenuRow
        icon={<SearchIcon className="size-3.5" />}
        onClick={onEnterAdoptMode}
        title="Adopt an existing thread…"
      />
    </div>
  );
}

export function BoardCardThreadAddMenu({
  label,
  stageRestart,
  adoptableThreads,
  onRestartStage,
  onCreateBlankThread,
  onAdoptThread,
}: {
  readonly label: string;
  /** Present only when the current stage auto-executes; `null` hides the
      restart item entirely. */
  readonly stageRestart: BoardThreadStageRestart | null;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly onRestartStage: () => void;
  readonly onCreateBlankThread: () => void;
  readonly onAdoptThread: (threadId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "adopt">("menu");
  // Reset on OPEN, never on close. The popup's contents unmount when it closes
  // but this component does not, so `mode` has to be cleared somewhere — doing
  // it on close swaps the adopt list back to the menu rows while the popover is
  // still fading out, which is the flicker `openCount` removes next door in
  // BoardSearchAddPicker.
  const [openCount, setOpenCount] = useState(0);
  const close = () => setOpen(false);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setMode("menu");
          setOpenCount((count) => count + 1);
        }
      }}
    >
      <PopoverTrigger
        aria-label="Add a thread"
        render={<Button size="xs" variant="ghost" />}
        title="Add a thread"
      >
        <PlusIcon />
        {label}
      </PopoverTrigger>
      <PopoverPopup className="w-64 p-1.5">
        <BoardCardThreadAddMenuBody
          adoptableThreads={adoptableThreads}
          key={openCount}
          mode={mode}
          onAdoptThread={(threadId) => {
            onAdoptThread(threadId);
            close();
          }}
          onCreateBlankThread={() => {
            onCreateBlankThread();
            close();
          }}
          onEnterAdoptMode={() => setMode("adopt")}
          onRestartStage={() => {
            onRestartStage();
            close();
          }}
          stageRestart={stageRestart}
        />
      </PopoverPopup>
    </Popover>
  );
}

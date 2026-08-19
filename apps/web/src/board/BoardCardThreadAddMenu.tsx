/**
 * T3o card thread add menu (t3o-14) — the `+` in the card's thread tab strip.
 *
 * Three actions, one popover:
 *
 *   Planning:  New thread — restart planning   (spawns with the CURRENT settings prompt)
 *              New blank thread
 *              Adopt an existing thread…
 *
 *   Elsewhere: New thread                      (blank)
 *              Adopt an existing thread…
 *
 * The restart item appears only in Planning. Never in Building: the supervisor
 * owns build threads, and a thread spawned from here would carry the build
 * prompt with no step state, no worktree and no governor slot — a thread that
 * looks like a build and that the supervisor does not know exists. Restarting a
 * build stays a supervisor concern.
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

function MenuRow({
  icon,
  title,
  hint,
  onClick,
}: {
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly hint?: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      className="flex w-full items-start gap-2 rounded px-1.5 py-1.5 text-left hover:bg-accent"
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
 * The popover's contents. Exported and pure so the Planning-only gate — the
 * invariant this module exists to hold — is assertable in rendered markup: the
 * popup itself portals, and a portal renders nothing on the server, so the rows
 * are unreachable through `BoardCardThreadAddMenu`.
 */
export function BoardCardThreadAddMenuBody({
  mode,
  canRestartPlanning,
  adoptableThreads,
  onRestartPlanning,
  onCreateBlankThread,
  onAdoptThread,
  onEnterAdoptMode,
}: {
  readonly mode: "menu" | "adopt";
  readonly canRestartPlanning: boolean;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly onRestartPlanning: () => void;
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
      {canRestartPlanning ? (
        <MenuRow
          hint="Restart planning"
          icon={<RotateCwIcon className="size-3.5" />}
          onClick={onRestartPlanning}
          title="New thread"
        />
      ) : null}
      <MenuRow
        icon={<MessageSquarePlusIcon className="size-3.5" />}
        onClick={onCreateBlankThread}
        title={canRestartPlanning ? "New blank thread" : "New thread"}
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
  canRestartPlanning,
  adoptableThreads,
  onRestartPlanning,
  onCreateBlankThread,
  onAdoptThread,
}: {
  readonly label: string;
  /** True only in Planning, and only while the planning recipe has a step. */
  readonly canRestartPlanning: boolean;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly onRestartPlanning: () => void;
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
          canRestartPlanning={canRestartPlanning}
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
          onRestartPlanning={() => {
            onRestartPlanning();
            close();
          }}
        />
      </PopoverPopup>
    </Popover>
  );
}

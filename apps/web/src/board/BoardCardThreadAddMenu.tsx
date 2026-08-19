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
  const close = () => {
    setOpen(false);
    setMode("menu");
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setMode("menu");
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
        {mode === "adopt" ? (
          <BoardPickerSearchBody
            onPick={(threadId) => {
              onAdoptThread(threadId);
              close();
            }}
            options={adoptableThreads}
            placeholder="Search threads…"
          />
        ) : (
          <div className="flex flex-col gap-0.5">
            {canRestartPlanning ? (
              <MenuRow
                hint="Restart planning"
                icon={<RotateCwIcon className="size-3.5" />}
                onClick={() => {
                  onRestartPlanning();
                  close();
                }}
                title="New thread"
              />
            ) : null}
            <MenuRow
              icon={<MessageSquarePlusIcon className="size-3.5" />}
              onClick={() => {
                onCreateBlankThread();
                close();
              }}
              title={canRestartPlanning ? "New blank thread" : "New thread"}
            />
            <MenuRow
              icon={<SearchIcon className="size-3.5" />}
              onClick={() => setMode("adopt")}
              title="Adopt an existing thread…"
            />
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The `+` in the card's thread tab strip: restart the stage (auto-executing stages
 * only, disabled while a supervised run is in flight), new blank thread, or adopt.
 * Restart is a server command so it runs the same prompt as the automatic trigger.
 */
import { MessageSquarePlusIcon, PlusIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { boardStageLabelMidSentence } from "./boardCardThreadMenu";
import { BoardPickerSearchBody, type BoardPickerOption } from "./BoardSearchAddPicker";

/** The adopt list's server search: told the query as it is typed. */
export interface BoardAdoptSearch {
  readonly onQueryChange: (query: string) => void;
  /** Whether the adopt list is showing, so its card-thread read mounts only then. */
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
  readonly pending: boolean;
}

/**
 * Null when the stage does not auto-execute (the item is absent, not disabled).
 * A non-null `disabledReason` disables the item and explains why.
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
        <span className="text-board-12-5 text-foreground">{title}</span>
        {hint === undefined ? null : (
          <span className="text-board-11-5 text-muted-foreground">{hint}</span>
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
  adoptSearch,
}: {
  readonly mode: "menu" | "adopt";
  readonly stageRestart: BoardThreadStageRestart | null;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly adoptSearch?: BoardAdoptSearch | undefined;
  readonly onRestartStage: () => void;
  readonly onCreateBlankThread: () => void;
  readonly onAdoptThread: (threadId: string) => void;
  readonly onEnterAdoptMode: () => void;
}) {
  if (mode === "adopt") {
    return (
      <BoardPickerSearchBody
        onPick={onAdoptThread}
        onQueryChange={adoptSearch?.onQueryChange}
        options={adoptableThreads}
        pending={adoptSearch?.pending}
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
          title={`New thread: restart ${boardStageLabelMidSentence(stageRestart.label)}`}
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
  adoptSearch,
}: {
  readonly label: string;
  readonly adoptSearch?: BoardAdoptSearch | undefined;
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
  // Reset on open, never on close: clearing on close swaps the contents while
  // the popover is still fading out.
  const [openCount, setOpenCount] = useState(0);
  const close = () => {
    setOpen(false);
    adoptSearch?.onOpenChange?.(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setMode("menu");
          setOpenCount((count) => count + 1);
        } else {
          adoptSearch?.onOpenChange?.(false);
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
          adoptSearch={adoptSearch}
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
          onEnterAdoptMode={() => {
            setMode("adopt");
            adoptSearch?.onOpenChange?.(true);
          }}
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

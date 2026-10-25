/**
 * Shared thread-pane chrome (T3O-17): status glyph, fullscreen / open-in-Threads
 * icon buttons, and the compact identity-row thread trigger that replaces the
 * tab strip on a short maximised sheet. The trigger sits with the pane tabs
 * outside the scrolling chip cluster so it cannot scroll away; its label
 * truncates instead. Exit fullscreen stays pinned on the sheet.
 *
 * Lives next to `BoardCardThreadPane` rather than inside it so the card detail
 * view can host the folded controls without eagerly loading `ChatView`.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  isBoardCardAwaitingPermission,
  type BoardCardThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  MaximizeIcon,
  MessageSquareIcon,
  MinimizeIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { boardCardCompactThreadLabel, boardCardThreadLinkHint } from "./boardCardCompactChrome";
import type { BoardDetailThreadLink } from "./BoardCardDetailView";
import { BoardHint } from "./BoardHint";
import { BoardCardThreadAddMenuBody, type BoardThreadStageRestart } from "./BoardCardThreadAddMenu";
import { BoardPickerSearchBody, type BoardPickerOption } from "./BoardSearchAddPicker";
import { threadWorkerOpensOn, type BoardThreadWorker } from "./workers/threadWorker";

export function BoardCardThreadStatusGlyph({ link }: { readonly link: BoardDetailThreadLink }) {
  if (link.awaitingInput) {
    return (
      <BoardHint label="Awaiting your input">
        <span
          aria-label="Awaiting your input"
          role="img"
          className="size-2 shrink-0 rounded-full bg-attention"
        />
      </BoardHint>
    );
  }
  if (isBoardCardAwaitingPermission(link)) {
    return (
      <BoardHint label="Waiting for permission">
        <span
          aria-label="Waiting for permission"
          role="img"
          className="size-2 shrink-0 rounded-full bg-attention"
        />
      </BoardHint>
    );
  }
  if (link.threadState === "working") {
    return (
      <BoardHint label="Working">
        <span aria-label="Working" role="img" className="size-2 shrink-0 rounded-full bg-info" />
      </BoardHint>
    );
  }
  if (link.threadState === "failed") {
    return (
      <BoardHint label="Failed">
        <span
          aria-label="Failed"
          role="img"
          className="size-2 shrink-0 rounded-full bg-destructive"
        />
      </BoardHint>
    );
  }
  return <MessageSquareIcon className="size-3 shrink-0 opacity-70" />;
}

export function BoardCardThreadExitFullscreenButton({
  maximised,
  onToggle,
}: {
  readonly maximised: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <BoardHint label={maximised ? "Exit fullscreen" : "Fullscreen"}>
      <button
        aria-label={maximised ? "Exit fullscreen" : "Fullscreen"}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-input bg-popover text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
        onClick={onToggle}
        type="button"
      >
        {maximised ? <MinimizeIcon className="size-3" /> : <MaximizeIcon className="size-3" />}
      </button>
    </BoardHint>
  );
}

export function BoardCardThreadOpenInThreadsButton({
  worker,
  threadId,
}: {
  readonly worker: BoardThreadWorker;
  readonly threadId: ThreadId;
}) {
  const label =
    worker.workerId === BOARD_LOCAL_WORKER_ID
      ? "Open in the threads view"
      : threadWorkerOpensOn(worker);
  return (
    <BoardHint label={label}>
      <Link
        aria-label="Open in Threads"
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-input bg-popover text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
        params={{ environmentId: worker.environmentId, threadId }}
        to="/$environmentId/$threadId"
      >
        <SquareArrowOutUpRightIcon className="size-3" />
      </Link>
    </BoardHint>
  );
}

/**
 * The compact dropdown's contents. Exported so static-markup tests can reach
 * the thread list and add-menu rows: the popup portals, and a portal renders
 * nothing on the server.
 */
export function BoardCardThreadCompactMenuBody({
  mode,
  threadLinks,
  selectedThreadId,
  threadTodos,
  stageRestart,
  adoptableThreads,
  onSelectThread,
  onUnlinkThread,
  onRestartStage,
  onCreateBlankThread,
  onAdoptThread,
  onEnterAdoptMode,
}: {
  readonly mode: "menu" | "adopt";
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  readonly selectedThreadId: ThreadId | null;
  readonly threadTodos: ReadonlyMap<ThreadId, BoardCardThreadShell> | undefined;
  readonly stageRestart: BoardThreadStageRestart | null;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly onUnlinkThread: (threadId: ThreadId) => void;
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
  const orderedLinks = threadLinks.toReversed();
  return (
    <div className="flex flex-col gap-0.5">
      {orderedLinks.map((link) => {
        const active = link.threadId === selectedThreadId;
        const todo = threadTodos?.get(link.threadId);
        const total = todo?.todoTotal ?? 0;
        return (
          <span className="flex min-w-0 items-center gap-0.5" key={link.threadId}>
            <BoardHint label={boardCardThreadLinkHint(link)}>
              <button
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-accent",
                  active && "bg-accent/60",
                  link.tombstoned && "line-through",
                )}
                onClick={() => onSelectThread(link.threadId)}
                type="button"
              >
                <BoardCardThreadStatusGlyph link={link} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                  {boardCardCompactThreadLabel(link.role, link.title)}
                </span>
                {link.ranOn === null ? null : (
                  <span className="min-w-0 max-w-[40%] truncate text-[10.5px] text-muted-foreground">
                    {link.ranOn}
                  </span>
                )}
                {total === 0 ? null : (
                  <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                    {todo?.todoDone ?? 0}/{total}
                  </span>
                )}
              </button>
            </BoardHint>
            {active && !link.tombstoned ? (
              <BoardHint label="Unlink thread">
                <button
                  aria-label="Unlink thread"
                  className="inline-flex size-[22px] shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => onUnlinkThread(link.threadId)}
                  type="button"
                >
                  <XIcon className="size-3" />
                </button>
              </BoardHint>
            ) : null}
          </span>
        );
      })}
      {orderedLinks.length > 0 ? <div className="my-1 h-px bg-border" /> : null}
      <BoardCardThreadAddMenuBody
        adoptableThreads={adoptableThreads}
        mode="menu"
        onAdoptThread={onAdoptThread}
        onCreateBlankThread={onCreateBlankThread}
        onEnterAdoptMode={onEnterAdoptMode}
        onRestartStage={onRestartStage}
        stageRestart={stageRestart}
      />
    </div>
  );
}

export function BoardCardThreadCompactControls({
  threadLinks,
  selectedThreadId,
  onSelectThread,
  adoptableThreads,
  stageRestart,
  onLinkThread,
  onRestartStage,
  onCreateBlankThread,
  onUnlinkThread,
  threadTodos,
}: {
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  readonly selectedThreadId: ThreadId | null;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly stageRestart: BoardThreadStageRestart | null;
  readonly onLinkThread: (threadId: ThreadId, role: string) => void;
  readonly onRestartStage: () => void;
  readonly onCreateBlankThread: () => Promise<ThreadId | null>;
  readonly onUnlinkThread: (threadId: ThreadId) => void;
  readonly threadTodos?: ReadonlyMap<ThreadId, BoardCardThreadShell> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"menu" | "adopt">("menu");
  const [openCount, setOpenCount] = useState(0);
  const selected = threadLinks.find((link) => link.threadId === selectedThreadId) ?? null;
  const triggerLabel =
    selected === null ? "Threads" : boardCardCompactThreadLabel(selected.role, selected.title);
  const createBlankThreadAndSelect = () => {
    void onCreateBlankThread().then((threadId) => {
      if (threadId !== null) onSelectThread(threadId);
    });
  };
  const close = () => setOpen(false);
  return (
    <span className="min-w-0 max-w-48 overflow-hidden">
      <Popover
        onOpenChange={(next) => {
          setOpen(next);
          if (next) {
            setMode("menu");
            setOpenCount((count) => count + 1);
          }
        }}
        open={open}
      >
        <PopoverTrigger
          aria-label={selected === null ? "Threads" : `Threads, ${triggerLabel}`}
          className="inline-flex h-[26px] max-w-full min-w-0 items-center gap-1 rounded-lg border border-border bg-card px-2.5 text-[12px] font-medium text-foreground"
        >
          {selected === null ? null : <BoardCardThreadStatusGlyph link={selected} />}
          <span className="min-w-0 truncate">{triggerLabel}</span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-70" />
        </PopoverTrigger>
        <PopoverPopup className="w-72 p-1.5">
          <BoardCardThreadCompactMenuBody
            adoptableThreads={adoptableThreads}
            key={openCount}
            mode={mode}
            onAdoptThread={(id) => {
              onLinkThread(id as ThreadId, "linked");
              close();
            }}
            onCreateBlankThread={() => {
              createBlankThreadAndSelect();
              close();
            }}
            onEnterAdoptMode={() => setMode("adopt")}
            onRestartStage={() => {
              onRestartStage();
              close();
            }}
            onSelectThread={(threadId) => {
              onSelectThread(threadId);
              close();
            }}
            onUnlinkThread={(threadId) => {
              onUnlinkThread(threadId);
              close();
            }}
            selectedThreadId={selectedThreadId}
            stageRestart={stageRestart}
            threadLinks={threadLinks}
            threadTodos={threadTodos}
          />
        </PopoverPopup>
      </Popover>
    </span>
  );
}

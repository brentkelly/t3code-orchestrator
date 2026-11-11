/**
 * The card modal's thread pane: a tab per linked thread, each mounting the app's
 * own `ChatView` with `chrome="embedded"` so a card thread never drifts from a
 * Threads-view thread.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  BOARD_LOCAL_WORKER_ID,
  isBoardCardAwaitingPermission,
  type BoardCardThreadShell,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  ClockIcon,
  MaximizeIcon,
  MessageSquareIcon,
  MinimizeIcon,
  PlayIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import ChatView from "../components/ChatView";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { useThreadShell } from "../state/entities";
import { threadFamilies } from "../state/threads";
import {
  boardCardChatPresence,
  boardCardMissingThreadReason,
  useBoardCardThreadRows,
} from "./boardCardThreadRows";
import {
  BoardCardThreadAddMenu,
  type BoardAdoptSearch,
  type BoardThreadStageRestart,
} from "./BoardCardThreadAddMenu";
import { BoardCardThreadTodosStrip } from "./BoardCardThreadTodosStrip";
import type { BoardPickerOption } from "./BoardSearchAddPicker";
import type { BoardDetailThreadLink } from "./BoardCardDetailView";
import { BoardHint } from "./BoardHint";
import type { BoardQueueInfo } from "./boardQueueInfo";
import { BoardThreadWorkerGate } from "./workers/BoardThreadWorkerGate";
import { threadWorkerOpensOn } from "./workers/threadWorker";

const NO_THREAD_IDS: ReadonlyArray<ThreadId> = [];

/** The live chat for one linked thread. Split out so the thread-detail
    subscription hooks are keyed by the mounted thread and unmount with it. */
function BoardCardChat({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(environmentId, threadId);
  const inShell = useThreadShell(threadRef) !== null;
  // The shell keeps only the newest settled threads; older ones are read on demand (T3O-41).
  const rows = useBoardCardThreadRows(environmentId, inShell ? NO_THREAD_IDS : [threadId]);
  const presence = boardCardChatPresence({ threadId, inShell, rows });

  if (presence === "gone") {
    return <BoardCardMissingChat environmentId={environmentId} threadId={threadId} />;
  }
  if (presence !== "open") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-[12.5px] text-muted-foreground">
        {presence === "loading" ? "Loading thread…" : "Couldn't load this thread."}
        {presence === "failed" ? (
          <Button
            onClick={() => threadFamilies.refresh(appAtomRegistry, environmentId, threadId)}
            size="xs"
            variant="outline"
          >
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <ChatView
      chrome="embedded"
      environmentId={environmentId}
      routeKind="server"
      threadId={threadId}
    />
  );
}

/** A linked thread the active family read did not return: archived, or truly gone. Mounted only
    then, so the archived snapshot is read only when it can explain the absence. */
function BoardCardMissingChat({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const archived = useArchivedThreadSnapshots([environmentId]);
  const archivedThreads = archived.snapshots.find((entry) => entry.environmentId === environmentId)
    ?.snapshot.threads;
  const reason = boardCardMissingThreadReason({
    threadId,
    archivedThreadIds: archivedThreads?.map((thread) => thread.id) ?? null,
    // An initial read is not yet waiting, so no snapshot and no error still means loading.
    archivedLoading:
      archived.isLoading || (archivedThreads === undefined && archived.error === null),
  });
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-[12.5px] text-muted-foreground">
      {reason === "checking"
        ? "Loading thread…"
        : reason === "archived"
          ? "This thread is archived. Unarchive it to open it here."
          : reason === "unknown"
            ? "Couldn't load this thread."
            : "This thread is no longer on the server."}
      {reason === "unknown" ? (
        <Button onClick={archived.refresh} size="xs" variant="outline">
          Retry
        </Button>
      ) : null}
      {reason === "archived" ? (
        <Button render={<Link to="/settings/archived" />} size="xs" variant="outline">
          Archived threads
        </Button>
      ) : null}
    </div>
  );
}

export function BoardCardThreadPane({
  cardKey,
  threadLinks,
  selectedThreadId,
  onSelectThread,
  adoptableThreads,
  adoptSearch,
  stageRestart,
  onLinkThread,
  onRestartStage,
  onCreateBlankThread,
  onUnlinkThread,
  maximised,
  onToggleMaximised,
  threadTodos,
  queueInfo,
  queueForceStartPending,
  onQueueForceStart,
  footer = null,
}: {
  readonly cardKey: string;
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  readonly selectedThreadId: ThreadId | null;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly adoptSearch?: BoardAdoptSearch | undefined;
  /** Present only when the card's current stage auto-executes; `null` hides the
      restart item. A non-null `disabledReason` disables it (a run is in flight). */
  readonly stageRestart: BoardThreadStageRestart | null;
  readonly onLinkThread: (threadId: ThreadId, role: string) => void;
  readonly onRestartStage: () => void;
  /** Creates a blank server thread, links it, and returns its id so the pane
      can select it (opening its composer); `null` on a dispatch failure. */
  readonly onCreateBlankThread: () => Promise<ThreadId | null>;
  readonly onUnlinkThread: (threadId: ThreadId) => void;
  readonly maximised: boolean;
  readonly onToggleMaximised: () => void;
  /** Each live-linked thread's cached todo list (t3o-18, D3/D5). The modal
      always shows what is STORED — unlike the card strip, which hides a finished
      list on a stopped thread — so a thread that succeeded still reads `5/5`
      here. */
  readonly threadTodos?: ReadonlyMap<ThreadId, BoardCardThreadShell> | undefined;
  /** The card's place in the build queue (t3o-33), or null when it is not
      queued. */
  readonly queueInfo?: BoardQueueInfo | null | undefined;
  readonly queueForceStartPending?: boolean | undefined;
  readonly onQueueForceStart?: (() => void) | undefined;
  /** Docked at the end of the thread, e.g. the split gate (T3O-31). */
  readonly footer?: ReactNode;
}) {
  // A new blank thread becomes the card's most-recently-linked live thread, so
  // selecting it opens its ChatView (which focuses the composer on mount, D3).
  const createBlankThreadAndSelect = () => {
    void onCreateBlankThread().then((threadId) => {
      if (threadId !== null) onSelectThread(threadId);
    });
  };
  const selected = threadLinks.find((link) => link.threadId === selectedThreadId) ?? null;

  // The tab strip reads newest-first: the latest thread sits next to the `+`
  // control on the left, older threads trail off to the right. `threadLinks`
  // arrives oldest-first (link order), so the strip iterates a reversed copy.
  const orderedLinks = [...threadLinks].reverse();

  // Rather than a fat native scrollbar, older threads hide off the right edge
  // and a chevron scrolls them into view. `canScrollRight` tracks whether any
  // remain hidden so the chevron only appears when it does something.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);
  // What the tabs' widths depend on, so a board push that changes neither skips the re-measure.
  const tabStripKey = threadLinks.map((link) => `${link.threadId}:${link.title ?? ""}`).join("\n");
  const syncScrollAffordance = () => {
    const el = stripRef.current;
    if (el === null) return;
    setCanScrollRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the tab strip's size to show the scroll chevron only while tabs are hidden
  useEffect(() => {
    const el = stripRef.current;
    if (el === null) return undefined;
    syncScrollAffordance();
    return observeResize(el, syncScrollAffordance);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new or renamed tab widens the strip's content without resizing the strip, so it re-measures.
  }, [syncScrollAffordance, tabStripKey]);
  const scrollOlderIntoView = () => {
    stripRef.current?.scrollBy({ left: stripRef.current.clientWidth * 0.7, behavior: "smooth" });
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-2.5 pr-3">
        <BoardCardThreadAddMenu
          adoptSearch={adoptSearch}
          adoptableThreads={adoptableThreads}
          label=""
          onAdoptThread={(id) => onLinkThread(id as ThreadId, "linked")}
          onCreateBlankThread={createBlankThreadAndSelect}
          onRestartStage={onRestartStage}
          stageRestart={stageRestart}
        />
        <div
          className="flex min-w-0 items-center gap-0.5 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onScroll={syncScrollAffordance}
          ref={stripRef}
        >
          {orderedLinks.map((link) => {
            const active = link.threadId === selectedThreadId;
            return (
              // A group, not one button: select and unlink are sibling buttons so
              // the unlink control is valid HTML and keyboard-reachable.
              <span
                className={cn(
                  // The tab strip scrolls, so its overflow clips anything drawn
                  // outside a pill's border box — an outer ring shadow loses its
                  // top and bottom edges. The border has to be a real border.
                  "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12px]",
                  active
                    ? "border-border bg-card font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                  link.tombstoned && "line-through",
                )}
                key={link.threadId}
              >
                <BoardHint
                  label={
                    link.tombstoned
                      ? "Deleted thread"
                      : link.ranOn === null
                        ? link.role
                        : `${link.role} · ${link.ranOn}`
                  }
                >
                  <button
                    className="inline-flex min-w-0 items-center gap-1.5 rounded focus-visible:outline-2 focus-visible:outline-ring"
                    onClick={() => onSelectThread(link.threadId)}
                    type="button"
                  >
                    {link.awaitingInput ? (
                      <BoardHint label="Awaiting your input">
                        <span
                          aria-label="Awaiting your input"
                          role="img"
                          className="size-2 shrink-0 rounded-full bg-attention"
                        />
                      </BoardHint>
                    ) : isBoardCardAwaitingPermission(link) ? (
                      // Blocked on a permission prompt (T3O-16): as answerable
                      // as a question, so the same violet, not the idle glyph.
                      <BoardHint label="Waiting for permission">
                        <span
                          aria-label="Waiting for permission"
                          role="img"
                          className="size-2 shrink-0 rounded-full bg-attention"
                        />
                      </BoardHint>
                    ) : link.threadState === "working" ? (
                      <BoardHint label="Working">
                        <span
                          aria-label="Working"
                          role="img"
                          className="size-2 shrink-0 rounded-full bg-info"
                        />
                      </BoardHint>
                    ) : link.threadState === "failed" ? (
                      // A dead provider session must not read as idle: red, the failure
                      // colour, not a work-state colour.
                      <BoardHint label="Failed">
                        <span
                          aria-label="Failed"
                          role="img"
                          className="size-2 shrink-0 rounded-full bg-destructive"
                        />
                      </BoardHint>
                    ) : (
                      <MessageSquareIcon className="size-3 shrink-0 opacity-70" />
                    )}
                    <span className="max-w-40 truncate whitespace-nowrap">
                      {link.title ?? "Deleted thread"}
                    </span>
                    {(() => {
                      // Per-tab todo counts (t3o-18): the point of tabs is choosing
                      // between threads, and "3/9" answers that better than a title.
                      const todo = threadTodos?.get(link.threadId);
                      const total = todo?.todoTotal ?? 0;
                      return total === 0 ? null : (
                        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
                          {todo?.todoDone ?? 0}/{total}
                        </span>
                      );
                    })()}
                  </button>
                </BoardHint>
                {active && !link.tombstoned ? (
                  <BoardHint label="Unlink thread">
                    <button
                      aria-label="Unlink thread"
                      className="-mr-1 inline-flex size-[15px] shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={(event) => {
                        event.stopPropagation();
                        onUnlinkThread(link.threadId);
                      }}
                      type="button"
                    >
                      <XIcon className="size-2.5" />
                    </button>
                  </BoardHint>
                ) : null}
              </span>
            );
          })}
        </div>
        {canScrollRight ? (
          <BoardHint label="Show older threads">
            <button
              aria-label="Show older threads"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={scrollOlderIntoView}
              type="button"
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          </BoardHint>
        ) : null}
        <span className="flex-1" />
        <BoardHint label={maximised ? "Exit fullscreen" : "Fullscreen"}>
          <button
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-input bg-popover text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
            onClick={onToggleMaximised}
            type="button"
          >
            {maximised ? <MinimizeIcon className="size-3" /> : <MaximizeIcon className="size-3" />}
          </button>
        </BoardHint>
        {selected !== null && !selected.tombstoned ? (
          <Link
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-input bg-popover text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
            params={{ environmentId: selected.worker.environmentId, threadId: selected.threadId }}
            title={
              selected.worker.workerId === BOARD_LOCAL_WORKER_ID
                ? "Open in the threads view"
                : threadWorkerOpensOn(selected.worker)
            }
            to="/$environmentId/$threadId"
          >
            <SquareArrowOutUpRightIcon className="size-3" />
          </Link>
        ) : null}
      </div>

      {/* Pane-level: a queued card has no build thread yet, so without this the
          planning transcript reads as though the build already ran. */}
      {queueInfo == null ? null : (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">
            <span className="font-semibold text-foreground">{queueInfo.headline}.</span> No agent
            has picked this up yet.
          </p>
          {onQueueForceStart === undefined || queueInfo.waitingForCheckout === true ? null : (
            <BoardHint label="Run this task now, past every agent limit: the board's, its worker's and its provider's.">
              <button
                className={cn(
                  "inline-flex h-[24px] shrink-0 items-center gap-[5px] rounded-[7px] border border-input bg-popover px-2 text-[11.5px] font-medium text-foreground shadow-xs hover:bg-accent",
                  queueForceStartPending === true && "cursor-wait opacity-60",
                )}
                disabled={queueForceStartPending === true}
                onClick={onQueueForceStart}
                type="button"
              >
                <PlayIcon className="size-2.5" />
                {queueForceStartPending === true ? "Starting…" : "Start now"}
              </button>
            </BoardHint>
          )}
        </div>
      )}

      {selected === null || selected.tombstoned ? (
        <div className="flex min-h-0 flex-1 flex-col justify-center p-4">
          <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-border bg-card p-4">
            <div className="text-[13px] font-medium text-foreground">
              {selected?.tombstoned === true
                ? "This thread was deleted"
                : `No thread on ${cardKey} yet`}
            </div>
            <div className="text-[12.5px]/[1.6] text-pretty text-muted-foreground">
              {selected?.tombstoned === true
                ? "The link stays so the card's history reads honestly. Start another thread to keep working."
                : stageRestart !== null
                  ? "Moving a card into this stage starts one by itself. Start another here, or adopt an existing thread. Either way the brief, labels and dependencies travel with the card."
                  : "Start a thread here, or adopt an existing one. The brief, labels and dependencies travel with the card."}
            </div>
            <div className="pt-0.5">
              <BoardCardThreadAddMenu
                adoptSearch={adoptSearch}
                adoptableThreads={adoptableThreads}
                label="Add a thread"
                onAdoptThread={(id) => onLinkThread(id as ThreadId, "linked")}
                onCreateBlankThread={createBlankThreadAndSelect}
                onRestartStage={onRestartStage}
                stageRestart={stageRestart}
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {/* Sticky above the conversation so the selected thread's list stays
              visible while the transcript scrolls. */}
          <BoardCardThreadTodosStrip
            awaitingInput={selected.awaitingInput}
            threadId={selected.threadId}
            todo={threadTodos?.get(selected.threadId)}
          />
          {/* A thread on a worker opens in that worker's environment (T3O-63). */}
          <BoardThreadWorkerGate key={selected.threadId} worker={selected.worker}>
            {(threadEnvironmentId) => (
              <BoardCardChat environmentId={threadEnvironmentId} threadId={selected.threadId} />
            )}
          </BoardThreadWorkerGate>
        </div>
      )}
      {footer == null ? null : (
        <div className="max-h-[60%] shrink-0 overflow-y-auto border-t border-border p-3">
          {footer}
        </div>
      )}
    </section>
  );
}

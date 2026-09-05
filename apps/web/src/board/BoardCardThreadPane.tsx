/**
 * T3o card thread pane (t3o-06). From Planning onward the card modal is a
 * working surface, not a form: the card's thread runs inside it, with a tab
 * per linked thread — the prototype's `T3 Code Kanban v4.dc.html` thread pane.
 *
 * The conversation itself is the app's own `ChatView`, mounted with
 * `chrome="embedded"` (its one T3o seam) so the pane's tab strip is the only
 * header. Nothing about the chat is reimplemented here: same timeline, same
 * composer, same model row, so a card thread and a Threads-view thread can
 * never drift apart.
 *
 * Threads arrive here three ways (t3o-14, superseding adoption-only): the board
 * starts one by itself when a card enters an auto-executing stage (t3o-15), the
 * `+` menu starts one on demand, or you adopt an existing thread. All three end
 * at the same `board.card.link-thread` (D9) — the link is still the only way a
 * thread joins a card.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BoardCardThreadShell, EnvironmentId, ThreadId } from "@t3tools/contracts";
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
import { useCallback, useEffect, useRef, useState } from "react";

import ChatView from "../components/ChatView";
import { cn } from "../lib/utils";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { resolveThreadSyncPhase } from "../threadSync";
import { BoardCardThreadAddMenu, type BoardThreadStageRestart } from "./BoardCardThreadAddMenu";
import { BoardCardThreadTodosStrip } from "./BoardCardThreadTodosStrip";
import type { BoardPickerOption } from "./BoardSearchAddPicker";
import type { BoardDetailThreadLink } from "./BoardCardDetailView";
import { BoardHint } from "./BoardHint";
import type { BoardQueueInfo } from "./boardQueueInfo";

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
  const shell = useThreadShell(threadRef);
  const detail = useThreadDetail(threadRef);
  const status = useThreadStatus(threadRef);
  const threadSyncPhase = resolveThreadSyncPhase({
    detailExists: detail !== null,
    shellExists: shell !== null,
    status,
  });

  if (shell === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-[12.5px] text-muted-foreground">
        This thread is no longer on the server.
      </div>
    );
  }
  return (
    <ChatView
      chrome="embedded"
      environmentId={environmentId}
      reserveTitleBarControlInset={false}
      routeKind="server"
      threadId={threadId}
      threadSyncPhase={threadSyncPhase}
    />
  );
}

export function BoardCardThreadPane({
  environmentId,
  cardKey,
  threadLinks,
  selectedThreadId,
  onSelectThread,
  adoptableThreads,
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
}: {
  readonly environmentId: EnvironmentId;
  readonly cardKey: string;
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  readonly selectedThreadId: ThreadId | null;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
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
  const syncScrollAffordance = useCallback(() => {
    const el = stripRef.current;
    if (el === null) return;
    setCanScrollRight(el.scrollWidth - el.clientWidth - el.scrollLeft > 1);
  }, []);
  useEffect(() => {
    const el = stripRef.current;
    if (el === null) return undefined;
    syncScrollAffordance();
    const observer = new ResizeObserver(syncScrollAffordance);
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [syncScrollAffordance, threadLinks]);
  const scrollOlderIntoView = () => {
    stripRef.current?.scrollBy({ left: stripRef.current.clientWidth * 0.7, behavior: "smooth" });
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-2.5 pr-3">
        <BoardCardThreadAddMenu
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
              // The pill is a GROUP, not one button: nesting the unlink control
              // inside the select button would be invalid HTML and made it
              // keyboard-unreachable (it was a presentation-role span). The
              // wrapper draws the pill; select and unlink are real sibling
              // buttons, each focusable in its own right.
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
                <BoardHint label={link.tombstoned ? "Deleted thread" : link.role}>
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
                    ) : link.threadState === "working" ? (
                      <BoardHint label="Working">
                        <span
                          aria-label="Working"
                          role="img"
                          className="size-2 shrink-0 rounded-full bg-info"
                        />
                      </BoardHint>
                    ) : link.threadState === "failed" ? (
                      // A dead provider session (t3o-10) reads as idle if it
                      // falls through to the generic glyph, which is the lie
                      // this card set out to remove. Red, the colour the thread
                      // list and the activity rail already give a failure — not
                      // a work-state colour, because no work is happening.
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
            params={{ environmentId, threadId: selected.threadId }}
            title="Open in the threads view"
            to="/$environmentId/$threadId"
          >
            <SquareArrowOutUpRightIcon className="size-3" />
          </Link>
        ) : null}
      </div>

      {/* Queued for a build slot (t3o-33). PANE-LEVEL, above whichever thread is
          selected, because a queued card has no build thread to put it in — the
          governor spawns nothing until it admits the step, so the pane is
          showing the planning conversation the card arrived with. Without this
          the transcript reads as though the build already ran and stopped. */}
      {queueInfo == null ? null : (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
          <ClockIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">
            <span className="font-semibold text-foreground">{queueInfo.headline}.</span> No agent
            has picked this up yet.
          </p>
          {onQueueForceStart === undefined ? null : (
            <BoardHint label="Run this task now, over the agent limit.">
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
                  ? "Moving a card into this stage starts one by itself. Start another here, or adopt an existing thread — either way the brief, labels and dependencies travel with the card."
                  : "Start a thread here, or adopt an existing one — the brief, labels and dependencies travel with the card."}
            </div>
            <div className="pt-0.5">
              <BoardCardThreadAddMenu
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
          <BoardCardChat
            environmentId={environmentId}
            key={selected.threadId}
            threadId={selected.threadId}
          />
        </div>
      )}
    </section>
  );
}

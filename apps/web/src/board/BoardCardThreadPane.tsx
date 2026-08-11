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
 * Threads arrive here by ADOPTION only (D9, and the single entry point for
 * it). The board spawning its own threads is t3o-10/t3o-12's — until then the
 * empty state says so rather than offering a composer that would silently
 * create one.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  MaximizeIcon,
  MessageSquareIcon,
  MinimizeIcon,
  SquareArrowOutUpRightIcon,
  XIcon,
} from "lucide-react";

import ChatView from "../components/ChatView";
import { cn } from "../lib/utils";
import { useThreadDetail, useThreadShell, useThreadStatus } from "../state/entities";
import { resolveThreadSyncPhase } from "../threadSync";
import { BoardSearchAddPicker, type BoardPickerOption } from "./BoardSearchAddPicker";
import type { BoardDetailThreadLink } from "./BoardCardDetailView";

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
  onLinkThread,
  onUnlinkThread,
  maximised,
  onToggleMaximised,
}: {
  readonly environmentId: EnvironmentId;
  readonly cardKey: string;
  readonly threadLinks: ReadonlyArray<BoardDetailThreadLink>;
  readonly selectedThreadId: ThreadId | null;
  readonly onSelectThread: (threadId: ThreadId) => void;
  readonly adoptableThreads: ReadonlyArray<BoardPickerOption>;
  readonly onLinkThread: (threadId: ThreadId, role: string) => void;
  readonly onUnlinkThread: (threadId: ThreadId) => void;
  readonly maximised: boolean;
  readonly onToggleMaximised: () => void;
}) {
  const selected = threadLinks.find((link) => link.threadId === selectedThreadId) ?? null;

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-2.5 pr-3">
        <div className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
          {threadLinks.map((link) => {
            const active = link.threadId === selectedThreadId;
            return (
              <button
                className={cn(
                  "inline-flex h-[26px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12px]",
                  active
                    ? "bg-card font-medium text-foreground shadow-[0_0_0_1px_var(--border)]"
                    : "text-muted-foreground hover:text-foreground",
                  link.tombstoned && "line-through",
                )}
                key={link.threadId}
                onClick={() => onSelectThread(link.threadId)}
                title={link.tombstoned ? "Deleted thread" : link.role}
                type="button"
              >
                {link.awaitingInput ? (
                  <span
                    className="size-2 shrink-0 rounded-full bg-info"
                    title="Awaiting your input"
                  />
                ) : link.threadState === "working" ? (
                  <span className="size-2 shrink-0 rounded-full bg-emerald-500" title="Working" />
                ) : (
                  <MessageSquareIcon className="size-3 shrink-0 opacity-70" />
                )}
                <span className="max-w-40 truncate whitespace-nowrap">
                  {link.title ?? "Deleted thread"}
                </span>
                {active && !link.tombstoned ? (
                  <span
                    className="-mr-1 inline-flex size-[15px] shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={(event) => {
                      event.stopPropagation();
                      onUnlinkThread(link.threadId);
                    }}
                    role="presentation"
                    title="Unlink thread"
                  >
                    <XIcon className="size-2.5" />
                  </span>
                ) : null}
              </button>
            );
          })}
          {/* Adoption is the only way a thread joins a card (D9). */}
          <BoardSearchAddPicker
            label=""
            onPick={(id) => onLinkThread(id as ThreadId, "linked")}
            options={adoptableThreads}
            placeholder="Search threads…"
          />
        </div>
        <span className="flex-1" />
        <button
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-[7px] border border-input bg-popover text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
          onClick={onToggleMaximised}
          title={maximised ? "Exit fullscreen" : "Fullscreen"}
          type="button"
        >
          {maximised ? <MinimizeIcon className="size-3" /> : <MaximizeIcon className="size-3" />}
        </button>
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
                ? "The link stays so the card's history reads honestly. Adopt another thread to keep working."
                : "Adopt an existing thread and it runs here — the brief and dependencies travel with the card. Threads the board starts for itself arrive with the supervisor (t3o-10)."}
            </div>
            <div className="pt-0.5">
              <BoardSearchAddPicker
                label="Adopt a thread"
                onPick={(id) => onLinkThread(id as ThreadId, "linked")}
                options={adoptableThreads}
                placeholder="Search threads…"
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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

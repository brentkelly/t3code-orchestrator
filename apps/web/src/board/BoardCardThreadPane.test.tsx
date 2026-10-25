/**
 * Card thread pane chrome (T3O-17): the tab strip hides while compact, and
 * the queue / todos / empty states stay.
 */
import { EMPTY_BOARD_WORKERS_STATE, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { BoardDetailThreadLink } from "./BoardCardDetailView";
import { boardThreadWorker } from "./workers/threadWorker";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { readonly children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("../components/ChatView", () => ({
  default: () => <div>embedded-chat</div>,
}));

vi.mock("../state/entities", () => ({
  useThreadShell: () => ({ id: "thread-1" }),
}));

vi.mock("./workers/BoardThreadWorkerGate", () => ({
  BoardThreadWorkerGate: ({
    worker,
    children,
  }: {
    readonly worker: { readonly environmentId: string };
    readonly children: (environmentId: string) => React.ReactNode;
  }) => children(worker.environmentId),
}));

const { BoardCardThreadPane } = await import("./BoardCardThreadPane");

const noop = () => {};
const worker = boardThreadWorker({
  workerId: undefined,
  workers: EMPTY_BOARD_WORKERS_STATE,
  boardEnvironmentId: "env-1" as never,
});

const live: BoardDetailThreadLink = {
  threadId: ThreadId.make("thread-1"),
  role: "planning",
  tombstoned: false,
  title: "T3-7 · Planning",
  threadState: "stopped",
  awaitingInput: false,
  worker,
  ranOn: null,
};

const paneProps = {
  cardKey: "T3-7",
  threadLinks: [live],
  selectedThreadId: live.threadId,
  onSelectThread: noop,
  adoptableThreads: [] as const,
  stageRestart: null,
  onLinkThread: noop,
  onRestartStage: noop,
  onCreateBlankThread: () => Promise.resolve(null),
  onUnlinkThread: noop,
  maximised: true,
  onToggleMaximised: noop,
};

describe("BoardCardThreadPane compact chrome", () => {
  it("renders the tab strip with fullscreen and open-in-Threads while chrome is expanded", () => {
    const html = renderToStaticMarkup(<BoardCardThreadPane {...paneProps} maximised={false} />);
    expect(html).toContain('aria-label="Add a thread"');
    expect(html).toContain("T3-7 · Planning");
    expect(html).toContain('aria-label="Fullscreen"');
    expect(html).toContain('aria-label="Open in Threads"');
    expect(html).toContain("embedded-chat");
  });

  it("hides the tab strip while compact, and keeps the conversation", () => {
    const html = renderToStaticMarkup(
      <BoardCardThreadPane {...paneProps} compactChrome maximised />,
    );
    expect(html).not.toContain('aria-label="Add a thread"');
    expect(html).not.toContain('aria-label="Fullscreen"');
    expect(html).not.toContain('aria-label="Exit fullscreen"');
    expect(html).not.toContain('aria-label="Open in Threads"');
    expect(html).toContain("embedded-chat");
  });

  it("keeps the empty-state add control and the queue strip while compact", () => {
    const html = renderToStaticMarkup(
      <BoardCardThreadPane
        {...paneProps}
        compactChrome
        queueInfo={{
          position: 2,
          total: 3,
          ahead: 1,
          running: 3,
          cap: 3,
          startsNext: false,
          label: "Queued #2",
          headline: "Queued behind 1 card",
          detail: "Waiting for a slot",
        }}
        selectedThreadId={null}
        threadLinks={[]}
      />,
    );
    expect(html).toContain("No thread on T3-7 yet");
    expect(html).toContain("Add a thread");
    expect(html).toContain("Queued behind 1 card");
    expect(html).not.toContain('aria-label="Exit fullscreen"');
  });

  it("keeps the todos strip above the chat while compact", () => {
    const html = renderToStaticMarkup(
      <BoardCardThreadPane
        {...paneProps}
        compactChrome
        threadTodos={
          new Map([
            [
              live.threadId,
              {
                cardId: "card-1" as never,
                threadId: live.threadId,
                todoDone: 1,
                todoTotal: 3,
                todoStatuses: "ipp",
              },
            ],
          ])
        }
      />,
    );
    expect(html).toContain("1/3");
    expect(html).toContain("embedded-chat");
  });
});

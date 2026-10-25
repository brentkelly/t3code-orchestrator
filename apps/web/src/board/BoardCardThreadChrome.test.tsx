/**
 * Compact thread dropdown body (T3O-17). The popup portals, so these tests
 * render the exported body the way `BoardCardThreadAddMenuBody` is tested.
 */
import { EMPTY_BOARD_WORKERS_STATE, ThreadId, type BoardCardThreadShell } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import type { BoardDetailThreadLink } from "./BoardCardDetailView";
import {
  BoardCardThreadCompactControls,
  BoardCardThreadCompactMenuBody,
} from "./BoardCardThreadChrome";
import { boardThreadWorker } from "./workers/threadWorker";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { readonly children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

const noop = () => {};
const worker = boardThreadWorker({
  workerId: undefined,
  workers: EMPTY_BOARD_WORKERS_STATE,
  boardEnvironmentId: "env-1" as never,
});

function link(
  overrides: Partial<BoardDetailThreadLink> & Pick<BoardDetailThreadLink, "threadId" | "role">,
): BoardDetailThreadLink {
  return {
    tombstoned: false,
    title: null,
    threadState: "stopped",
    awaitingInput: false,
    worker,
    ranOn: null,
    ...overrides,
  };
}

const planning = link({
  threadId: ThreadId.make("thread-1"),
  role: "planning",
  title: "T3-7 · Planning",
});
const building = link({
  threadId: ThreadId.make("thread-2"),
  role: "building",
  title: "T3-7 · Building",
  threadState: "working",
});

describe("BoardCardThreadCompactMenuBody", () => {
  it("lists linked threads newest-first with the active one unlinkable, and the add-menu actions", () => {
    const todos = new Map<typeof planning.threadId, BoardCardThreadShell>([
      [
        planning.threadId,
        {
          cardId: "card-1" as never,
          threadId: planning.threadId,
          todoDone: 2,
          todoTotal: 5,
        },
      ],
    ]);
    const html = renderToStaticMarkup(
      <BoardCardThreadCompactMenuBody
        adoptableThreads={[{ id: "thread-other", key: "", title: "An existing thread" }]}
        mode="menu"
        onAdoptThread={noop}
        onCreateBlankThread={noop}
        onEnterAdoptMode={noop}
        onRestartStage={noop}
        onSelectThread={noop}
        onUnlinkThread={noop}
        selectedThreadId={planning.threadId}
        stageRestart={{ label: "Planning", disabledReason: null }}
        threadLinks={[planning, building]}
        threadTodos={todos}
      />,
    );
    expect(html.indexOf("building · T3-7 · Building")).toBeLessThan(
      html.indexOf("planning · T3-7 · Planning"),
    );
    expect(html).toContain("2/5");
    expect(html).toContain('aria-label="Unlink thread"');
    expect(html).toContain("New thread — restart planning");
    expect(html).toContain("New blank thread");
    expect(html).toContain("Adopt an existing thread");
    expect(html).toContain('aria-label="Working"');
  });

  it("does not offer unlink on a tombstoned or inactive row", () => {
    const html = renderToStaticMarkup(
      <BoardCardThreadCompactMenuBody
        adoptableThreads={[]}
        mode="menu"
        onAdoptThread={noop}
        onCreateBlankThread={noop}
        onEnterAdoptMode={noop}
        onRestartStage={noop}
        onSelectThread={noop}
        onUnlinkThread={noop}
        selectedThreadId={planning.threadId}
        stageRestart={null}
        threadLinks={[
          planning,
          link({ threadId: ThreadId.make("gone"), role: "linked", tombstoned: true }),
        ]}
        threadTodos={undefined}
      />,
    );
    expect(html.match(/aria-label="Unlink thread"/g)?.length).toBe(1);
    expect(html).toContain("line-through");
    expect(html).toContain("New thread");
    expect(html).not.toContain("restart");
  });

  it("swaps to the adopt search", () => {
    const html = renderToStaticMarkup(
      <BoardCardThreadCompactMenuBody
        adoptableThreads={[{ id: "thread-other", key: "", title: "An existing thread" }]}
        mode="adopt"
        onAdoptThread={noop}
        onCreateBlankThread={noop}
        onEnterAdoptMode={noop}
        onRestartStage={noop}
        onSelectThread={noop}
        onUnlinkThread={noop}
        selectedThreadId={null}
        stageRestart={null}
        threadLinks={[planning]}
        threadTodos={undefined}
      />,
    );
    expect(html).toContain("An existing thread");
    expect(html).not.toContain("planning · T3-7 · Planning");
  });

  it("keeps the worker hint on a compact row that ran on another worker", () => {
    const remote = link({
      threadId: ThreadId.make("thread-remote"),
      role: "building",
      title: "T3-7 · Building",
      ranOn: "ran on linux-box",
    });
    const html = renderToStaticMarkup(
      <BoardCardThreadCompactMenuBody
        adoptableThreads={[]}
        mode="menu"
        onAdoptThread={noop}
        onCreateBlankThread={noop}
        onEnterAdoptMode={noop}
        onRestartStage={noop}
        onSelectThread={noop}
        onUnlinkThread={noop}
        selectedThreadId={planning.threadId}
        stageRestart={null}
        threadLinks={[planning, remote]}
        threadTodos={undefined}
      />,
    );
    expect(html).toContain("building · T3-7 · Building");
    expect(html).toContain("ran on linux-box");
  });
});

describe("BoardCardThreadCompactControls", () => {
  it("names the trigger with the selected thread", () => {
    const html = renderToStaticMarkup(
      <BoardCardThreadCompactControls
        adoptableThreads={[]}
        onCreateBlankThread={() => Promise.resolve(null)}
        onLinkThread={noop}
        onRestartStage={noop}
        onSelectThread={noop}
        onUnlinkThread={noop}
        selectedThreadId={planning.threadId}
        stageRestart={null}
        threadLinks={[planning]}
      />,
    );
    expect(html).toContain('aria-label="Threads, planning · T3-7 · Planning"');
    expect(html).toContain("planning · T3-7 · Planning");
  });

  it("names the trigger Threads when nothing is selected", () => {
    const html = renderToStaticMarkup(
      <BoardCardThreadCompactControls
        adoptableThreads={[]}
        onCreateBlankThread={() => Promise.resolve(null)}
        onLinkThread={noop}
        onRestartStage={noop}
        onSelectThread={noop}
        onUnlinkThread={noop}
        selectedThreadId={null}
        stageRestart={null}
        threadLinks={[]}
      />,
    );
    expect(html).toContain('aria-label="Threads"');
    expect(html).not.toContain("Threads,");
  });

  it("is only the thread trigger, so Exit fullscreen can stay pinned on the sheet", () => {
    const html = renderToStaticMarkup(
      <BoardCardThreadCompactControls
        adoptableThreads={[]}
        onCreateBlankThread={() => Promise.resolve(null)}
        onLinkThread={noop}
        onRestartStage={noop}
        onSelectThread={noop}
        onUnlinkThread={noop}
        selectedThreadId={planning.threadId}
        stageRestart={null}
        threadLinks={[planning]}
      />,
    );
    expect(html).toContain('aria-label="Threads, planning · T3-7 · Planning"');
    expect(html).not.toContain('aria-label="Exit fullscreen"');
    expect(html).not.toContain('aria-label="Open in Threads"');
  });
});

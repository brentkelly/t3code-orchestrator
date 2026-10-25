/**
 * Compact thread dropdown body (T3O-17). The popup portals, so these tests
 * render the exported body the way `BoardCardThreadAddMenuBody` is tested.
 */
import { EMPTY_BOARD_WORKERS_STATE, ThreadId, type BoardCardThreadShell } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { BoardDetailThreadLink } from "./BoardCardDetailView";
import { BoardCardThreadCompactMenuBody } from "./BoardCardThreadChrome";
import { boardThreadWorker } from "./workers/threadWorker";

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
});

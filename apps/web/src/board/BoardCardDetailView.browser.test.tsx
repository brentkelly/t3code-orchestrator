/**
 * A group card's Thread and Planning pills (T3O-34), clicked: the pill the
 * user picks lights, Planning shows the planning thread, and picking a thread
 * from the Planning pane drops back to Thread.
 */
import { BOARD_SEED_STAGE_IDS, BoardCardId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { baseProps, detail, localWorker, noop, splitShells } from "./boardCardDetailFixtures";

// The real pane mounts a live chat; the pills only need the thread it shows
// and a way to pick another.
vi.mock(import("./BoardCardThreadPane"), () => ({
  BoardCardThreadPane: ((props: {
    readonly selectedThreadId: ThreadId | null;
    readonly threadLinks: ReadonlyArray<{ readonly threadId: ThreadId }>;
    readonly onSelectThread: (threadId: ThreadId) => void;
  }) => (
    <div>
      <p>Showing {props.selectedThreadId}</p>
      {props.threadLinks.map((link) => (
        <button
          key={link.threadId}
          onClick={() => props.onSelectThread(link.threadId)}
          type="button"
        >
          Pick {link.threadId}
        </button>
      ))}
    </div>
  )) as never,
}));

const { BoardCardDetailPanel } = await import("./BoardCardDetailView");

const planningThread = ThreadId.make("thread-planning");
const otherThread = ThreadId.make("thread-other");
const links = [
  [planningThread, "planning"],
  [otherThread, "linked"],
] as const;

const group = {
  chip: "Group · 1 card",
  note: "Its cards are being built.",
  onOpenBoard: undefined,
  settings: null,
  onArchive: noop,
  ownBranch: false,
};

function GroupDialog() {
  const [paneChoice, setPaneChoice] = useState<"thread" | "planning" | null>(null);
  return (
    <BoardCardDetailPanel
      {...baseProps}
      childShells={splitShells(1)}
      detail={{
        ...detail({
          stage: BOARD_SEED_STAGE_IDS.building,
          threadLinks: links.map(([threadId, role], index) => ({
            threadId,
            role,
            linkedAt: `2026-01-01T00:00:0${index}.000Z`,
            tombstonedAt: null,
          })),
        }),
        children: [
          {
            cardId: BoardCardId.make("child-0"),
            key: "T3-10",
            title: "Card 1",
            stage: BOARD_SEED_STAGE_IDS.ready,
            archivedAt: null,
            sourcePlanId: null,
            dependsOn: [],
          },
        ],
      }}
      group={group}
      onSelectPane={(pane) => setPaneChoice(pane as "thread" | "planning")}
      paneChoice={paneChoice}
      projectName="P"
      threadLinks={links.map(([threadId, role]) => ({
        threadId,
        role,
        tombstoned: false,
        title: null,
        threadState: "none" as const,
        awaitingInput: false,
        worker: localWorker,
        ranOn: null,
      }))}
    />
  );
}

describe("a group card's Thread and Planning pills (T3O-34)", () => {
  it("lights the picked pill, and picking a thread from Planning returns to Thread", async () => {
    await using screen = await render(<GroupDialog />);
    const pill = (name: string) => screen.getByRole("button", { name, exact: true });

    await userEvent.click(pill("Planning"));
    await expect.element(pill("Planning")).toHaveClass("bg-card");
    await expect.element(screen.getByText(`Showing ${planningThread}`)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: `Pick ${otherThread}` }));
    await expect.element(pill("Thread")).toHaveClass("bg-card");
    await expect.element(pill("Planning")).not.toHaveClass("bg-card");
    await expect.element(screen.getByText(`Showing ${otherThread}`)).toBeVisible();
  });
});

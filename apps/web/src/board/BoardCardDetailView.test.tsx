/**
 * T3o card detail view (t3o-06). Renders the modal's contents to static markup
 * — no atoms, no live subscription — proving the panel is a pure function of
 * the `board.subscribeCard` detail plus resolved lookups. (The dialog frame
 * around it portals, and a portal renders nothing on the server, so the panel
 * is what these assertions mount.) Covers the archived, no-project-on-disk
 * case (nothing here reads the repo) and the tombstoned thread link (struck
 * through, role preserved, no dead deep-link).
 */
import {
  BoardCardId,
  BoardLabelId,
  ProjectId,
  ThreadId,
  type BoardCard,
  type BoardCardDetail,
  type BoardLabel,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

// The Threads section deep-links with TanStack Router's <Link>, which needs a
// router context; a plain anchor is all the markup assertions need.
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { readonly children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

const { BoardCardDetailPanel } = await import("./BoardCardDetailView");
const { BOARD_STAGE_LABELS } = await import("./boardStages");

const NOW = "2026-01-01T00:00:00.000Z";
const environmentId = "env-1" as never;

function card(overrides?: Partial<BoardCard>): BoardCard {
  return {
    id: BoardCardId.make("card-1"),
    key: "T3-7",
    cardNumber: 7,
    projectId: ProjectId.make("project-gone"),
    labels: [],
    stage: "ready",
    orderKey: "m",
    title: "Wire the widget",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    threadLinks: [],
    externalRef: null,
    recipeSnapshot: null,
    worktree: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function detail(overrides?: Partial<BoardCard>, brief: string | null = null): BoardCardDetail {
  return { card: card(overrides), brief };
}

const noop = () => {};
const baseProps = {
  environmentId,
  catalogue: [] as ReadonlyArray<BoardLabel>,
  labelsById: new Map<BoardLabelId, BoardLabel>(),
  branch: null,
  dependencies: [],
  dependencyOptions: [],
  threadLinks: [],
  adoptableThreads: [],
  feedback: null,
  maximised: false,
  onToggleMaximised: noop,
  onClose: noop,
  onSetLabels: noop,
  onCreateLabel: noop,
  onRecolourLabel: noop,
  onDeleteLabel: noop,
  onUndeleteLabel: noop,
  onSaveBrief: noop,
  onSaveTitle: noop,
  onAddDependency: noop,
  onRemoveDependency: noop,
  onMoveStage: noop,
  onArchiveToggle: noop,
  onLinkThread: noop,
  onUnlinkThread: noop,
} as const;

describe("BoardCardDetailPanel", () => {
  it("renders an archived card whose project is not on disk, with a Restore action", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ archivedAt: NOW })}
        projectName={null}
      />,
    );
    expect(html).toContain("T3-7");
    expect(html).toContain("Wire the widget");
    expect(html).toContain("Project not on disk");
    expect(html).toContain("Archived");
    // Archive — and its reverse, Restore — moved into the header's kebab,
    // which portals: static markup carries the trigger, not the closed menu.
    expect(html).toContain("More actions");
  });

  it("renders dependencies, marking an unresolved id as an unknown card", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        dependencies={[
          {
            cardId: BoardCardId.make("dep-known"),
            key: "T3-2",
            title: "Land the widget",
            stage: "building",
            known: true,
          },
          {
            cardId: BoardCardId.make("dep-gone"),
            key: "dep-gone",
            title: null,
            stage: "backlog",
            known: false,
          },
        ]}
        detail={detail()}
        projectName="Project One"
      />,
    );
    expect(html).toContain("T3-2");
    expect(html).toContain("Building");
    expect(html).toContain("unknown card");
  });

  // Before Planning the card has no thread pane, so its links are a list.
  it("renders a tombstoned thread link struck through with its role preserved", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: "sprint" })}
        projectName="Project One"
        threadLinks={[
          {
            threadId: ThreadId.make("thread-live"),
            role: "planning",
            tombstoned: false,
            title: "Live planning thread",
            threadState: "working",
            awaitingInput: false,
          },
          {
            threadId: ThreadId.make("thread-gone"),
            role: "build",
            tombstoned: true,
            title: null,
            threadState: "none",
            awaitingInput: false,
          },
        ]}
      />,
    );
    // Live link: title, its role, and a working state.
    expect(html).toContain("Live planning thread");
    expect(html).toContain("planning");
    expect(html).toContain("Working");
    // Tombstoned link: struck through, role preserved, marked deleted.
    expect(html).toContain("line-through");
    expect(html).toContain("build");
    expect(html).toContain("deleted");
  });

  it("shows the primary stage action for a live card but not an archived one", () => {
    const live = renderToStaticMarkup(
      <BoardCardDetailPanel {...baseProps} detail={detail({ stage: "ready" })} projectName="P" />,
    );
    expect(live).toContain("Begin build");
    const archived = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: "ready", archivedAt: NOW })}
        projectName="P"
      />,
    );
    expect(archived).not.toContain("Begin build");
  });

  it("renders the brief body when present", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: "sprint" }, "Ship the thing")}
        projectName="P"
      />,
    );
    expect(html).toContain("Ship the thing");
  });

  // The prototype's two forms, at its stage boundary: the card is something
  // you read until Planning, and something you work in from Planning on.
  it("opens onto the thread pane from Planning, and onto the brief before it", () => {
    const sprint = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: "sprint" }, "Ship the thing")}
        projectName="P"
      />,
    );
    expect(sprint).toContain("Ship the thing");
    // No pane switch, because there is only one pane.
    expect(sprint).not.toContain(">Thread</button>");

    const planning = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: "planning" }, "Ship the thing")}
        projectName="P"
      />,
    );
    // The brief is one tab away rather than on screen.
    expect(planning).not.toContain("Ship the thing");
    expect(planning).toContain(">Thread</button>");
    expect(planning).toContain(">Brief</button>");
  });

  it("renders the whole stage ladder with the card's stage marked current", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel {...baseProps} detail={detail({ stage: "review" })} projectName="P" />,
    );
    for (const label of Object.values(BOARD_STAGE_LABELS)) expect(html).toContain(label);
    // Exactly one rung is the current one.
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("names the unmet dependencies on a blocked card and disables the forward gate", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        dependencies={[
          {
            cardId: BoardCardId.make("dep-done"),
            key: "T3-1",
            title: "Finished work",
            stage: "done",
            known: true,
          },
          {
            cardId: BoardCardId.make("dep-open"),
            key: "T3-2",
            title: "Outstanding work",
            stage: "building",
            known: true,
          },
        ]}
        detail={detail({ stage: "ready", blocked: true })}
        projectName="P"
      />,
    );
    // The met dependency is not part of the reason.
    expect(html).toContain("Blocked by T3-2");
    expect(html).not.toContain("Blocked by T3-1");
    expect(html).toContain("disabled");
  });
});

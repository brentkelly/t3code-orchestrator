/**
 * T3o card detail pane view (t3o-06). Renders to static markup — no atoms, no
 * live subscription — proving the pane is a pure function of the
 * `board.subscribeCard` detail plus resolved lookups. Covers the archived,
 * no-project-on-disk case (nothing here reads the repo) and the tombstoned
 * thread link (struck through, role preserved, no dead deep-link).
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

const { BoardCardDetailView } = await import("./BoardCardDetailView");

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
  accentName: null,
  dependencies: [],
  dependencyOptions: [],
  threadLinks: [],
  adoptableThreads: [],
  feedback: null,
  onClose: noop,
  onSetLabels: noop,
  onCreateLabel: noop,
  onRecolourLabel: noop,
  onDeleteLabel: noop,
  onUndeleteLabel: noop,
  onSaveBrief: noop,
  onAddDependency: noop,
  onRemoveDependency: noop,
  onMoveStage: noop,
  onArchiveToggle: noop,
  onLinkThread: noop,
  onUnlinkThread: noop,
} as const;

describe("BoardCardDetailView", () => {
  it("renders an archived card whose project is not on disk, with a Restore action", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailView
        {...baseProps}
        detail={detail({ archivedAt: NOW })}
        projectName={null}
      />,
    );
    expect(html).toContain("T3-7");
    expect(html).toContain("Wire the widget");
    expect(html).toContain("Project not on disk");
    expect(html).toContain("Archived");
    expect(html).toContain("Restore");
  });

  it("renders dependencies, marking an unresolved id as an unknown card", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailView
        {...baseProps}
        dependencies={[
          { cardId: BoardCardId.make("dep-known"), key: "T3-2", stage: "building", known: true },
          { cardId: BoardCardId.make("dep-gone"), key: "dep-gone", stage: "backlog", known: false },
        ]}
        detail={detail()}
        projectName="Project One"
      />,
    );
    expect(html).toContain("T3-2");
    expect(html).toContain("Building");
    expect(html).toContain("unknown card");
  });

  it("renders a tombstoned thread link struck through with its role preserved", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailView
        {...baseProps}
        detail={detail()}
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
      <BoardCardDetailView {...baseProps} detail={detail({ stage: "ready" })} projectName="P" />,
    );
    expect(live).toContain("Begin build");
    const archived = renderToStaticMarkup(
      <BoardCardDetailView
        {...baseProps}
        detail={detail({ stage: "ready", archivedAt: NOW })}
        projectName="P"
      />,
    );
    expect(archived).not.toContain("Begin build");
  });

  it("renders the brief body when present", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailView {...baseProps} detail={detail({}, "Ship the thing")} projectName="P" />,
    );
    expect(html).toContain("Ship the thing");
  });
});

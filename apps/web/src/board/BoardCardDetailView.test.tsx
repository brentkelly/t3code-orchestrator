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
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardLabelId,
  ProjectId,
  ThreadId,
  boardPlanId,
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

const NOW = "2026-01-01T00:00:00.000Z";
const environmentId = "env-1" as never;

const cardId = BoardCardId.make("card-1");

function card(overrides?: Partial<BoardCard>): BoardCard {
  return {
    id: cardId,
    key: "T3-7",
    cardNumber: 7,
    projectId: ProjectId.make("project-gone"),
    labels: [],
    pullRequest: null,
    stage: BOARD_SEED_STAGE_IDS.ready,
    orderKey: "m",
    title: "Wire the widget",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    threadLinks: [],
    externalRef: null,
    humanInLoop: null,
    worktree: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function detail(
  overrides?: Partial<BoardCard>,
  brief: string | null = null,
  edges?: Partial<
    Pick<BoardCardDetail, "dependencies" | "dependents" | "stepCompletions" | "activity" | "plans">
  >,
): BoardCardDetail {
  const plans = edges?.plans ?? [];
  return {
    card: card(overrides),
    brief,
    hasPlan: plans.length > 0,
    plans,
    dependencies: edges?.dependencies ?? [],
    dependents: edges?.dependents ?? [],
    activity: edges?.activity ?? [],
    stepCompletions: edges?.stepCompletions ?? [],
  };
}

const noop = () => {};
const baseProps = {
  environmentId,
  onMergePullRequest: noop,
  onOpenPullRequest: noop,
  conflictStepRunning: false,
  catalogue: [] as ReadonlyArray<BoardLabel>,
  stages: BOARD_SEED_STAGES,
  humanInLoop: null,
  onSetHumanInLoop: noop,
  labelsById: new Map<BoardLabelId, BoardLabel>(),
  branch: null,
  dependencies: [],
  dependencyOptions: [],
  threadLinks: [],
  adoptableThreads: [],
  stageRestart: null,
  onRestartStage: noop,
  onCreateBlankThread: () => Promise.resolve(null),
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

  // The review loop lives in its own pane now (t3o-16, D9): the header gains a
  // Review pill, and the pane itself (lazy, tested in BoardCardReviewPane
  // tests) renders the rounds. The pill exists for a card ON the review stage
  // and for any card CARRYING review completions — past reviews stay readable
  // after the card moves on.
  it("shows the Review pill on the review stage and on any card with review completions", () => {
    const onReviewStage = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.review })}
        projectName="P"
      />,
    );
    expect(onReviewStage).toContain(">Review</button>");

    const movedOnWithHistory = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.merge }, null, {
          stepCompletions: [
            {
              cardId,
              stepId: "review@1",
              outcome: "succeeded",
              summary: "reviewed",
              payload: JSON.stringify({ reviewedSha: "sha1", findings: [] }),
              threadId: null,
              completedAt: NOW,
            },
          ],
        })}
        projectName="P"
      />,
    );
    expect(movedOnWithHistory).toContain(">Review</button>");

    const neverReviewed = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.building })}
        projectName="P"
      />,
    );
    expect(neverReviewed).not.toContain(">Review</button>");
  });

  it("renders an archived dependency as the card it is, not as an unknown id", () => {
    // The bug (t3o-13): the shell snapshot drops archived cards, so resolving
    // a dependency from it produced "Unknown task" on "unknown card".
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        dependencies={[
          {
            cardId: BoardCardId.make("dep-archived"),
            key: "T3-9",
            title: "Work that was called off",
            stage: BOARD_SEED_STAGE_IDS.building,
            known: true,
            archived: true,
          },
        ]}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.ready })}
        projectName="Project One"
      />,
    );
    expect(html).toContain("T3-9");
    expect(html).toContain("Work that was called off");
    expect(html).toContain("Archived");
    expect(html).not.toContain("Unknown task");
    expect(html).not.toContain("unknown card");
    // An archived dependency no longer gates, so it must not be named as a
    // reason this card is blocked.
    expect(html).not.toContain("Blocked by T3-9");
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
            stage: BOARD_SEED_STAGE_IDS.building,
            known: true,
            archived: false,
          },
          {
            cardId: BoardCardId.make("dep-gone"),
            key: "dep-gone",
            title: null,
            stage: BOARD_SEED_STAGE_IDS.backlog,
            known: false,
            archived: false,
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
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.sprint })}
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
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.ready })}
        projectName="P"
      />,
    );
    expect(live).toContain("Begin build");
    const archived = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.ready, archivedAt: NOW })}
        projectName="P"
      />,
    );
    expect(archived).not.toContain("Begin build");
  });

  it("renders the brief body when present", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.sprint }, "Ship the thing")}
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
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.sprint }, "Ship the thing")}
        projectName="P"
      />,
    );
    expect(sprint).toContain("Ship the thing");
    // No pane switch, because there is only one pane.
    expect(sprint).not.toContain(">Thread</button>");

    const planning = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.planning }, "Ship the thing")}
        projectName="P"
      />,
    );
    // The brief is one tab away rather than on screen.
    expect(planning).not.toContain("Ship the thing");
    expect(planning).toContain(">Thread</button>");
    expect(planning).toContain(">Brief</button>");
  });

  it("shows the Plan pill only once the card has a plan (t3o-08)", () => {
    const withoutPlan = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.planning }, "Ship the thing")}
        projectName="P"
      />,
    );
    expect(withoutPlan).not.toContain(">Plan</button>");

    const withPlan = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.planning }, "Ship the thing", {
          plans: [
            {
              planId: boardPlanId(cardId, "1"),
              cardId,
              title: "Key rotation",
              summary: "Rotate the signing keys",
              dependsOn: [],
              ordinal: 0,
              locked: false,
              createdAt: NOW,
              updatedAt: NOW,
              body: "# Key rotation",
            },
          ] as BoardCardDetail["plans"],
        })}
        projectName="P"
      />,
    );
    expect(withPlan).toContain(">Plan</button>");
  });

  it("renders the whole stage ladder with the card's stage marked current", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.review })}
        projectName="P"
      />,
    );
    for (const stage of BOARD_SEED_STAGES) expect(html).toContain(stage.label);
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
            stage: BOARD_SEED_STAGE_IDS.done,
            known: true,
            archived: false,
          },
          {
            cardId: BoardCardId.make("dep-open"),
            key: "T3-2",
            title: "Outstanding work",
            stage: BOARD_SEED_STAGE_IDS.building,
            known: true,
            archived: false,
          },
        ]}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.ready, blocked: true })}
        projectName="P"
      />,
    );
    // The met dependency is not part of the reason.
    expect(html).toContain("Blocked by T3-2");
    expect(html).not.toContain("Blocked by T3-1");
    expect(html).toContain("disabled");
  });
});

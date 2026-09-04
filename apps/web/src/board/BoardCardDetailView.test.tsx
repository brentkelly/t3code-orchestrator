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
  DEFAULT_SERVER_SETTINGS,
  BoardCardId,
  BoardLabelId,
  BoardStageId,
  ProjectId,
  ThreadId,
  boardPlanId,
  makeBoardCardShell,
  type BoardCard,
  type BoardCardDetail,
  type BoardCardThreadLink,
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

const {
  BoardCardDetailPanel,
  boardCardIsDone,
  initialBoardCardPane,
  initialBoardCardThreadId,
  isBoardCardThreadLocked,
} = await import("./BoardCardDetailView");

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
    pullRequestHistory: [],
    pullRequestFloor: null,
    stage: BOARD_SEED_STAGE_IDS.ready,
    orderKey: "m",
    title: "Wire the widget",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
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
    children: [],
    dependencies: edges?.dependencies ?? [],
    dependents: edges?.dependents ?? [],
    activity: edges?.activity ?? [],
    parentModelOverrides: null,
    stepError: null,
    stepCompletions: edges?.stepCompletions ?? [],
  };
}

/** A parent with `childCount` plans, and one materialised child per plan from
    `archivedFrom` onward marked archived (t3o-29). */
function splitDetail(options: {
  readonly childCount: number;
  readonly archivedFrom?: number;
  readonly stage?: BoardStageId;
}): BoardCardDetail {
  const count = Math.max(options.childCount, 1);
  const plans = Array.from({ length: count }, (_, index) => ({
    planId: boardPlanId(cardId, `p${index}`),
    cardId,
    title: `Plan ${index + 1}`,
    summary: `Summary ${index + 1}`,
    dependsOn: index === 0 ? [] : [boardPlanId(cardId, "p0")],
    ordinal: index,
    locked: false,
    createdAt: NOW,
    updatedAt: NOW,
    body: `# Plan ${index + 1}`,
  })) as BoardCardDetail["plans"];
  const children =
    options.childCount === 0
      ? []
      : (Array.from({ length: options.childCount }, (_, index) => ({
          cardId: BoardCardId.make(`child-${index}`),
          key: `T3-1${index}`,
          title: `Plan ${index + 1}`,
          stage: BOARD_SEED_STAGE_IDS.ready,
          archivedAt:
            options.archivedFrom !== undefined && index >= options.archivedFrom ? NOW : null,
          sourcePlanId: boardPlanId(cardId, `p${index}`),
        })) as BoardCardDetail["children"]);
  return {
    ...detail({ stage: options.stage ?? BOARD_SEED_STAGE_IDS.planning }, null, { plans }),
    children,
  };
}

/** The children's shells, as the unscoped snapshot carries them. */
function splitShells(count: number) {
  return Array.from({ length: count }, (_, index) =>
    makeBoardCardShell({
      cardId: BoardCardId.make(`child-${index}`),
      key: `T3-1${index}`,
      projectId: ProjectId.make("project-gone"),
      labelIds: [],
      stage: BOARD_SEED_STAGE_IDS.ready,
      orderKey: "m",
      title: `Plan ${index + 1}`,
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
  );
}

const noop = () => {};
const baseProps = {
  environmentId,
  onMergePullRequest: noop,
  onOpenPullRequest: noop,
  conflictStepRunning: false,
  stepFailure: null,
  merging: false,
  catalogue: [] as ReadonlyArray<BoardLabel>,
  stages: BOARD_SEED_STAGES,
  humanInLoop: null,
  onSetHumanInLoop: noop,
  labelsById: new Map<BoardLabelId, BoardLabel>(),
  branch: null,
  dependencies: [],
  dependencyOptions: [],
  threadLinks: [],
  attachments: [],
  adoptableThreads: [],
  stageRestart: null,
  onRestartStage: noop,
  onCreateBlankThread: () => Promise.resolve(null),
  feedback: null,
  maximised: false,
  onToggleMaximised: noop,
  paneChoice: null,
  onSelectPane: noop,
  onClose: noop,
  onSetLabels: noop,
  onCreateLabel: noop,
  onRecolourLabel: noop,
  onDeleteLabel: noop,
  onUndeleteLabel: noop,
  onSaveBrief: noop,
  attachmentLimits: { known: false, enabled: false, maxFileBytes: null },
  onAttachFile: () => Promise.resolve(null),
  onDetachFile: noop,
  onSaveTitle: noop,
  onAddDependency: noop,
  onRemoveDependency: noop,
  onMoveStage: noop,
  onArchiveToggle: noop,
  onDelete: noop,
  canApproveSplit: false,
  approveSplitTargetLabel: null,
  onApproveSplit: noop,
  onLinkThread: noop,
  onUnlinkThread: noop,
  boardSettings: DEFAULT_SERVER_SETTINGS.board,
  onSetModelOverrides: noop,
} as const;

/** The pane switch's selected tab — the one tab styled active (`bg-card`) —
    read back out of the static markup by its label. */
function selectedTab(html: string): string | null {
  for (const [, className, label] of html.matchAll(
    /<button class="(inline-flex h-6[^"]*)"[^>]*>(.*?)<\/button>/g,
  )) {
    if (className!.includes("bg-card")) return label!.replace(/<svg.*?<\/svg>/g, "").trim();
  }
  return null;
}

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

  // The review loop lives in its own pane (t3o-16, D9): the header gains a
  // Review pill, and the pane itself (lazy, tested in BoardCardReviewPane
  // tests) renders the rounds. The pill exists at EVERY stage once the board
  // has a review-role stage — a round's model is only settable before the
  // executor freezes it, so the pane must open ahead of the loop — and on any
  // card carrying review completions, so past reviews stay readable.
  it("shows the Review pill at every stage once the board has a review role", () => {
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

    const beforeReview = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.building })}
        projectName="P"
      />,
    );
    expect(beforeReview).toContain(">Review</button>");

    // The narrow pre-Planning sheet carries the same switch.
    const backlog = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.backlog })}
        projectName="P"
      />,
    );
    expect(backlog).toContain(">Review</button>");
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

  it("swaps the Merge button for a disabled 'Merging…' spinner while a merge is in flight", () => {
    const openPr = {
      number: 42,
      url: "https://example.test/pr/42",
      state: "open" as const,
      headBranch: "board/t3-7",
      baseRef: "main",
      checkedAt: NOW,
    };
    const idle = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.merge, pullRequest: openPr })}
        projectName="P"
      />,
    );
    // The button names the pull request it would merge: a card can have had
    // several over its life, and the click is irreversible.
    expect(idle).toContain(">Merge PR #42</button>");
    expect(idle).not.toContain("Merging…");

    const inFlight = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        merging
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.merge, pullRequest: openPr })}
        projectName="P"
      />,
    );
    expect(inFlight).toContain("Merging…");
    // The in-flight button is disabled so the several-second round trip can't be
    // re-entered by a second click.
    expect(inFlight).toMatch(/Merging…<\/button>/);
    expect(inFlight).toContain("disabled");
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
  // you read until Planning, and something you work in from Planning on —
  // though every pane is reachable from the switch at any stage.
  it("opens onto the thread pane from Planning, and onto the brief before it", () => {
    const sprint = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.sprint }, "Ship the thing")}
        projectName="P"
      />,
    );
    expect(sprint).toContain("Ship the thing");
    // The switch is present, resting on the brief.
    expect(sprint).toContain(">Thread</button>");
    expect(selectedTab(sprint)).toBe("Brief");

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

  // A card should not have to reach Planning before a thread can be attached
  // or a review round's model chosen: the pane choice, not the stage, decides
  // which form the sheet takes.
  it("opens the thread or review pane on a pre-Planning card when picked", () => {
    const threadPane = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.sprint }, "Ship the thing")}
        paneChoice="thread"
        projectName="P"
      />,
    );
    // The wide form: the brief has left the screen for the pane on show.
    expect(selectedTab(threadPane)).toBe("Thread");
    expect(threadPane).not.toContain("Ship the thing");

    const reviewPane = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        detail={detail({ stage: BOARD_SEED_STAGE_IDS.backlog }, "Ship the thing")}
        paneChoice="review"
        projectName="P"
      />,
    );
    expect(selectedTab(reviewPane)).toBe("Review");
    expect(reviewPane).not.toContain("Ship the thing");
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

  // t3o-29, D2: the Plans panel replaces the markdown pane once — and only
  // once — children exist. The plan pill then labels its pane by what the
  // pane holds.
  it("labels the plan pill Plan before a split is approved, and by count after", () => {
    const beforeApproval = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        canApproveSplit
        detail={splitDetail({ childCount: 0 })}
        projectName="P"
      />,
    );
    expect(beforeApproval).toContain(">Plan</button>");
    expect(beforeApproval).not.toContain("plans</button>");

    const afterApproval = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        childShells={splitShells(3)}
        detail={splitDetail({ childCount: 3 })}
        projectName="P"
      />,
    );
    expect(afterApproval).toContain(">3 plans</button>");
    expect(afterApproval).not.toContain(">Plan</button>");
  });

  it("counts the rows, not the surviving cards, so an archived child does not renumber the pill", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        // Three plans, three children, one of them archived — the panel still
        // shows three rows (D4), so the pill still says three.
        childShells={splitShells(2)}
        detail={splitDetail({ childCount: 3, archivedFrom: 2 })}
        projectName="P"
      />,
    );
    expect(html).toContain(">3 plans</button>");
  });

  it("opens a split parent on its plans, with the Thread pill disabled", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        childShells={splitShells(3)}
        detail={splitDetail({ childCount: 3, stage: BOARD_SEED_STAGE_IDS.building })}
        projectName="P"
      />,
    );
    expect(selectedTab(html)).toBe("3 plans");
    // The explanation is a BoardHint tooltip (a portal, absent from static
    // markup), so the markup carries the disabled pill wired as its trigger.
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*data-base-ui-tooltip-trigger=""[^>]*>(?:(?!<\/button>).)*Thread<\/button>/,
    );
  });

  it("singularises a one-plan split", () => {
    const html = renderToStaticMarkup(
      <BoardCardDetailPanel
        {...baseProps}
        childShells={splitShells(1)}
        detail={splitDetail({ childCount: 1 })}
        projectName="P"
      />,
    );
    expect(html).toContain(">1 plan</button>");
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
  // The modal opens on the pane the card's stage has made current (planning
  // and build on their thread, everything from Code review on the review
  // pane), so nobody lands on a stale surface and has to click across.
  it("opens the review stages onto the review pane, and the earlier ones onto the thread", () => {
    const reviewCompletion = {
      stepCompletions: [
        {
          cardId,
          stepId: "review@1",
          outcome: "succeeded" as const,
          summary: "reviewed",
          payload: JSON.stringify({ reviewedSha: "sha1", findings: [] }),
          threadId: null,
          completedAt: NOW,
        },
      ],
    };
    const paneFor = (stage: BoardCard["stage"], reviewed: boolean) =>
      selectedTab(
        renderToStaticMarkup(
          <BoardCardDetailPanel
            {...baseProps}
            detail={detail({ stage }, null, reviewed ? reviewCompletion : undefined)}
            projectName="P"
          />,
        ),
      );

    expect(paneFor(BOARD_SEED_STAGE_IDS.planning, false)).toBe("Thread");
    expect(paneFor(BOARD_SEED_STAGE_IDS.ready, false)).toBe("Thread");
    expect(paneFor(BOARD_SEED_STAGE_IDS.building, false)).toBe("Thread");
    expect(paneFor(BOARD_SEED_STAGE_IDS.review, false)).toBe("Review");
    expect(paneFor(BOARD_SEED_STAGE_IDS.merge, true)).toBe("Review");
    expect(paneFor(BOARD_SEED_STAGE_IDS.done, true)).toBe("Review");
    // A card dragged past the loop without ever running it still opens on the
    // review pane — no longer a fallback to the thread: the pane reads "Not
    // started yet" and says plainly that nothing was reviewed.
    expect(paneFor(BOARD_SEED_STAGE_IDS.done, false)).toBe("Review");
  });
});

describe("initialBoardCardPane", () => {
  it("keeps every stage on the thread when the board has no review role", () => {
    const stages = BOARD_SEED_STAGES.filter(
      (stage) => stage.stageId !== BOARD_SEED_STAGE_IDS.review,
    ).map((stage) => ({ ...stage, role: null }));
    expect(initialBoardCardPane(stages, BOARD_SEED_STAGE_IDS.done)).toBe("thread");
  });

  it("opens a pre-Planning card on its brief — the other panes wait to be picked", () => {
    expect(initialBoardCardPane(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.backlog)).toBe("brief");
    expect(initialBoardCardPane(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.sprint)).toBe("brief");
  });

  it("opens a split parent on its plans until review (t3o-28, D4)", () => {
    // A parent's build IS its sub-board, so every stage short of review lands
    // on the plan list rather than a thread that finished during planning.
    for (const stage of [
      BOARD_SEED_STAGE_IDS.planning,
      BOARD_SEED_STAGE_IDS.ready,
      BOARD_SEED_STAGE_IDS.building,
    ]) {
      expect(initialBoardCardPane(BOARD_SEED_STAGES, stage, 3)).toBe("plan");
      expect(isBoardCardThreadLocked(BOARD_SEED_STAGES, stage, 3)).toBe(true);
    }

    // At review the parent's own thread wakes up — the final review runs on
    // the integration branch — so the ordinary rules resume.
    expect(initialBoardCardPane(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.review, 3)).toBe("review");
    expect(isBoardCardThreadLocked(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.review, 3)).toBe(false);

    // A card with no live children is untouched at every stage: a plain card,
    // and a parent whose split has been fully archived away.
    expect(initialBoardCardPane(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.building, 0)).toBe(
      "thread",
    );
    expect(initialBoardCardPane(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.building)).toBe("thread");
  });
});

describe("boardCardIsDone", () => {
  it("follows the done role, not the column's name or position", () => {
    expect(boardCardIsDone(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.done)).toBe(true);
    expect(boardCardIsDone(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.merge)).toBe(false);

    // A renamed done column still wears the wash; a custom column past it,
    // holding no role, wears none however it is labelled.
    const shippedId = BoardStageId.make("stage-shipped");
    const stages = [
      ...BOARD_SEED_STAGES.map((stage) =>
        stage.stageId === BOARD_SEED_STAGE_IDS.done ? { ...stage, label: "Complete" } : stage,
      ),
      {
        stageId: shippedId,
        label: "Shipped",
        role: null,
        orderKey: "r",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    expect(boardCardIsDone(stages, BOARD_SEED_STAGE_IDS.done)).toBe(true);
    expect(boardCardIsDone(stages, shippedId)).toBe(false);
  });
});

describe("initialBoardCardThreadId", () => {
  const link = (
    threadId: string,
    role: string,
    linkedAt: string,
    tombstonedAt: string | null = null,
  ): BoardCardThreadLink => ({
    threadId: ThreadId.make(threadId),
    role,
    linkedAt,
    tombstonedAt,
  });
  // A stage step links its thread under the step id, and a stage step's id IS
  // the stage id — so these roles are what a real planning/build run writes.
  const links = [
    link("thread-plan", BOARD_SEED_STAGE_IDS.planning, "2026-01-01T00:00:00.000Z"),
    link("thread-build", BOARD_SEED_STAGE_IDS.building, "2026-01-01T01:00:00.000Z"),
    link("thread-review", "review@1", "2026-01-01T02:00:00.000Z"),
  ];

  it("opens Planning and Ready on the planning thread and Build on the build one", () => {
    const on = (stage: BoardCard["stage"]) =>
      initialBoardCardThreadId(BOARD_SEED_STAGES, stage, links);
    expect(on(BOARD_SEED_STAGE_IDS.planning)).toBe("thread-plan");
    expect(on(BOARD_SEED_STAGE_IDS.ready)).toBe("thread-plan");
    expect(on(BOARD_SEED_STAGE_IDS.building)).toBe("thread-build");
  });

  it("leaves the review stages on the card's active thread", () => {
    expect(initialBoardCardThreadId(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.review, links)).toBe(
      "thread-review",
    );
  });

  it("skips a tombstoned thread, and opens a newly adopted one", () => {
    const tombstoned = [
      link("thread-plan", BOARD_SEED_STAGE_IDS.planning, "2026-01-01T00:00:00.000Z", NOW),
      link("thread-adopted", "linked", "2026-01-01T03:00:00.000Z"),
    ];
    expect(
      initialBoardCardThreadId(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.ready, tombstoned),
    ).toBe("thread-adopted");
    // An adopted thread belongs to no stage, so it is never the stale one:
    // adopting on a build card opens it, as it did before the stage rule.
    expect(
      initialBoardCardThreadId(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.building, [
        ...links.slice(0, 2),
        link("thread-adopted", "linked", "2026-01-01T05:00:00.000Z"),
      ]),
    ).toBe("thread-adopted");
  });

  it("prefers the newest run of a restarted stage", () => {
    const restarted = [
      ...links.slice(0, 1),
      link("thread-plan-2", BOARD_SEED_STAGE_IDS.planning, "2026-01-01T04:00:00.000Z"),
    ];
    expect(
      initialBoardCardThreadId(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.planning, restarted),
    ).toBe("thread-plan-2");
  });

  it("ignores a later stage's thread, and a past review pass's, after a move back", () => {
    expect(initialBoardCardThreadId(BOARD_SEED_STAGES, BOARD_SEED_STAGE_IDS.planning, links)).toBe(
      "thread-plan",
    );
  });
});

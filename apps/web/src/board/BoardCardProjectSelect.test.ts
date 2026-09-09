/**
 * The two decisions in the `Project ·` row that nothing else catches (T3O-33):
 * WHY the row is pinned, and which projects the menu is allowed to offer.
 *
 * The lock predicate lives in contracts because the decider refuses on it too —
 * a control that disagrees with the rejection is a control that lies — so the
 * cases here are the ones a stage-index-only test would pass and production
 * would fail.
 */
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  DEFAULT_BOARD_SETTINGS,
  ProjectId,
  boardCardProjectLock,
  type BoardCard,
  type BoardCardPullRequest,
  type BoardSettings,
  type BoardState,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCardProjectLockHint, boardCardProjectOptions } from "./BoardCardProjectSelect";

const NOW = "2026-01-01T00:00:00.000Z";
const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const gamma = ProjectId.make("project-gamma");

const stageState: BoardState = {
  cards: [],
  stages: BOARD_SEED_STAGES,
  nextCardNumberByProject: {},
};

type LockCard = Pick<BoardCard, "stage" | "worktree" | "pullRequestHistory" | "parentCardId">;

const lockCard = (overrides: Partial<LockCard> = {}): LockCard => ({
  stage: BOARD_SEED_STAGES[3]!.stageId, // Ready
  worktree: null,
  pullRequestHistory: [],
  parentCardId: null,
  ...overrides,
});

const mergedPr: BoardCardPullRequest = {
  number: 12,
  url: "https://example.test/pr/12",
  state: "merged",
  headBranch: "board/al-2",
  baseRef: "main",
  checkedAt: NOW,
};

describe("boardCardProjectLock", () => {
  it("leaves a card that has never been built editable", () => {
    expect(boardCardProjectLock({ board: stageState, card: lockCard(), childCount: 0 })).toBeNull();
  });

  it("pins a card that has reached the build stage", () => {
    const lock = boardCardProjectLock({
      board: stageState,
      card: lockCard({ stage: BOARD_SEED_STAGES[4]!.stageId }),
      childCount: 0,
    });
    expect(lock?.kind).toBe("built");
  });

  // The two cases a pure stage test gets wrong, in opposite directions.
  it("pins a card dragged back out of Building that still owns a worktree", () => {
    const lock = boardCardProjectLock({
      board: stageState,
      card: lockCard({
        worktree: {
          branch: "board/al-2",
          baseRefName: "main",
          path: "/tmp/worktrees/al-2",
          status: "ready",
          attempts: 1,
          lastError: null,
          reclaimBlockedReason: null,
        },
      }),
      childCount: 0,
    });
    expect(lock?.kind).toBe("built");
  });

  it("pins a card whose branch is gone but whose key is on a merged PR", () => {
    const lock = boardCardProjectLock({
      board: stageState,
      card: lockCard({ pullRequestHistory: [mergedPr] }),
      childCount: 0,
    });
    expect(lock?.kind).toBe("built");
  });

  // Both halves of a sub-board refuse, and each says which half it is: a child
  // inherits its parent's project, a split parent would cascade key reissues
  // across every card on its sub-board.
  it("pins a sub-board child, naming its parent", () => {
    const lock = boardCardProjectLock({
      board: stageState,
      card: lockCard({ parentCardId: BoardCardId.make("parent") }),
      childCount: 0,
    });
    expect(lock).toEqual({ kind: "child", parentCardId: "parent" });
  });

  it("pins a split parent even while it sits before the build stage", () => {
    const lock = boardCardProjectLock({ board: stageState, card: lockCard(), childCount: 3 });
    expect(lock).toEqual({ kind: "parent", childCount: 3 });
  });

  it("gives every reason its own hint", () => {
    const hints = [
      boardCardProjectLockHint({ kind: "built" }),
      boardCardProjectLockHint({ kind: "child", parentCardId: BoardCardId.make("parent") }),
      boardCardProjectLockHint({ kind: "parent", childCount: 2 }),
    ];
    expect(new Set(hints).size).toBe(3);
    expect(hints.every((hint) => hint.startsWith("Pinned"))).toBe(true);
  });
});

const settingsWithProjects = (
  entries: Record<string, { keyPrefix?: string | null; hidden?: boolean }>,
): BoardSettings => ({
  ...DEFAULT_BOARD_SETTINGS,
  projects: Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [
      id,
      {
        keyPrefix: entry.keyPrefix ?? null,
        hidden: entry.hidden ?? false,
        accentColor: null,
      },
    ]),
  ) as BoardSettings["projects"],
});

const project = (id: ProjectId, title: string, workspaceRoot: string | null = `/tmp/${id}`) => ({
  id,
  title,
  workspaceRoot,
});

describe("boardCardProjectOptions", () => {
  it("previews the key the move would reissue, from the target project's highest", () => {
    const options = boardCardProjectOptions({
      projects: [project(alpha, "Alpha"), project(beta, "mesh.web")],
      settings: settingsWithProjects({ [alpha]: { keyPrefix: "AL" }, [beta]: { keyPrefix: "MW" } }),
      currentProjectId: alpha,
      cardKeys: [
        { projectId: alpha, key: "AL-4" },
        { projectId: beta, key: "MW-42" },
        { projectId: beta, key: "MW-7" },
      ],
    });
    expect(options.find((option) => option.id === beta)?.nextKey).toBe("MW-43");
  });

  it("starts an empty project at 1", () => {
    const options = boardCardProjectOptions({
      projects: [project(alpha, "Alpha"), project(beta, "Beta")],
      settings: settingsWithProjects({ [alpha]: { keyPrefix: "AL" }, [beta]: { keyPrefix: "BE" } }),
      currentProjectId: alpha,
      cardKeys: [{ projectId: alpha, key: "AL-4" }],
    });
    expect(options.find((option) => option.id === beta)?.nextKey).toBe("BE-1");
  });

  // A project with no stored prefix gets the acronym the create path would
  // derive, so the preview matches the key the move actually mints.
  it("derives a prefix for a project that has never been given one", () => {
    const options = boardCardProjectOptions({
      projects: [project(alpha, "Alpha"), project(beta, "mesh.web")],
      settings: settingsWithProjects({ [alpha]: { keyPrefix: "AL" } }),
      currentProjectId: alpha,
      cardKeys: [],
    });
    expect(options.find((option) => option.id === beta)?.nextKey).toBe("MW-1");
  });

  it("checks the current project and shows it no key", () => {
    const options = boardCardProjectOptions({
      projects: [project(alpha, "Alpha"), project(beta, "Beta")],
      settings: settingsWithProjects({ [alpha]: { keyPrefix: "AL" } }),
      currentProjectId: alpha,
      cardKeys: [],
    });
    const current = options.find((option) => option.id === alpha);
    expect(current?.current).toBe(true);
    expect(current?.nextKey).toBe("");
  });

  // A hidden project would make the card vanish off the board, and a project
  // with no checkout here fails at Building — hours from the choice that
  // caused it. Neither is offered.
  it("excludes hidden projects and projects that are not on this server", () => {
    const options = boardCardProjectOptions({
      projects: [
        project(alpha, "Alpha"),
        project(beta, "Hidden"),
        project(gamma, "Elsewhere", null),
      ],
      settings: settingsWithProjects({
        [alpha]: { keyPrefix: "AL" },
        [beta]: { keyPrefix: "HI", hidden: true },
      }),
      currentProjectId: alpha,
      cardKeys: [],
    });
    expect(options.map((option) => option.id)).toEqual([alpha]);
  });

  // …but the card's own project is always there, so the row can always show
  // you where the card actually is.
  it("keeps the current project even when it is hidden", () => {
    const options = boardCardProjectOptions({
      projects: [project(alpha, "Alpha"), project(beta, "Beta")],
      settings: settingsWithProjects({
        [alpha]: { keyPrefix: "AL", hidden: true },
        [beta]: { keyPrefix: "BE" },
      }),
      currentProjectId: alpha,
      cardKeys: [],
    });
    expect(options.map((option) => option.id)).toEqual([alpha, beta]);
    expect(options.find((option) => option.id === alpha)?.current).toBe(true);
  });

  // A key with no numeric tail is a legacy or hand-written one; it must not
  // poison the preview with NaN.
  it("ignores keys with no numeric tail", () => {
    const options = boardCardProjectOptions({
      projects: [project(alpha, "Alpha"), project(beta, "Beta")],
      settings: settingsWithProjects({ [alpha]: { keyPrefix: "AL" }, [beta]: { keyPrefix: "BE" } }),
      currentProjectId: alpha,
      cardKeys: [
        { projectId: beta, key: "LEGACY" },
        { projectId: beta, key: "BE-3" },
      ],
    });
    expect(options.find((option) => option.id === beta)?.nextKey).toBe("BE-4");
  });
});

/**
 * The Plans panel (t3o-29), rendered to static markup — the same technique
 * `BoardCardDetailView.test.tsx` uses, and for the same reason: the panel is a
 * pure function of derived rows, so its markup is assertable without a DOM or
 * a subscription.
 *
 * The chart is not here: it defaults closed, and its geometry is pinned in
 * `boardPlanRows.test.ts` where the arithmetic lives.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  ProjectId,
  boardPlanId,
  makeBoardCardShell,
  type BoardCardChildRef,
  type BoardCardShell,
  type BoardStageId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardPlansPanel } from "./BoardPlansPanel";
import { deriveBoardPlanRows, type BoardPlanRowPlan } from "./boardPlanRows";

const parentId = BoardCardId.make("parent-1");
const NOW = "2026-01-01T00:00:00.000Z";
const planIdOf = (key: string) => boardPlanId(parentId, key);

function plan(
  key: string,
  ordinal: number,
  dependsOn: ReadonlyArray<string> = [],
): BoardPlanRowPlan {
  return {
    planId: planIdOf(key),
    title: `Plan ${key}`,
    dependsOn: dependsOn.map(planIdOf),
    ordinal,
  };
}

function child(
  key: string,
  cardId: string,
  stage: BoardStageId,
  archivedAt: string | null = null,
): BoardCardChildRef {
  return {
    cardId: BoardCardId.make(cardId),
    key: `T3-${cardId}`,
    title: `Plan ${key}`,
    stage,
    archivedAt,
    sourcePlanId: planIdOf(key),
  };
}

function shell(cardId: string, stage: BoardStageId, overrides?: Partial<BoardCardShell>) {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make(cardId),
      key: `T3-${cardId}`,
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage,
      orderKey: "m",
      title: `Plan ${cardId}`,
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    parentCardId: parentId,
    ...overrides,
  } satisfies BoardCardShell;
}

/** #1 done with a PR, #2 building, #3 waiting on #2, #4 archived. */
function render(options?: {
  readonly branch?: string | null;
  readonly onOpenChild?: ((childCardId: string) => void) | undefined;
  readonly onOpenSubBoard?: (() => void) | undefined;
}) {
  const planRows = deriveBoardPlanRows({
    plans: [plan("a", 0), plan("b", 1, ["a"]), plan("c", 2, ["b"]), plan("d", 3)],
    children: [
      child("a", "c1", BOARD_SEED_STAGE_IDS.done),
      child("b", "c2", BOARD_SEED_STAGE_IDS.building),
      child("c", "c3", BOARD_SEED_STAGE_IDS.ready),
      child("d", "c4", BOARD_SEED_STAGE_IDS.building, NOW),
    ],
    cards: [
      shell("c1", BOARD_SEED_STAGE_IDS.done, { prNumber: 295 }),
      shell("c2", BOARD_SEED_STAGE_IDS.building, { stepRunning: true }),
      shell("c3", BOARD_SEED_STAGE_IDS.ready),
    ],
    stages: BOARD_SEED_STAGES,
  });
  return renderToStaticMarkup(
    <BoardPlansPanel
      integrationBranch={options?.branch === undefined ? "t3o/TT-9-services" : options.branch}
      onOpenChild={options?.onOpenChild}
      onOpenSubBoard={options?.onOpenSubBoard}
      planRows={planRows}
    />,
  );
}

describe("BoardPlansPanel", () => {
  it("heads the panel and offers the chart and the board", () => {
    const html = render({ onOpenSubBoard: () => {} });
    expect(html).toContain("Plans");
    expect(html).toContain("in dependency order");
    expect(html).toContain("Dependency chart");
    expect(html).toContain("Board");
  });

  it("hides the Board button when there is nowhere to drill in", () => {
    expect(render()).not.toContain(">Board<");
  });

  it("numbers every plan and names what each comes after", () => {
    const html = render();
    for (const n of ["#1", "#2", "#3", "#4"]) expect(html).toContain(n);
    expect(html).toContain("no dependencies");
    expect(html).toContain("after #1");
    expect(html).toContain("after #2");
  });

  it("shows a child's PR beside its dependencies", () => {
    expect(render()).toContain("PR #295");
  });

  it("names the blocker and the stage it is in", () => {
    // #3 comes after #2, which is Building.
    expect(render()).toContain("#2 · building");
  });

  it("does not claim a done row is waiting on anything", () => {
    const html = render();
    expect(html).not.toContain("#1 · done");
  });

  it("strikes an archived child's row through and marks it as having no live card", () => {
    const html = render();
    expect(html).toContain("line-through");
    expect(html).toContain("archived");
  });

  it("states the final review without offering a button for it", () => {
    const html = render();
    expect(html).toContain("Final review");
    expect(html).toContain("t3o/TT-9-services");
    expect(html).toContain(
      "1 of 3 plans done. The final review starts on its own when the last one lands.",
    );
    // D5: no action. The reactor owns this transition.
    expect(html).not.toContain("Start final review");
    expect(html).not.toContain("Waiting on plans");
  });

  it("says the branch is pending rather than inventing one", () => {
    const html = render({ branch: null });
    expect(html).toContain("integration branch pending");
  });

  it("has no Back to thread control, since a split parent's thread is locked", () => {
    expect(render()).not.toContain("Back to thread");
  });
});

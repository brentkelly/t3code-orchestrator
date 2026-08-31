/**
 * T3o plan rows and the dependency chart's layout (t3o-29). Pure logic, no
 * DOM: the panel and the sub-board both render from these, so the ordering,
 * the blocker rule, the three post-materialisation row states and the wave
 * layout are all pinned here rather than through markup.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardStageId,
  ProjectId,
  boardPlanId,
  makeBoardCardShell,
  type BoardCardChildRef,
  type BoardCardShell,
  type BoardPlanId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardPlanFinalReview,
  boardPlanGraphLayout,
  deriveBoardPlanRows,
  type BoardPlanRowPlan,
} from "./boardPlanRows";

const parentId = BoardCardId.make("parent-1");
const NOW = "2026-01-01T00:00:00.000Z";

const planIdOf = (key: string): BoardPlanId => boardPlanId(parentId, key);

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

/** The worked example the panel was built against: #1 with no dependencies,
    #2 and #4 after #1, #3 after #2 — two waves wide at its widest. */
const PLANS = [plan("a", 0), plan("b", 1, ["a"]), plan("c", 2, ["b"]), plan("d", 3, ["a"])];

describe("deriveBoardPlanRows", () => {
  it("numbers rows by plan ordinal and names what each one comes after", () => {
    const { rows } = deriveBoardPlanRows({
      plans: [...PLANS].toReversed(),
      children: [
        child("a", "c1", BOARD_SEED_STAGE_IDS.done),
        child("b", "c2", BOARD_SEED_STAGE_IDS.building),
        child("c", "c3", BOARD_SEED_STAGE_IDS.ready),
        child("d", "c4", BOARD_SEED_STAGE_IDS.ready),
      ],
      cards: [
        shell("c1", BOARD_SEED_STAGE_IDS.done),
        shell("c2", BOARD_SEED_STAGE_IDS.building),
        shell("c3", BOARD_SEED_STAGE_IDS.ready),
        shell("c4", BOARD_SEED_STAGE_IDS.ready),
      ],
      stages: BOARD_SEED_STAGES,
    });
    // Reversed on the way in, ordinal order on the way out.
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3, 4]);
    expect(rows.map((row) => row.title)).toEqual(["Plan a", "Plan b", "Plan c", "Plan d"]);
    expect(rows[0]!.dependsOnNumbers).toEqual([]);
    expect(rows[1]!.dependsOnNumbers).toEqual([1]);
    expect(rows[2]!.dependsOnNumbers).toEqual([2]);
    expect(rows[3]!.dependsOnNumbers).toEqual([1]);
  });

  it("blocks a row on its unfinished siblings only, naming each with its stage", () => {
    const { rows, liveTotal, liveDone } = deriveBoardPlanRows({
      plans: PLANS,
      children: [
        child("a", "c1", BOARD_SEED_STAGE_IDS.done),
        child("b", "c2", BOARD_SEED_STAGE_IDS.review),
        child("c", "c3", BOARD_SEED_STAGE_IDS.ready),
        child("d", "c4", BOARD_SEED_STAGE_IDS.ready),
      ],
      cards: [
        shell("c1", BOARD_SEED_STAGE_IDS.done),
        shell("c2", BOARD_SEED_STAGE_IDS.review),
        shell("c3", BOARD_SEED_STAGE_IDS.ready),
        shell("c4", BOARD_SEED_STAGE_IDS.ready),
      ],
      stages: BOARD_SEED_STAGES,
    });
    // #2 comes after #1, which is done — nothing holds it up.
    expect(rows[1]!.blockers).toEqual([]);
    expect(rows[1]!.tone).toBe("active");
    // #3 comes after #2, which is in review.
    expect(rows[2]!.blockers).toEqual([{ n: 2, key: "T3-c2", stageLabel: "code review" }]);
    expect(rows[2]!.tone).toBe("blocked");
    // #4 comes after #1 (done) and has not started.
    expect(rows[3]!.blockers).toEqual([]);
    expect(rows[3]!.tone).toBe("idle");
    expect({ liveTotal, liveDone }).toEqual({ liveTotal: 4, liveDone: 1 });
  });

  it("does not count an archived or deleted sibling as a blocker", () => {
    // t3o-13 D1: an archived dependency no longer gates, and a plan whose card
    // was deleted has nothing left to wait for. Showing either as a blocker
    // would have the panel claim a hold the decider would not enforce.
    const { rows } = deriveBoardPlanRows({
      plans: PLANS,
      children: [
        child("a", "c1", BOARD_SEED_STAGE_IDS.ready, NOW),
        child("b", "c2", BOARD_SEED_STAGE_IDS.ready),
        child("c", "c3", BOARD_SEED_STAGE_IDS.ready),
      ],
      cards: [shell("c2", BOARD_SEED_STAGE_IDS.ready), shell("c3", BOARD_SEED_STAGE_IDS.ready)],
      stages: BOARD_SEED_STAGES,
    });
    // #2 comes after #1, which is archived.
    expect(rows[1]!.blockers).toEqual([]);
    // #4 comes after #1 too, and has no card of its own.
    expect(rows[3]!.state).toBe("missing");
    expect(rows[3]!.blockers).toEqual([]);
  });

  it("keeps a row for an archived child and for a deleted one, and counts neither", () => {
    const { rows, liveTotal, liveDone } = deriveBoardPlanRows({
      plans: PLANS,
      children: [
        child("a", "c1", BOARD_SEED_STAGE_IDS.done),
        child("b", "c2", BOARD_SEED_STAGE_IDS.building, NOW),
        child("c", "c3", BOARD_SEED_STAGE_IDS.ready),
      ],
      cards: [shell("c1", BOARD_SEED_STAGE_IDS.done), shell("c3", BOARD_SEED_STAGE_IDS.ready)],
      stages: BOARD_SEED_STAGES,
    });
    // Four plans, four rows, and the numbering does not shift under the
    // human because two of the cards are gone.
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3, 4]);
    expect(rows[1]!.state).toBe("archived");
    // An archived child leaves the shell snapshot, so there is no live state
    // to show — but its key survives, which is the point of keeping the row.
    expect(rows[1]!.live).toBeNull();
    expect(rows[1]!.key).toBe("T3-c2");
    expect(rows[1]!.stageLabel).toBe("Building");
    expect(rows[1]!.tone).toBe("gone");
    expect(rows[3]!.state).toBe("missing");
    expect(rows[3]!.key).toBeNull();
    expect(rows[3]!.stageLabel).toBeNull();
    // Only live children can land on the integration branch.
    expect({ liveTotal, liveDone }).toEqual({ liveTotal: 2, liveDone: 1 });
  });

  it("reads live per-child state off the shell, not the child ref", () => {
    const { rows } = deriveBoardPlanRows({
      plans: [plan("a", 0), plan("b", 1), plan("c", 2), plan("d", 3)],
      children: [
        child("a", "c1", BOARD_SEED_STAGE_IDS.ready),
        child("b", "c2", BOARD_SEED_STAGE_IDS.ready),
        child("c", "c3", BOARD_SEED_STAGE_IDS.ready),
        child("d", "c4", BOARD_SEED_STAGE_IDS.ready),
      ],
      cards: [
        // The child ref says Ready; the shell says Building. The shell is
        // fresher, and it wins.
        shell("c1", BOARD_SEED_STAGE_IDS.building, { stepRunning: true, prNumber: 303 }),
        shell("c2", BOARD_SEED_STAGE_IDS.building, { awaitingInput: true }),
        shell("c3", BOARD_SEED_STAGE_IDS.building, { queued: true }),
        shell("c4", BOARD_SEED_STAGE_IDS.building, { stalled: true }),
      ],
      stages: BOARD_SEED_STAGES,
    });
    expect(rows[0]!.stage).toBe(BOARD_SEED_STAGE_IDS.building);
    expect(rows[0]!.live).toEqual({
      cardId: "c1",
      prNumber: 303,
      working: true,
      awaitingInput: false,
      queued: false,
      stalled: false,
    });
    expect(rows[1]!.live?.awaitingInput).toBe(true);
    expect(rows[2]!.live?.queued).toBe(true);
    expect(rows[3]!.live?.stalled).toBe(true);
  });

  it("lights the working dot for a running step between a loop's threads", () => {
    // `stepRunning` is the durable signal; `threadState` only lights while a
    // single thread is mid-turn. The row uses the card face's own rule so a
    // review loop's between-thread gaps do not read as idle.
    const { rows } = deriveBoardPlanRows({
      plans: [plan("a", 0)],
      children: [child("a", "c1", BOARD_SEED_STAGE_IDS.review)],
      cards: [shell("c1", BOARD_SEED_STAGE_IDS.review, { stepRunning: true, threadState: "none" })],
      stages: BOARD_SEED_STAGES,
    });
    expect(rows[0]!.live?.working).toBe(true);
  });

  it("returns nothing for a card with no plans", () => {
    expect(
      deriveBoardPlanRows({ plans: [], children: [], cards: [], stages: BOARD_SEED_STAGES }),
    ).toEqual({ rows: [], liveTotal: 0, liveDone: 0 });
  });
});

describe("boardPlanGraphLayout", () => {
  const rowsOf = (plans: ReadonlyArray<BoardPlanRowPlan>, doneKeys: ReadonlyArray<string> = []) =>
    deriveBoardPlanRows({
      plans,
      children: plans.map((entry, index) =>
        child(
          String(entry.planId).split("::")[1]!,
          `c${index + 1}`,
          doneKeys.includes(String(entry.planId).split("::")[1]!)
            ? BOARD_SEED_STAGE_IDS.done
            : BOARD_SEED_STAGE_IDS.ready,
        ),
      ),
      cards: plans.map((entry, index) =>
        shell(
          `c${index + 1}`,
          doneKeys.includes(String(entry.planId).split("::")[1]!)
            ? BOARD_SEED_STAGE_IDS.done
            : BOARD_SEED_STAGE_IDS.ready,
        ),
      ),
      stages: BOARD_SEED_STAGES,
    }).rows;

  it("lays each plan one column past its last prerequisite", () => {
    const layout = boardPlanGraphLayout(rowsOf(PLANS));
    expect(layout).not.toBeNull();
    const columnOf = (n: number) => layout!.nodes.find((node) => node.n === n)!.x;
    // #1 roots; #2 and #4 both come after it and share a column; #3 comes
    // after #2 and sits one further right.
    expect(columnOf(1)).toBe(0);
    expect(columnOf(2)).toBe(columnOf(4));
    expect(columnOf(2)).toBeGreaterThan(columnOf(1));
    expect(columnOf(3)).toBeGreaterThan(columnOf(2));
    // Siblings in one column do not overlap.
    const wave = layout!.nodes.filter((node) => node.x === columnOf(2));
    expect(new Set(wave.map((node) => node.y)).size).toBe(wave.length);
  });

  it("draws one edge per plan dependency and tints the satisfied ones", () => {
    const layout = boardPlanGraphLayout(rowsOf(PLANS, ["a"]))!;
    expect(layout.edges).toHaveLength(3);
    // #1 is done, so both edges leaving it are satisfied; the one leaving #2
    // is not.
    expect(layout.edges.filter((edge) => edge.done)).toHaveLength(2);
  });

  it("sizes the canvas to the widest wave and the deepest chain", () => {
    const layout = boardPlanGraphLayout(rowsOf(PLANS))!;
    const right = Math.max(...layout.nodes.map((node) => node.x + node.width));
    const bottom = Math.max(...layout.nodes.map((node) => node.y + node.height));
    expect(layout.width).toBe(right);
    expect(layout.height).toBe(bottom);
  });

  it("terminates on a cyclic plan graph instead of recurring forever", () => {
    // The decider refuses to approve a cycle, so this is unreachable through
    // the app — but a pure function that can hang the render on bad data is a
    // worse failure than the one it guards.
    const layout = boardPlanGraphLayout(rowsOf([plan("a", 0, ["b"]), plan("b", 1, ["a"])]));
    expect(layout).not.toBeNull();
    expect(layout!.nodes).toHaveLength(2);
    expect(layout!.edges).toHaveLength(2);
  });

  it("returns null when there is nothing to draw", () => {
    expect(boardPlanGraphLayout([])).toBeNull();
  });
});

describe("boardPlanFinalReview", () => {
  it("counts progress and says the review starts on its own", () => {
    const final = boardPlanFinalReview({ branch: "t3o/TT-9", liveTotal: 4, liveDone: 1 });
    expect(final.branch).toBe("t3o/TT-9");
    expect(final.note).toBe(
      "1 of 4 plans done. The final review starts on its own when the last one lands.",
    );
  });

  it("switches to the all-done wording without offering an action", () => {
    // D5: the reactor owns the transition, so the copy describes it rather
    // than putting a second trigger next to it.
    expect(boardPlanFinalReview({ branch: "t3o/TT-9", liveTotal: 3, liveDone: 3 }).note).toBe(
      "All 3 plans done. The final review runs on the integration branch.",
    );
  });

  it("says so when every plan card has gone", () => {
    expect(boardPlanFinalReview({ branch: null, liveTotal: 0, liveDone: 0 }).note).toBe(
      "No plan cards are left on this split.",
    );
  });

  it("singularises a lone plan", () => {
    expect(boardPlanFinalReview({ branch: null, liveTotal: 1, liveDone: 0 }).note).toContain(
      "0 of 1 plan done",
    );
  });
});

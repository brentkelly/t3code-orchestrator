import {
  BOARD_ATTENTION_SETTLE_MS,
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardStageId,
  EMPTY_BOARD_WORKERS_STATE,
  ProjectId,
  ThreadId,
  makeBoardCardShell,
  type BoardCardShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarThreadStatus } from "../../components/Sidebar.logic";
import type { BoardCardNotificationObservation } from "../boardCardNotifications.logic";
import {
  boardCardTabStatus,
  resolveCardTabStatus,
  threadTabStatus,
  type TabStatus,
} from "./tabStatus.logic";

const T0 = Date.parse("2026-11-11T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function shell(stage: string, overrides?: Partial<BoardCardShell>): BoardCardShell {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: "A card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...overrides,
  };
}

function statusOf(
  card: BoardCardShell,
  overrides?: Partial<
    BoardCardNotificationObservation & {
      childRunning: number;
      stageGone: string | null;
      now: number;
    }
  >,
): TabStatus | null {
  return boardCardTabStatus({
    card,
    stages: BOARD_SEED_STAGES,
    mergeStageId: "merge",
    autoMergeArmed: false,
    isGroup: false,
    projectHidden: false,
    workers: EMPTY_BOARD_WORKERS_STATE,
    // Quiet long ago, so no settle grace is pending.
    threadIdleSince: iso(T0 - 60_000),
    childRunning: 0,
    stageGone: null,
    now: T0,
    ...overrides,
  });
}

const star = (label: string): TabStatus => ({ label, needsYou: true });
const plain = (label: string): TabStatus => ({ label, needsYou: false });
const ci = (phase: string) => ({ phase }) as NonNullable<BoardCardShell["ci"]>;

describe("boardCardTabStatus", () => {
  it.each<[string, BoardCardShell, TabStatus | null]>([
    ["a live question", shell("building", { awaitingInput: true }), star("Input needed")],
    ["a parked question", shell("planning", { stepAwaiting: "question" }), star("Input needed")],
    [
      "a permission prompt",
      shell("building", { threadState: "waiting", stepRunning: true }),
      star("Permission needed"),
    ],
    [
      "a split awaiting approval",
      shell("planning", { planCount: 2 }),
      star("Plan approval needed"),
    ],
    ["CI stopped for a human", shell("ci", { ci: ci("stopped") }), star("CI needs you")],
    ["a held build", shell("building", { held: true }), star("Needs a human")],
    ["a stopped sign-off", shell("planning", { stepAwaiting: "stopped" }), star("Needs a human")],
    [
      "a stall",
      shell("building", { stalled: true, stalledReason: "usage-limit" }),
      star("Stalled"),
    ],
    [
      "a held review loop the round row explains",
      shell("review", {
        reviewOutcome: "round-cap",
        reviewHeldOutcome: "round-cap",
        reviewRoundComplete: true,
        roundCurrent: 3,
      }),
      star("Review stopped"),
    ],
    [
      "a stuck review loop",
      shell("review", {
        reviewOutcome: "stuck",
        reviewHeldOutcome: "stuck",
        reviewRoundComplete: true,
        roundCurrent: 2,
      }),
      star("Review needs your call"),
    ],
    [
      "the dependency gate",
      shell("building", { blocked: true, dependencyCount: 1 }),
      star("Blocked"),
    ],
    ["a conflict fix", shell("merge", { hasPr: true, stepConflictFix: true }), star("Conflicts")],
    [
      "auto-merge still retrying",
      shell("merge", { hasPr: true, autoMergeHeldSince: iso(T0) }),
      star("Merge held"),
    ],
    [
      "auto-merge that gave up",
      shell("merge", { hasPr: true, autoMergeHeldSince: iso(T0), autoMergeGaveUp: true }),
      star("Merge needs you"),
    ],
    ["a card at merge with no PR", shell("merge", { hasPr: false }), star("No PR")],
    [
      "a card whose worker was removed",
      shell("building", {
        placementOrphaned: {
          workerId: "worker-1",
          workerLabel: "box",
          orphanedAt: iso(T0),
        } as never,
      }),
      star("Worker removed"),
    ],
    [
      "a card moving to a worker",
      shell("building", {
        workerMove: { toWorkerId: "worker-1", status: "moving" } as never,
      }),
      plain("Moving"),
    ],
    [
      "a failed move",
      shell("building", {
        workerMove: { toWorkerId: "worker-1", status: "failed" } as never,
      }),
      star("Move failed"),
    ],
    ["Ready for merge", shell("merge", { hasPr: true }), star("Ready for merge")],
    [
      "a working card",
      shell("building", { threadState: "working", stepRunning: true }),
      plain("Working"),
    ],
    ["a running CI script", shell("ci", { ci: ci("running") }), plain("Working")],
    ["an idle card", shell("backlog"), null],
    ["a paused card", shell("building", { stepAwaiting: "paused" }), null],
    ["a done card, even held", shell("done", { held: true }), null],
    [
      "an archived card",
      shell("building", { awaitingInput: true, archivedAt: iso(T0) as never }),
      null,
    ],
  ])("%s", (_name, card, expected) => {
    expect(statusOf(card)).toEqual(expected);
  });

  it("ranks a question and conflicts above the working dot", () => {
    expect(
      statusOf(
        shell("building", { threadState: "working", stepRunning: true, awaitingInput: true }),
      ),
    ).toEqual(star("Input needed"));
    expect(
      statusOf(
        shell("merge", {
          hasPr: true,
          stepConflictFix: true,
          threadState: "working",
          stepRunning: true,
        }),
      ),
    ).toEqual(star("Conflicts"));
  });

  it("names the stage a project switched off", () => {
    expect(statusOf(shell("building"), { stageGone: "Building is off" })).toEqual(
      star("Stage removed"),
    );
  });

  it("is never Ready for merge with auto-merge armed, or inside the settle grace", () => {
    const ready = shell("merge", { hasPr: true });
    expect(statusOf(ready, { autoMergeArmed: true })).toBeNull();
    expect(statusOf(ready, { threadIdleSince: iso(T0 - 1_000) })).toBeNull();
    expect(
      statusOf(ready, { threadIdleSince: iso(T0 - 1_000), now: T0 + BOARD_ATTENTION_SETTLE_MS }),
    ).toEqual(star("Ready for merge"));
  });

  it("waits out the settle grace before Needs a human", () => {
    const held = shell("building", { held: true });
    expect(statusOf(held, { threadIdleSince: iso(T0 - 1_000) })).toBeNull();
  });

  it("is hidden for a card in a hidden project", () => {
    expect(
      statusOf(shell("building", { awaitingInput: true }), { projectHidden: true }),
    ).toBeNull();
  });

  it("takes a group's working dot from its children", () => {
    expect(statusOf(shell("building"), { isGroup: true, childRunning: 2 })).toEqual(
      plain("Working"),
    );
    expect(
      statusOf(shell("building", { threadState: "working", stepRunning: true }), { isGroup: true }),
    ).toBeNull();
  });
});

describe("resolveCardTabStatus", () => {
  const threadId = ThreadId.make("thread-1");
  const sources = {
    stageList: BOARD_SEED_STAGES,
    projectStageConfigs: {},
    serverSettings: null,
    workers: EMPTY_BOARD_WORKERS_STATE,
  };
  const parent = shell("building", { cardId: BoardCardId.make("parent"), key: "T3-1" });
  const child = (id: string, overrides?: Partial<BoardCardShell>) =>
    shell("building", {
      cardId: BoardCardId.make(id),
      key: `T3-${id}`,
      parentCardId: BoardCardId.make("parent"),
      ...overrides,
    });

  it("reads a parent with children as a group, as its card face does", () => {
    const at = (cards: ReadonlyArray<BoardCardShell>) =>
      resolveCardTabStatus({
        ...sources,
        cardId: "parent",
        cards,
        threadOf: () => undefined,
        now: T0,
      }).status;
    // A group's face shows its children's waits in its stats, not as its own tone.
    expect(at([parent, child("a", { awaitingInput: true })])).toBeNull();
    expect(
      at([
        parent,
        child("a", { threadState: "working", stepRunning: true }),
        shell("building", { cardId: BoardCardId.make("other"), threadState: "working" }),
      ]),
    ).toEqual(plain("Working"));
    expect(
      at([
        parent,
        shell("building", { cardId: BoardCardId.make("other"), threadState: "working" }),
      ]),
    ).toBeNull();
  });

  it("reports when the shown card's settle grace ends, and flips then", () => {
    const held = shell("building", { held: true, activeThreadId: threadId });
    const completedAt = DateTime.makeUnsafe(T0 - 1_000);
    const at = (now: number) =>
      resolveCardTabStatus({
        ...sources,
        cardId: "card-1",
        cards: [held],
        threadOf: (id) => (id === threadId ? { latestRunCompletedAt: completedAt } : undefined),
        now,
      });
    const settleAt = T0 - 1_000 + BOARD_ATTENTION_SETTLE_MS;
    expect(at(T0)).toEqual({ status: null, settleAt });
    expect(at(settleAt)).toEqual({ status: star("Needs a human"), settleAt: null });
  });

  it("is null for a card the board does not hold", () => {
    expect(
      resolveCardTabStatus({
        ...sources,
        cardId: "missing",
        cards: [parent],
        threadOf: () => undefined,
        now: T0,
      }),
    ).toEqual({ status: null, settleAt: null });
  });
});

describe("threadTabStatus", () => {
  it.each<[SidebarThreadStatus, TabStatus | null]>([
    ["working", plain("Working")],
    ["preparing", plain("Working")],
    ["input", star("Input needed")],
    ["approval", star("Approval needed")],
    ["request", star("Guest request")],
    ["failed", star("Failed")],
    ["limited", star("Usage limit")],
    ["waiting", null],
    ["ready", null],
  ])("%s", (status, expected) => {
    expect(threadTabStatus(status)).toEqual(expected);
  });
});

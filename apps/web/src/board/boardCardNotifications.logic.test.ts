import {
  BOARD_ATTENTION_SETTLE_MS,
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardStageId,
  EMPTY_BOARD_WORKERS_STATE,
  ProjectId,
  makeBoardCardShell,
  type BoardCardShell,
  type BoardNotificationSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardNotificationReason,
  boardCardWaitAlreadyAlerted,
  createBoardCardNotificationGate,
  type BoardCardNotificationObservation,
  type BoardCardNotificationReason,
  type BoardCardThreadAlertState,
} from "./boardCardNotifications.logic";

const T0 = Date.parse("2026-11-11T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
/** A thread that went quiet long ago, so no settle grace is pending. */
const QUIET = { threadIdleSince: iso(T0 - 60_000) };

const SETTINGS: BoardNotificationSettings = {
  enabled: true,
  waiting: true,
  needsHuman: true,
  readyForMerge: true,
  blocked: false,
  muteRoutineThreadAlerts: true,
};

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

function observe(
  card: BoardCardShell,
  overrides?: Partial<BoardCardNotificationObservation>,
): BoardCardNotificationObservation {
  return {
    card,
    stages: BOARD_SEED_STAGES,
    mergeStageId: "merge",
    autoMergeArmed: false,
    isGroup: false,
    projectHidden: false,
    workers: EMPTY_BOARD_WORKERS_STATE,
    threadIdleSince: null,
    ...overrides,
  };
}

const reasonOf = (
  card: BoardCardShell,
  overrides?: Partial<BoardCardNotificationObservation>,
  now = T0,
) => boardCardNotificationReason({ ...observe(card, overrides), now })?.key ?? null;

describe("boardCardNotificationReason", () => {
  it.each([
    ["a live question", shell("building", { awaitingInput: true }), "waiting:input:building"],
    [
      "a question the step parked",
      shell("planning", { stepAwaiting: "question" }),
      "waiting:input:planning",
    ],
    [
      "a plan sign-off that ends without a question",
      shell("planning", { stepAwaiting: "stopped" }),
      "needsHuman:stopped:planning",
    ],
    [
      "a split waiting for approval, before any child exists",
      shell("planning", { planCount: 2 }),
      "waiting:approval:planning",
    ],
    [
      "CI stopped for a human",
      shell("ci", { ci: { phase: "stopped" } as NonNullable<BoardCardShell["ci"]> }),
      "waiting:ci-stopped:ci",
    ],
    ["a held build", shell("building", { held: true }), "needsHuman:held:building"],
    [
      "a stall recovery gave up on",
      shell("building", { stalled: true, stalledReason: "gave-up" }),
      "needsHuman:stalled:building",
    ],
    [
      "a usage-limit stall",
      shell("building", { stalled: true, stalledReason: "usage-limit" }),
      null,
    ],
    [
      "a stall waiting to retry",
      shell("building", { stalled: true, stalledReason: "waiting-retry" }),
      null,
    ],
    ["a paused card", shell("building", { stepAwaiting: "paused" }), null],
    [
      "auto-merge that gave up",
      shell("merge", {
        hasPr: true,
        autoMergeHeldSince: iso(T0),
        autoMergeGaveUp: true,
      }),
      "needsHuman:merge-gave-up:merge",
    ],
    [
      "a merge the board is still retrying",
      shell("merge", { hasPr: true, autoMergeHeldSince: iso(T0) }),
      null,
    ],
    ["a card at merge with no PR", shell("merge", { hasPr: false }), "needsHuman:no-pr:merge"],
    ["a done card", shell("done", { held: true }), null],
    ["an archived card", shell("building", { held: true, archivedAt: iso(T0) as never }), null],
  ])("%s", (_name, card, expected) => {
    expect(reasonOf(card)).toBe(expected);
  });

  it("waits out the settle grace for a held card, then fires", () => {
    const card = shell("building", { held: true });
    expect(reasonOf(card, { threadIdleSince: iso(T0) }, T0 + 1_000)).toBeNull();
    expect(reasonOf(card, { threadIdleSince: iso(T0) }, T0 + BOARD_ATTENTION_SETTLE_MS)).toBe(
      "needsHuman:held:building",
    );
  });

  it("never alerts for a card in a hidden project", () => {
    expect(reasonOf(shell("building", { held: true }), { projectHidden: true })).toBeNull();
  });

  it("lets a group's roll-up stay quiet", () => {
    expect(reasonOf(shell("building", { held: true }), { isGroup: true })).toBeNull();
  });

  it("reads Ready for merge only with auto-merge off and nothing else going on", () => {
    const ready = shell("merge", { hasPr: true });
    expect(reasonOf(ready)).toBe("readyForMerge:ready:merge");
    expect(reasonOf(ready, { autoMergeArmed: true })).toBeNull();
    expect(
      reasonOf(
        shell("merge", {
          hasPr: true,
          ci: { phase: "running" } as NonNullable<BoardCardShell["ci"]>,
        }),
      ),
    ).toBeNull();
    expect(reasonOf(shell("merge", { hasPr: true, stepConflictFix: true }))).toBeNull();
    expect(reasonOf(shell("merge", { hasPr: true, threadState: "working" }))).toBeNull();
    expect(reasonOf(shell("merge", { hasPr: true, queued: true }))).toBeNull();
  });

  it("fires review-held and review-stuck even when the round row hides the chip", () => {
    expect(
      reasonOf(
        shell("review", {
          reviewOutcome: "round-cap",
          reviewHeldOutcome: "round-cap",
          reviewRoundComplete: true,
          roundCurrent: 3,
        }),
      ),
    ).toBe("needsHuman:review-held:review");
    expect(
      reasonOf(
        shell("review", {
          reviewOutcome: "stuck",
          reviewHeldOutcome: "stuck",
          reviewRoundComplete: true,
          roundCurrent: 2,
        }),
      ),
    ).toBe("waiting:review-stuck:review");
  });

  it("classifies the dependency gate as blocked", () => {
    expect(reasonOf(shell("building", { blocked: true, dependencyCount: 1 }))).toBe(
      "blocked:blocked:building",
    );
  });
});

describe("createBoardCardNotificationGate", () => {
  const run = (
    gate: ReturnType<typeof createBoardCardNotificationGate>,
    cards: ReadonlyArray<BoardCardNotificationObservation>,
    now = T0,
    settings = SETTINGS,
  ) => {
    const result = gate.evaluate({ cards, settings, now });
    return {
      fired: result.fire.map((entry) => entry.reason.key),
      cleared: result.cleared.map(String),
      wakeAt: result.wakeAt,
    };
  };

  it("takes a silent baseline, then fires on a new wait", () => {
    const gate = createBoardCardNotificationGate();
    expect(run(gate, [observe(shell("building", { held: true }))]).fired).toEqual([]);
    expect(run(gate, [observe(shell("building"))]).cleared).toEqual(["card-1"]);
    expect(run(gate, [observe(shell("building", { awaitingInput: true }))]).fired).toEqual([
      "waiting:input:building",
    ]);
  });

  it("stays silent for a card first seen after the baseline", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, []);
    expect(run(gate, [observe(shell("building", { awaitingInput: true }))]).fired).toEqual([]);
  });

  it("fires a second question after the first was answered", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("building"))]);
    expect(run(gate, [observe(shell("building", { awaitingInput: true }))]).fired).toHaveLength(1);
    run(gate, [observe(shell("building", { threadState: "working" }))]);
    expect(run(gate, [observe(shell("building", { awaitingInput: true }))]).fired).toHaveLength(1);
  });

  it("fires held, working, held twice", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("building"), QUIET)]);
    expect(run(gate, [observe(shell("building", { held: true }), QUIET)]).fired).toHaveLength(1);
    run(gate, [observe(shell("building", { threadState: "working", stepRunning: true }), QUIET)]);
    expect(run(gate, [observe(shell("building", { held: true }), QUIET)]).fired).toHaveLength(1);
  });

  it("waits out the grace from first sight when the thread's idle time is unknown", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("building"))]);
    const held = observe(shell("building", { held: true }));
    const first = run(gate, [held], T0 + 1_000);
    expect(first.fired).toEqual([]);
    expect(first.wakeAt).toBe(T0 + 1_000 + BOARD_ATTENTION_SETTLE_MS);
    expect(run(gate, [held], T0 + 1_000 + BOARD_ATTENTION_SETTLE_MS).fired).toEqual([
      "needsHuman:held:building",
    ]);
  });

  it("keeps a wait accepted at the baseline quiet when the thread's idle time is unknown", () => {
    const gate = createBoardCardNotificationGate();
    const held = observe(shell("building", { held: true }));
    run(gate, [held]);
    expect(run(gate, [held], T0 + 1_000)).toMatchObject({ fired: [], cleared: [] });
    expect(run(gate, [held], T0 + 1_000 + BOARD_ATTENTION_SETTLE_MS)).toMatchObject({
      fired: [],
      cleared: [],
    });
  });

  it("keeps a raised wait quiet when the thread's idle time stops being known", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("building"))]);
    const card = shell("building", { held: true });
    expect(
      run(gate, [observe(card, { threadIdleSince: iso(T0) })], T0 + BOARD_ATTENTION_SETTLE_MS)
        .fired,
    ).toHaveLength(1);
    const later = T0 + BOARD_ATTENTION_SETTLE_MS + 1_000;
    expect(run(gate, [observe(card)], later)).toMatchObject({ fired: [], cleared: [] });
    expect(run(gate, [observe(card)], later + BOARD_ATTENTION_SETTLE_MS)).toMatchObject({
      fired: [],
      cleared: [],
    });
  });

  it("uses the thread's idle time when it is known", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("building"))]);
    const held = observe(shell("building", { held: true }), { threadIdleSince: iso(T0) });
    expect(run(gate, [held], T0 + 2_000)).toMatchObject({
      fired: [],
      wakeAt: T0 + BOARD_ATTENTION_SETTLE_MS,
    });
    expect(run(gate, [held], T0 + BOARD_ATTENTION_SETTLE_MS).fired).toHaveLength(1);
  });

  it("fires only one of No PR and Ready for merge per merge-stage visit", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("review", { hasPr: false }), QUIET)]);
    expect(run(gate, [observe(shell("merge", { hasPr: false }), QUIET)]).fired).toEqual([
      "needsHuman:no-pr:merge",
    ]);
    expect(run(gate, [observe(shell("merge", { hasPr: true }), QUIET)]).fired).toEqual([]);
    // A fresh visit alerts again.
    run(gate, [observe(shell("review", { hasPr: true }), QUIET)]);
    expect(run(gate, [observe(shell("merge", { hasPr: true }), QUIET)]).fired).toEqual([
      "readyForMerge:ready:merge",
    ]);

    // A No PR that raised nothing does not spend the visit.
    const quiet = createBoardCardNotificationGate();
    const noNeedsHuman = { ...SETTINGS, needsHuman: false };
    run(quiet, [observe(shell("review", { hasPr: false }), QUIET)], T0, noNeedsHuman);
    expect(
      run(quiet, [observe(shell("merge", { hasPr: false }), QUIET)], T0, noNeedsHuman).fired,
    ).toEqual([]);
    expect(
      run(quiet, [observe(shell("merge", { hasPr: true }), QUIET)], T0, noNeedsHuman).fired,
    ).toEqual(["readyForMerge:ready:merge"]);
  });

  it("leaves blocked off by default and honours the master switch", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("building"))]);
    const blocked = observe(shell("building", { blocked: true, dependencyCount: 1 }));
    expect(run(gate, [blocked]).fired).toEqual([]);

    const on = createBoardCardNotificationGate();
    run(on, [observe(shell("building"))]);
    expect(run(on, [blocked], T0, { ...SETTINGS, blocked: true }).fired).toHaveLength(1);

    const off = createBoardCardNotificationGate();
    run(off, [observe(shell("building"))]);
    expect(
      run(off, [observe(shell("building", { awaitingInput: true }))], T0, {
        ...SETTINGS,
        enabled: false,
      }).fired,
    ).toEqual([]);
  });

  it("re-baselines after a reset, as when the board server changes", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("building"))]);
    gate.reset();
    expect(run(gate, [observe(shell("building", { awaitingInput: true }))]).fired).toEqual([]);
  });

  it("reports a card that left the board as cleared", () => {
    const gate = createBoardCardNotificationGate();
    run(gate, [observe(shell("building"))]);
    run(gate, [observe(shell("building", { awaitingInput: true }))]);
    expect(run(gate, []).cleared).toEqual(["card-1"]);
  });
});

describe("boardCardWaitAlreadyAlerted", () => {
  const thread = (overrides?: Partial<BoardCardThreadAlertState>): BoardCardThreadAlertState => ({
    status: "input",
    archived: false,
    active: true,
    upstreamSkips: false,
    ...overrides,
  });
  const reason = (
    key: "input" | "permission" | "held" | "stopped" | "approval",
  ): BoardCardNotificationReason => ({ category: "waiting", reason: key, key, title: key });
  type Rest = Omit<Parameters<typeof boardCardWaitAlreadyAlerted>[0], "reason" | "threads">;
  const base: Rest = {
    card: { awaitingInput: true, stepAwaiting: null },
    upstreamAlertsOn: true,
    boardConnected: true,
  };

  it.each<
    [string, BoardCardNotificationReason, ReadonlyArray<BoardCardThreadAlertState>, Rest, boolean]
  >([
    ["a live question the thread raised", reason("input"), [thread()], base, true],
    ["a guest request", reason("input"), [thread({ status: "request" })], base, true],
    [
      "a question the board parked",
      reason("input"),
      [thread()],
      { ...base, card: { awaitingInput: false, stepAwaiting: "question" } },
      false,
    ],
    ["a permission prompt", reason("permission"), [thread({ status: "approval" })], base, true],
    [
      "a failed thread behind a held card",
      reason("held"),
      [thread({ status: "failed" })],
      base,
      true,
    ],
    [
      "an archived failed thread",
      reason("stopped"),
      [thread({ status: "failed", archived: true })],
      base,
      false,
    ],
    [
      "an earlier stage's failed thread beside a clean active thread",
      reason("held"),
      [thread({ status: "failed", active: false }), thread({ status: "ready" })],
      base,
      false,
    ],
    ["a thread upstream skips", reason("input"), [thread({ upstreamSkips: true })], base, false],
    [
      "upstream alerts off",
      reason("input"),
      [thread()],
      { ...base, upstreamAlertsOn: false },
      false,
    ],
    [
      "a disconnected board",
      reason("input"),
      [thread()],
      { ...base, boardConnected: false },
      false,
    ],
    ["a split approval", reason("approval"), [thread()], base, false],
  ])("%s", (_name, wait, threads, rest, expected) => {
    expect(boardCardWaitAlreadyAlerted({ ...rest, reason: wait, threads })).toBe(expected);
  });
});

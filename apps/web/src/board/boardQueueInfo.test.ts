import { describe, expect, it } from "vite-plus/test";

import { boardQueueInfo } from "./boardQueueInfo";

const slot = (position: number, total: number) => ({
  position,
  total,
  ahead: position - 1,
  startsNext: position === 1,
});

describe("boardQueueInfo", () => {
  it("is null for a card that is not queued", () => {
    expect(boardQueueInfo({ slot: undefined, running: 3, cap: 3 })).toBeNull();
  });

  it("names the position and what is ahead of it", () => {
    const info = boardQueueInfo({ slot: slot(2, 3), running: 3, cap: 3 })!;
    expect(info.headline).toBe("Queued #2");
    expect(info.label).toBe("Queued #2");
    expect(info.detail).toBe(
      "3 of 3 agents busy · 1 task ahead. It starts on its own when an agent frees up.",
    );
  });

  it("drops the tasks-ahead clause at the front of the queue", () => {
    const info = boardQueueInfo({ slot: slot(1, 2), running: 3, cap: 3 })!;
    expect(info.label).toBe("Next");
    expect(info.headline).toBe("Queued — starts next");
    expect(info.detail).toBe("3 of 3 agents busy. It starts on its own when an agent frees up.");
  });

  it("pluralises the work ahead", () => {
    expect(boardQueueInfo({ slot: slot(3, 4), running: 3, cap: 3 })!.detail).toContain(
      "2 tasks ahead",
    );
  });

  // The client cannot see every slot-holder: a step parked on a question keeps
  // its slot and reaches the shell as neither running nor queued, and a
  // per-instance cap holds work back with the global count below its ceiling.
  // A fraction here would imply spare capacity the card demonstrably could not
  // get, so it is not stated.
  it("states no fraction below the cap, where the count could be an undercount", () => {
    const detail = boardQueueInfo({ slot: slot(1, 1), running: 1, cap: 3 })!.detail;
    expect(detail).toContain("No agent is free for this task");
    expect(detail).not.toContain("of 3 agents");
  });

  // A force start deliberately runs over the limit (t3o-33). "4 of 3" reads as
  // a bug, so past the ceiling the sentence stops being a fraction.
  it("reports the limit rather than a nonsense fraction once over the cap", () => {
    expect(boardQueueInfo({ slot: slot(2, 2), running: 4, cap: 3 })!.detail).toContain(
      "4 agents running (limit 3)",
    );
  });

  // T3O-32: the queue is one board-wide line for every stage's step, so a card
  // waiting for a review or planning slot showed "Queued for build" and named
  // work it was not about to do. No string here may name a stage.
  it("never names a stage, at any position in the queue", () => {
    for (const position of [1, 2, 7]) {
      const info = boardQueueInfo({ slot: slot(position, 9), running: 3, cap: 3 })!;
      for (const copy of [info.headline, info.label, info.detail]) {
        expect(copy.toLowerCase()).not.toContain("build");
      }
    }
  });
});

describe("boardQueueInfo with workers (T3O-65)", () => {
  it("names a full worker", () => {
    const info = boardQueueInfo({
      slot: slot(2, 3),
      running: 5,
      cap: 8,
      reason: { kind: "worker", worker: "linux-box", running: 4, limit: 4 },
    })!;
    expect(info.label).toBe("Queued #2 · worker full");
    expect(info.headline).toBe("Queued #2 on linux-box");
    expect(info.detail).toBe(
      "linux-box is running 4 of 4 agents. This card starts when one finishes.",
    );
  });

  it("names a full provider and a full board", () => {
    expect(
      boardQueueInfo({
        slot: slot(1, 1),
        running: 1,
        cap: 8,
        reason: { kind: "provider", worker: "linux-box" },
      })!.label,
    ).toBe("Queued #1 · provider full");
    const board = boardQueueInfo({
      slot: slot(3, 3),
      running: 8,
      cap: 8,
      reason: { kind: "board", running: 8, limit: 8 },
    })!;
    expect(board.label).toBe("Queued #3 · board full");
    expect(board.detail).toBe(
      "8 of 8 agents are busy across all workers. This card starts when any of them finishes.",
    );
  });

  it("says a card waiting for a checkout is setting up, with the clone's progress", () => {
    const cloning = boardQueueInfo({
      slot: slot(1, 1),
      running: 0,
      cap: 8,
      reason: {
        kind: "setup",
        worker: "mbp-brent",
        project: "advisor",
        percent: 32,
        failed: false,
      },
    })!;
    expect(cloning.label).toBe("Queued · setting up");
    expect(cloning.detail).toBe(
      "advisor is being cloned on mbp-brent (32%). This card starts once it's ready.",
    );
    const failed = boardQueueInfo({
      slot: slot(1, 1),
      running: 0,
      cap: 8,
      reason: {
        kind: "setup",
        worker: "mbp-brent",
        project: "advisor",
        percent: null,
        failed: true,
      },
    })!;
    expect(failed.detail).toContain("failed");
  });
});

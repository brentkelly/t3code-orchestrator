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
    expect(info.headline).toBe("Queued #2 for build");
    expect(info.label).toBe("Queued #2");
    expect(info.detail).toBe(
      "3 of 3 agents busy · 1 task ahead. It starts on its own when an agent frees up.",
    );
  });

  it("drops the tasks-ahead clause at the front of the queue", () => {
    const info = boardQueueInfo({ slot: slot(1, 2), running: 3, cap: 3 })!;
    expect(info.label).toBe("Next");
    expect(info.headline).toBe("Queued for build — starts next");
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
});

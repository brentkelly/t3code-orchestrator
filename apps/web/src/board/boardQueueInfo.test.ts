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
    expect(boardQueueInfo({ slot: undefined, running: 3 })).toBeNull();
  });

  it("names the position and what is ahead of it", () => {
    const info = boardQueueInfo({ slot: slot(2, 3), running: 3 })!;
    expect(info.headline).toBe("Queued #2");
    expect(info.label).toBe("Queued #2");
    expect(info.detail).toBe(
      "3 agents running · 1 task ahead. It starts on its own when there is room.",
    );
  });

  it("drops the tasks-ahead clause at the front of the queue", () => {
    const info = boardQueueInfo({ slot: slot(1, 2), running: 1 })!;
    expect(info.label).toBe("Next up");
    expect(info.headline).toBe("Queued: starts next");
    expect(info.detail).toBe("1 agent running. It starts on its own when there is room.");
  });

  it("says After others for a Low card behind a higher-priority one (T3O-95)", () => {
    const info = boardQueueInfo({
      slot: { ...slot(3, 3), afterHigherPriority: true },
      running: 3,
    })!;
    expect(info.label).toBe("After others");
    expect(info.detail).toContain("no higher-priority card is waiting");
  });

  it("pluralises the work ahead", () => {
    expect(boardQueueInfo({ slot: slot(3, 4), running: 3 })!.detail).toContain("2 tasks ahead");
  });

  // The queue is one board-wide line for every stage's step, so no string here may name a stage.
  it("never names a stage, at any position in the queue", () => {
    for (const position of [1, 2, 7]) {
      const info = boardQueueInfo({ slot: slot(position, 9), running: 3 })!;
      for (const copy of [info.headline, info.label, info.detail]) {
        expect(copy.toLowerCase()).not.toContain("build");
      }
    }
  });
});

describe("boardQueueInfo with worker capacity (T3O-86)", () => {
  it("explains a capacity wait, and who the card waits behind", () => {
    const info = boardQueueInfo({
      slot: slot(2, 3),
      running: 5,
      reason: {
        kind: "capacity",
        worker: "build-01",
        dimension: "cpu",
        behind: "T3O-90",
        tooBig: false,
        anyWorker: false,
      },
    })!;
    expect(info.label).toBe("Queued #2 · behind T3O-90");
    expect(info.headline).toBe("Waiting behind T3O-90 on build-01");
    expect(info.detail).toBe(
      "build-01 has too little CPU free for this card right now. build-01 decides what it offers. Run `pnpm t3o-worker status` there to see what holds the rest.",
    );
  });

  it("reads a Too-big card as held, not as a wait for room", () => {
    const info = boardQueueInfo({
      slot: slot(1, 3),
      running: 5,
      reason: {
        kind: "capacity",
        worker: "build-01",
        dimension: "ram",
        behind: null,
        tooBig: true,
        anyWorker: false,
      },
    })!;
    expect(info.blocked).toBe(true);
    expect(info.label).toBe("Too big for build-01");
    expect(info.detail).not.toContain("right now");
  });

  it("an unpinned card too big for every ready worker names none (T3O-87)", () => {
    const info = boardQueueInfo({
      slot: slot(1, 3),
      running: 5,
      reason: {
        kind: "capacity",
        worker: "this server",
        dimension: "ram",
        behind: null,
        tooBig: true,
        anyWorker: true,
      },
    })!;
    expect(info.blocked).toBe(true);
    expect(info.label).toBe("Too big for any worker");
  });

  it("no ready worker and the board server's checkout are amber; signing in there is violet (T3O-87)", () => {
    const of = (reason: Parameters<typeof boardQueueInfo>[0]["reason"]) =>
      boardQueueInfo({ slot: slot(1, 1), running: 0, reason })!;
    expect(of({ kind: "no-ready-worker", project: "z5" })).toMatchObject({
      blocked: true,
      headline: "No ready worker for this project",
    });
    const missing = of({ kind: "server-checkout", project: "z5", missing: true });
    expect(missing.blocked).toBe(true);
    expect(missing.detail).toContain("Clone here");
    expect(of({ kind: "server-checkout", project: "z5", missing: false }).detail).not.toContain(
      "Clone here",
    );
    const signIn = of({ kind: "server-sign-in", provider: "claude" });
    expect(signIn.attention).toBe(true);
    expect(signIn.blocked).toBeUndefined();
    expect(signIn.detail).toContain("`claude login`");
  });

  it("names quota, the agent cap and a worker that needs updating", () => {
    const of = (kind: "quota" | "agent-cap" | "needs-update") =>
      boardQueueInfo({ slot: slot(1, 1), running: 1, reason: { kind, worker: "build-01" } })!;
    expect(of("quota").label).toBe("Queued #1 · provider near quota");
    expect(of("agent-cap").detail).toContain("as many agents at once as it allows");
    expect(of("needs-update").detail).toContain("pnpm t3o-update");
  });

  it("tells a checkout on its way from a worker that needs a human, and the card's own setup", () => {
    const setup = (cause: "not-ready" | "not-set-up" | "card-setup" | null, cloning = false) =>
      boardQueueInfo({
        slot: slot(1, 1),
        running: 0,
        reason: { kind: "setup", worker: "mbp", project: "advisor", cloning, failed: false, cause },
      })!;
    const cloning = setup(null, true);
    expect(cloning.label).toBe("Queued · setting up");
    expect(cloning.detail).toBe(
      "advisor is being cloned on mbp. This card starts once it's ready.",
    );
    expect(cloning.blocked).not.toBe(true);
    // Not ready and no checkout need a human: amber, saying what to do.
    expect(setup("not-ready")).toMatchObject({ blocked: true, label: "Not ready on mbp" });
    expect(setup("not-ready").detail).toContain("Re-check");
    expect(setup("not-set-up")).toMatchObject({ blocked: true, label: "No checkout on mbp" });
    // The card's own setup script runs: blue, and nothing to do.
    const own = setup("card-setup");
    expect(own.label).toBe("Queued · setup running");
    expect(own.blocked).not.toBe(true);
  });
});

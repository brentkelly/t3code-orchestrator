/**
 * The worker's capacity service with every machine and server reading faked, two boards
 * below the RPC guard (T3O-86).
 */
import { ProviderDriverKind, type BoardSyncedCard, type ServerProvider } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { resolveWorkerCapacitySettings } from "../tunnel/workerFile.ts";
import {
  makeBoardWorkerCapacity,
  providerQuota,
  SNAPSHOT_INTERVAL_MS,
  SNAPSHOT_SETTLE_MS,
  type CapacityThread,
  type WorkerCapacityPorts,
} from "./BoardWorkerCapacity.ts";
import { EMPTY_CAPACITY_STATE, type CapacityRecord, type CapacityState } from "./capacityModel.ts";
import { BoardMachine } from "./machine.ts";

const GiB = 1024 ** 3;

interface Fakes {
  config: Record<string, unknown>;
  threads: Array<CapacityThread>;
  providers: Array<ServerProvider>;
  refreshed: Array<string>;
  saved: Map<string, { lastSeq: number | null; records: ReadonlyArray<CapacityRecord> }>;
  freeDiskBytes: number;
  availableBytes: number;
  stored: Map<string, string>;
  threadReads: number;
}

const makeFakes = (): Fakes => ({
  config: { "capacity.cpuCores": 16, "capacity.ramGiB": 64, "capacity.diskGB": 200 },
  threads: [],
  providers: [],
  refreshed: [],
  saved: new Map(),
  freeDiskBytes: 1000 * 1000 ** 3,
  availableBytes: 500 * GiB,
  stored: new Map(),
  threadReads: 0,
});

const portsOver = (
  fakes: Fakes,
  initial: CapacityState = EMPTY_CAPACITY_STATE,
): WorkerCapacityPorts => ({
  settings: Effect.sync(() => resolveWorkerCapacitySettings(fakes.config)),
  threads: Effect.sync(() => {
    fakes.threadReads += 1;
    return fakes.threads;
  }),
  providers: Effect.sync(() => fakes.providers),
  refreshProviderUsage: (instanceId) => Effect.sync(() => void fakes.refreshed.push(instanceId)),
  notReady: () => Effect.succeed(null),
  readiness: () => Effect.succeed([]),
  worktreePresence: () => Effect.succeed("owned"),
  worktreeVolume: "/w",
  unownedWorktrees: () => Effect.succeed([]),
  store: {
    load: Effect.succeed(initial),
    saveBoard: (boardId, lastSeq, records) =>
      Effect.sync(() => void fakes.saved.set(boardId, { lastSeq, records })),
    deleteBoard: (boardId) => Effect.sync(() => void fakes.saved.delete(boardId)),
    setting: (key) => Effect.sync(() => fakes.stored.get(key) ?? null),
    saveSetting: (key, value) => Effect.sync(() => void fakes.stored.set(key, value)),
  },
});

const withMachine = (fakes: Fakes) =>
  Effect.provideService(BoardMachine, {
    cpuCount: Effect.succeed(32),
    totalMemoryBytes: Effect.succeed(128 * GiB),
    availableMemoryBytes: Effect.sync(() => fakes.availableBytes),
    agentSliceMemoryHighBytes: Effect.succeed(null),
    freeDiskBytes: () => Effect.sync(() => fakes.freeDiskBytes),
    diskUsageBytes: () => Effect.succeed(1000 ** 3),
  });

const card = (cardId: string, overrides: Partial<BoardSyncedCard> = {}): BoardSyncedCard => ({
  cardId,
  repositoryKey: "github.com/acme/app",
  branch: `board/${cardId}`,
  worktreePath: `/w/${cardId}`,
  grantedProfile: { cpuCores: 4, ramGiB: 8, diskGB: 20 },
  phase: "heavy",
  settled: true,
  ...overrides,
});

const provider = (
  instanceId: string,
  windows: ReadonlyArray<{
    kind: string;
    label: string;
    usedPercent: number;
    resetsAt?: string;
    id?: string;
  }>,
  checkedAt = "1970-01-01T00:00:00.000Z",
  driver = "claudeAgent",
) =>
  ({
    instanceId,
    driver,
    enabled: true,
    auth: { status: "authenticated", email: "dev@example.com", label: "Max" },
    usageLimits: {
      checkedAt,
      windows: windows.map((window, index) => ({ id: `w${index}`, ...window })),
    },
  }) as unknown as ServerProvider;

const thread = (overrides: Partial<CapacityThread>): CapacityThread => ({
  threadId: "t",
  boardId: "board-a",
  worktreePath: null,
  running: true,
  providerInstanceId: "claude",
  ...overrides,
});

it.effect("the agent cap counts board-started running threads across every board", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.config = { ...fakes.config, maxAgents: 2, "providerCaps.codex": 1 };
    const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
    fakes.threads = [
      thread({ threadId: "a", boardId: "board-a" }),
      // A human's own thread and an idle board thread don't count.
      thread({ threadId: "h", boardId: null }),
      thread({ threadId: "i", boardId: "board-b", running: false }),
    ];
    assert.isNull(yield* service.agentCapRefusal("claude"));
    fakes.threads.push(thread({ threadId: "b", boardId: "board-b", providerInstanceId: "codex" }));
    assert.include((yield* service.agentCapRefusal("claude")) ?? "", "at most 2 agents");
    fakes.config = { ...fakes.config, maxAgents: 5 };
    assert.include((yield* service.agentCapRefusal("codex")) ?? "", "at most 1 codex");
    assert.isNull(yield* service.agentCapRefusal("claude"));
  }).pipe(Effect.provide(TestClock.layer()), (effect) => withMachine(makeFakes())(effect)),
);

it.effect("an admitted start counts against the cap until its thread shows running", () =>
  Effect.gen(function* () {
    const fakes = makeFakes();
    fakes.config = { ...fakes.config, maxAgents: 2 };
    const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
    fakes.threads = [thread({ threadId: "a", boardId: "board-a" })];
    // Two boards start a turn before either shows running: only one fits under the cap.
    const answers = yield* Effect.all(
      [service.reserveAgent("x", "claude"), service.reserveAgent("y", "claude")],
      { concurrency: "unbounded" },
    );
    assert.deepStrictEqual(
      answers.map((answer) => answer === null),
      [true, false],
    );
    // Once it runs it is counted once; a start that never happened gives its slot back.
    fakes.threads.push(thread({ threadId: "x", boardId: "board-b" }));
    assert.isNotNull(yield* service.reserveAgent("y", "claude"));
    fakes.threads = [thread({ threadId: "a", boardId: "board-a" })];
    assert.isNull(yield* service.reserveAgent("y", "claude"));
    yield* service.releaseAgent("y");
    assert.isNull(yield* service.agentCapRefusal("claude"));
  }).pipe(Effect.provide(TestClock.layer()), (effect) => withMachine(makeFakes())(effect)),
);

it("quota gates only account-wide session and weekly windows, until they reset", () => {
  const now = Date.parse("2026-11-13T00:00:00.000Z");
  const later = "2026-11-20T09:00:00.000Z";
  const scoped = provider("claude", [
    {
      kind: "weekly",
      label: "Weekly · Opus",
      usedPercent: 100,
      resetsAt: later,
      id: "seven_day_opus",
    },
    { kind: "monthly", label: "Monthly spend", usedPercent: 100 },
  ]);
  assert.isFalse(providerQuota(scoped, 95, now).exhausted);
  // Scope comes from ids and drivers, not labels: an account window's label may carry a "·"…
  const relabelled = provider("claude", [
    { kind: "weekly", label: "Weekly · all models", usedPercent: 100, id: "seven_day" },
  ]);
  assert.isTrue(providerQuota(relabelled, 95, now).exhausted);
  // Only the windows that refuse placement are drawn at their limit.
  assert.deepStrictEqual(
    providerQuota(scoped, 95, now).windows.map((window) => window.nearLimit),
    [false, false],
  );
  assert.deepStrictEqual(
    providerQuota(relabelled, 95, now).windows.map((window) => window.nearLimit),
    [true],
  );
  // …and every Antigravity window is one model family's.
  const family = provider(
    "ag",
    [{ kind: "weekly", label: "Gemini", usedPercent: 100, resetsAt: later }],
    undefined,
    "antigravity",
  );
  assert.isFalse(providerQuota(family, 95, now).exhausted);
  const weekly = provider("claude", [
    { kind: "weekly", label: "Weekly", usedPercent: 96, resetsAt: later },
  ]);
  assert.deepInclude(providerQuota(weekly, 95, now), { exhausted: true, resetsAt: later });
  const past = provider("claude", [
    { kind: "session", label: "Session", usedPercent: 100, resetsAt: "2026-11-12T00:00:00.000Z" },
  ]);
  assert.isFalse(providerQuota(past, 95, now).exhausted);
  assert.isFalse(
    providerQuota(
      { usageLimits: undefined, driver: ProviderDriverKind.make("claudeAgent") },
      95,
      now,
    ).exhausted,
  );
});

it.effect(
  "a placement refreshes stale usage with no UI client connected, then refuses on quota",
  () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      fakes.providers = [
        provider("claude", [{ kind: "session", label: "Session", usedPercent: 99 }]),
      ];
      const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
      yield* TestClock.adjust(60 * 60_000);
      const result = yield* service.claim("board-a", {
        claimId: "c1",
        seq: 1,
        cardId: "card-1",
        repositoryKey: null,
        kind: "placement",
        profile: { cpuCores: 1, ramGiB: 1, diskGB: 1 },
        providerInstanceId: "claude",
      });
      assert.deepStrictEqual(fakes.refreshed, ["claude"]);
      assert.strictEqual(result.outcome, "denied");
      assert.strictEqual(result.outcome === "denied" ? result.reason : null, "quota");
    }).pipe(withMachine(fakes), Effect.provide(TestClock.layer()));
  },
);

it.effect(
  "a hung usage refresh holds no other board's calls, and the claim decides after it times out",
  () => {
    const fakes = makeFakes();
    return Effect.gen(function* () {
      fakes.providers = [
        provider("claude", [{ kind: "session", label: "Session", usedPercent: 10 }]),
      ];
      const { service } = yield* makeBoardWorkerCapacity({
        ...portsOver(fakes),
        refreshProviderUsage: () => Effect.never,
      });
      yield* TestClock.adjust(60 * 60_000);
      const pending = yield* Effect.forkChild(
        service.claim("board-a", {
          claimId: "c1",
          seq: 1,
          cardId: "card-1",
          repositoryKey: null,
          kind: "placement",
          profile: { cpuCores: 1, ramGiB: 1, diskGB: 1 },
          providerInstanceId: "claude",
        }),
      );
      // Another board's sync runs while the refresh hangs: the lock isn't held across it.
      yield* service.syncCards("board-b", { seq: 1, authoritative: true, cards: [] });
      yield* TestClock.adjust(5_000);
      assert.strictEqual((yield* Fiber.join(pending)).outcome, "granted");
    }).pipe(withMachine(fakes), Effect.provide(TestClock.layer()));
  },
);

it.effect("the background refresh re-reads an exhausted provider every ten minutes", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    fakes.providers = [provider("claude", [{ kind: "weekly", label: "Weekly", usedPercent: 100 }])];
    const made = yield* makeBoardWorkerCapacity(portsOver(fakes));
    const fiber = yield* Effect.forkChild(made.background);
    yield* TestClock.adjust(1);
    assert.deepStrictEqual(fakes.refreshed, ["claude"]);
    yield* TestClock.adjust(10 * 60_000);
    assert.deepStrictEqual(fakes.refreshed, ["claude", "claude"]);
    yield* Fiber.interrupt(fiber);
  }).pipe(withMachine(fakes), Effect.provide(TestClock.layer()));
});

it.effect("a board's snapshot carries nothing about another board's cards", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
    yield* service.syncCards("board-a", {
      seq: 1,
      authoritative: true,
      cards: [card("a-1", { phase: "light" })],
    });
    yield* service.syncCards("board-b", {
      seq: 1,
      authoritative: true,
      cards: [card("b-1", { phase: "light" })],
    });
    // Both cards have a turn running, so both are counted heavy.
    fakes.threads = [
      thread({ threadId: "x", worktreePath: "/w/a-1" }),
      thread({ threadId: "y", boardId: "board-b", worktreePath: "/w/b-1" }),
    ];
    const snapshot = yield* service.snapshot("board-a");
    assert.deepStrictEqual(snapshot.heavyCards, ["a-1"]);
    assert.notInclude(JSON.stringify(snapshot), "b-1");
    assert.notInclude(JSON.stringify(snapshot), "board-b");
    // The other board's heavy card still takes room from what this one is offered.
    assert.strictEqual(snapshot.headroom.cpuCores, 8);
    // Each board's snapshot shares one reading of the threads.
    const reads = fakes.threadReads;
    yield* service.snapshot("board-b");
    assert.strictEqual(fakes.threadReads, reads);
  }).pipe(withMachine(fakes), Effect.provide(TestClock.layer()));
});

it.effect("the snapshot stream pushes only meaningful changes, at most every 5 s", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
    const seen: Array<number> = [];
    const fiber = yield* service.subscribe("board-a").pipe(
      Stream.runForEach((snapshot) => Effect.sync(() => void seen.push(snapshot.headroom.ramGiB))),
      Effect.forkChild,
    );
    yield* TestClock.adjust(1);
    assert.deepStrictEqual(seen, [64]);
    // 1 GiB less available RAM is under 5% of 64: not pushed.
    fakes.availableBytes = 63 * GiB;
    yield* TestClock.adjust(SNAPSHOT_INTERVAL_MS);
    assert.deepStrictEqual(seen, [64]);
    fakes.availableBytes = 40 * GiB;
    yield* TestClock.adjust(SNAPSHOT_INTERVAL_MS);
    assert.deepStrictEqual(seen, [64, 40]);
    // A small release is held back, but pushed once it has stood for a while.
    fakes.availableBytes = 41 * GiB;
    yield* TestClock.adjust(SNAPSHOT_INTERVAL_MS);
    assert.deepStrictEqual(seen, [64, 40]);
    yield* TestClock.adjust(SNAPSHOT_SETTLE_MS);
    assert.deepStrictEqual(seen, [64, 40, 41]);
    yield* Fiber.interrupt(fiber);
  }).pipe(withMachine(fakes), Effect.provide(TestClock.layer()));
});

it.effect("records and the last seq persist, reload, and go when the board is forgotten", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    const first = yield* makeBoardWorkerCapacity(portsOver(fakes));
    yield* first.service.syncCards("board-a", {
      seq: 9,
      authoritative: true,
      cards: [card("a-1")],
    });
    const saved = fakes.saved.get("board-a");
    assert.strictEqual(saved?.lastSeq, 9);
    const reloaded = yield* makeBoardWorkerCapacity(
      portsOver(fakes, {
        ...EMPTY_CAPACITY_STATE,
        records: saved?.records ?? [],
        lastSeq: new Map([["board-a", 9]]),
      }),
    );
    // A stale sync after the restart is still ignored.
    const stale = yield* reloaded.service.syncCards("board-a", {
      seq: 3,
      authoritative: false,
      cards: [],
    });
    assert.strictEqual(stale.lastSeq, 9);
    assert.lengthOf(reloaded.state().records, 1);
    // A board with no cards here is still one to forget when it leaves.
    yield* reloaded.service.syncCards("board-b", { seq: 1, authoritative: true, cards: [] });
    assert.sameMembers([...(yield* reloaded.service.boardIds)], ["board-a", "board-b"]);
    yield* reloaded.service.forgetBoard("board-a");
    yield* reloaded.service.forgetBoard("board-b");
    assert.isFalse(fakes.saved.has("board-a"));
    assert.lengthOf(reloaded.state().records, 0);
    assert.lengthOf(yield* reloaded.service.boardIds, 0);
  }).pipe(withMachine(fakes), Effect.provide(TestClock.layer()));
});

it.effect("the default disk counts the worktrees that were there, as they are measured", () => {
  const fakes = makeFakes();
  fakes.config = { "capacity.cpuCores": 16, "capacity.ramGiB": 64 };
  return Effect.gen(function* () {
    // At the first snapshot nothing is backfilled yet: 90% of the 1000 GB free is kept.
    const first = yield* makeBoardWorkerCapacity(portsOver(fakes));
    assert.strictEqual((yield* first.service.snapshot("board-a")).declared.diskGB, 900);
    const backfilled: CapacityRecord = {
      boardId: "board-a",
      cardId: "a-1",
      repositoryKey: null,
      branch: "board/a-1",
      worktreePath: "/w/a-1",
      profile: { cpuCores: 1, ramGiB: 1, diskGB: 5 },
      phase: "light",
      settled: true,
      seq: 1,
      diskFromMeasurement: true,
      measuredDiskGB: 120,
      measuredAt: 0,
      heavySince: null,
    };
    // Free space has since shrunk, but the stored part stands; the measured tree adds to it.
    fakes.freeDiskBytes = 10 * 1000 ** 3;
    const later = yield* makeBoardWorkerCapacity(
      portsOver(fakes, { ...EMPTY_CAPACITY_STATE, records: [backfilled] }),
    );
    const snapshot = yield* later.service.snapshot("board-a");
    assert.strictEqual(snapshot.declared.diskGB, 1020);
    assert.isFalse(snapshot.over.disk);
  }).pipe(withMachine(fakes), Effect.provide(TestClock.layer()));
});

it.effect("a disk measurement finishing after its board left doesn't bring it back", () => {
  const fakes = makeFakes();
  let duringDu: Effect.Effect<void> = Effect.void;
  return Effect.gen(function* () {
    const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
    yield* service.syncCards("board-a", {
      seq: 1,
      authoritative: true,
      cards: [card("a-1", { settled: false })],
    });
    duringDu = service.forgetBoard("board-a");
    yield* service.measure;
    assert.isFalse(fakes.saved.has("board-a"));
  }).pipe(
    Effect.provide(TestClock.layer()),
    Effect.provideService(BoardMachine, {
      cpuCount: Effect.succeed(32),
      totalMemoryBytes: Effect.succeed(128 * GiB),
      availableMemoryBytes: Effect.succeed(500 * GiB),
      agentSliceMemoryHighBytes: Effect.succeed(null),
      freeDiskBytes: () => Effect.succeed(1000 * 1000 ** 3),
      diskUsageBytes: () => Effect.suspend(() => duringDu).pipe(Effect.as(1000 ** 3)),
    }),
  );
});

it.effect("a provision whose claim expired is checked again as a fresh claim", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
    const claim = {
      claimId: "c1",
      seq: 1,
      cardId: "card-1",
      repositoryKey: null,
      profile: { cpuCores: 10, ramGiB: 8, diskGB: 20 },
      providerInstanceId: null,
    };
    assert.strictEqual(
      (yield* service.claim("board-a", { ...claim, kind: "placement" })).outcome,
      "granted",
    );
    yield* TestClock.adjust(61_000);
    // Meanwhile another board took the room.
    yield* service.syncCards("board-b", {
      seq: 1,
      authoritative: true,
      cards: [card("b-1", { grantedProfile: { cpuCores: 10, ramGiB: 8, diskGB: 20 } })],
    });
    const late = yield* service.checkProvision("board-a", claim);
    assert.deepInclude(late, { outcome: "denied", reason: "capacity" });
  }).pipe(withMachine(fakes), Effect.provide(TestClock.layer()));
});

it.effect(
  "holds across two boards: reserved, early start at half, the hold until consumed (T3O-87)",
  () =>
    Effect.gen(function* () {
      const fakes = makeFakes();
      fakes.config = { ...fakes.config, "capacity.cpuCores": 18, "hold.maxMinutes": 30 };
      const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
      // Board A fills 12 of 18 cores and 40 of 64 GiB.
      yield* service.syncCards("board-a", {
        seq: 1,
        authoritative: true,
        cards: [{ ...card("busy"), grantedProfile: { cpuCores: 12, ramGiB: 40, diskGB: 20 } }],
      });
      const big = { cpuCores: 8, ramGiB: 32, diskGB: 45 };
      const holdInput = {
        cardId: "t3o-90",
        repositoryKey: "github.com/acme/app",
        providerInstanceId: null,
        profile: big,
        kind: "placement" as const,
      };
      const claim = (boardId: string, cardId: string, extra: object = {}) =>
        service.claim(boardId, {
          claimId: `${cardId}:1`,
          seq: 2,
          cardId,
          repositoryKey: "github.com/acme/app",
          kind: "placement",
          profile: { cpuCores: 2, ramGiB: 4, diskGB: 5 },
          providerInstanceId: null,
          ...extra,
        });
      // Board B's big card can't fit: it holds the worker.
      const held = yield* service.hold("board-b", holdInput);
      assert.strictEqual(held.outcome, "held");
      // A held worker refuses every other placement, from any board, but grants force.
      const refused = yield* claim("board-a", "small");
      assert.isTrue(refused.outcome === "denied" && refused.reason === "reserved");
      assert.strictEqual((yield* claim("board-a", "forced", { force: true })).outcome, "granted");
      // Someone waits: the worker's status shows the hold ending at its own 30-minute limit.
      assert.strictEqual(
        (yield* service.status(new Set())).hold?.placement?.until,
        "1970-01-01T00:30:00.000Z",
      );
      // Board A sees the worker closed, with no card named; board B sees its own card.
      const seenByA = yield* service.snapshot("board-a");
      assert.deepStrictEqual(
        { closed: seenByA.hold?.closed, cardId: seenByA.hold?.cardId },
        { closed: true, cardId: null },
      );
      assert.strictEqual((yield* service.snapshot("board-b")).hold?.cardId, "t3o-90");
      // 4 cores and 24 GiB free: half of B's card (4 cores, 16 GiB) fits, so it starts early.
      const early = yield* service.claim("board-b", {
        claimId: "t3o-90:1",
        seq: 4,
        ...holdInput,
        kind: "placement",
        hold: true,
      });
      assert.strictEqual(early.outcome, "granted");
      // The grant leaves the hold in place until the provision consumes it.
      assert.strictEqual((yield* service.snapshot("board-b")).hold?.cardId, "t3o-90");
      yield* service.recordProvision(
        "board-b",
        {
          claimId: "t3o-90:1",
          seq: 5,
          cardId: "t3o-90",
          repositoryKey: "github.com/acme/app",
          profile: big,
          providerInstanceId: null,
        },
        { branch: "board/t3o-90", worktreePath: "/w/t3o-90" },
      );
      assert.isFalse((yield* service.snapshot("board-b")).hold?.closed ?? true);
      // The early start ran the worker over its declared capacity: it offers nothing.
      assert.isTrue((yield* service.snapshot("board-a")).over.cpuRam);
      // Taking turns: board B can't hold again while it is over; board A can.
      const again = yield* service.hold("board-b", { ...holdInput, cardId: "t3o-91" });
      assert.isTrue(again.outcome === "refused" && again.reason === "turn");
      assert.strictEqual(
        (yield* service.hold("board-a", {
          ...holdInput,
          cardId: "a-1",
          profile: { cpuCores: 2, ramGiB: 4, diskGB: 5 },
        })).outcome,
        "held",
      );
    }).pipe(Effect.provide(TestClock.layer()), (effect) => withMachine(makeFakes())(effect)),
);

it.effect("a worker over on CPU refuses a hold whose disk isn't really free", () => {
  const fakes = makeFakes();
  return Effect.gen(function* () {
    const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
    yield* service.syncCards("board-a", {
      seq: 1,
      authoritative: true,
      cards: [{ ...card("busy"), grantedProfile: { cpuCores: 20, ramGiB: 8, diskGB: 20 } }],
    });
    // 180 GB of the 200 declared are unheld, but only 10 GB are free on the volume.
    fakes.freeDiskBytes = 10 * 1000 ** 3;
    const asked = yield* service.hold("board-b", {
      cardId: "needs-disk",
      repositoryKey: "github.com/acme/app",
      providerInstanceId: null,
      profile: { cpuCores: 2, ramGiB: 4, diskGB: 45 },
      kind: "placement",
    });
    assert.isTrue(asked.outcome === "refused" && asked.reason === "disk");
  }).pipe(Effect.provide(TestClock.layer()), withMachine(fakes));
});

it.effect(
  "a later card's hold gives way to its board's earlier card only on a grant (T3O-87)",
  () =>
    Effect.gen(function* () {
      const fakes = makeFakes();
      fakes.config = { ...fakes.config, "capacity.cpuCores": 18 };
      const { service } = yield* makeBoardWorkerCapacity(portsOver(fakes));
      yield* service.syncCards("board-a", {
        seq: 1,
        authoritative: true,
        cards: [{ ...card("busy"), grantedProfile: { cpuCores: 12, ramGiB: 40, diskGB: 20 } }],
      });
      const held = yield* service.hold("board-a", {
        cardId: "later",
        repositoryKey: "github.com/acme/app",
        providerInstanceId: null,
        profile: { cpuCores: 8, ramGiB: 32, diskGB: 45 },
        kind: "placement",
      });
      assert.strictEqual(held.outcome, "held");
      const claim = (claimId: string, cpuCores: number) =>
        service.claim("board-a", {
          claimId,
          seq: 2,
          cardId: "earlier",
          repositoryKey: "github.com/acme/app",
          kind: "placement",
          profile: { cpuCores, ramGiB: 4, diskGB: 5 },
          providerInstanceId: null,
          replacesCardId: "later",
        });
      // Refused for capacity: the later card keeps the worker.
      assert.strictEqual((yield* claim("earlier:1", 18)).outcome, "denied");
      assert.strictEqual((yield* service.snapshot("board-a")).hold?.cardId, "later");
      // Granted: the later card's hold is gone with it.
      assert.strictEqual((yield* claim("earlier:2", 2)).outcome, "granted");
      assert.isNull((yield* service.snapshot("board-a")).hold?.cardId ?? null);
    }).pipe(Effect.provide(TestClock.layer()), (effect) => withMachine(makeFakes())(effect)),
);

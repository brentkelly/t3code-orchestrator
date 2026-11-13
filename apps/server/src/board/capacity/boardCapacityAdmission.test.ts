/**
 * The board's use of worker capacity (T3O-86): the phase rule, the cut-short, settling, a
 * turn the board didn't start, grows, what `syncCards` lists, and the upgrade's baselines.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  BoardStageId,
  EnvironmentId,
  ProviderInstanceId,
  type BoardCard,
  type BoardCardGrant,
  type BoardCardStepState,
  type BoardCommand,
  type BoardState,
  type BoardWorkerCapacitySnapshot,
  type BoardWorkerId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { buildingCard, projectId } from "../supervisorHarness.testkit.ts";
import {
  desiredHeavy,
  HEAVY_TAIL_MS,
  holdForDenial,
  makeBoardCapacityAdmission,
  SETTLE_AFTER_MS,
  syncEntriesFor,
  UNREACHABLE_BACKOFF_MS,
} from "./boardCapacityAdmission.ts";
import { upgradeBaseline } from "./boardCapacityUpgrade.ts";
import { makeFakeCapacity } from "./capacityClient.testkit.ts";

const T0 = Date.parse("2026-11-13T00:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const W1 = EnvironmentId.make("env-w1");

const grant = (overrides: Partial<BoardCardGrant> = {}): BoardCardGrant => ({
  profile: { cpuCores: 2, ramGiB: 4, diskGB: 5 },
  heavy: true,
  claimId: "c1",
  grantedAt: iso(T0),
  settled: false,
  ...overrides,
});

const granted = (id: string, overrides: Partial<BoardCardGrant> = {}): BoardCard => ({
  ...buildingCard(id, id),
  resources: { sizing: null, grant: grant(overrides), setup: null },
});

const step = (
  cardId: string,
  status: BoardCardStepState["status"],
  mode: BoardCardStepState["mode"] = "build",
): BoardCardStepState => ({
  cardId: BoardCardId.make(cardId),
  stepId: "building",
  stepLabel: null,
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "build it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode,
  runtimeMode: "full-access",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 60_000,
  threadId: null,
  status,
  slotHeld: false,
  forceStart: false,
  queuedBy: null,
  queuedDetail: null,
  startedAt: null,
  updatedAt: iso(T0),
});

/** The admission over a board Ref, folding `record-grant` the way the decider does. */
const harness = (initial: BoardState, now: { ms: number }, permission = false) =>
  Effect.gen(function* () {
    const board = yield* Ref.make(initial);
    const fake = yield* makeFakeCapacity(
      new Map([[BOARD_LOCAL_WORKER_ID, { cpuCores: 16, ramGiB: 64, diskGB: 200 }]]),
    );
    const commands: Array<BoardCommand> = [];
    const admission = makeBoardCapacityAdmission({
      client: fake.client,
      readBoard: Ref.get(board),
      dispatch: (command) =>
        Effect.gen(function* () {
          commands.push(command);
          if (command.type !== "board.card.record-grant") return true;
          yield* Ref.update(board, (current) => ({
            ...current,
            cards: current.cards.map((card) => {
              if (card.id !== command.cardId) return card;
              const before = card.resources?.grant ?? null;
              const next = {
                profile: command.profile ?? before!.profile,
                heavy: command.heavy ?? before?.heavy ?? false,
                claimId: before?.claimId ?? null,
                grantedAt: before?.grantedAt ?? iso(now.ms),
                settled: command.settled ?? before?.settled ?? false,
              };
              return {
                ...card,
                resources: {
                  sizing: card.resources?.sizing ?? null,
                  setup: card.resources?.setup ?? null,
                  grant: next,
                },
              };
            }),
          }));
          return true;
        }),
      commandId: (tag) => Effect.succeed(`cmd-${tag}` as BoardCommand["commandId"]),
      nowIso: Effect.sync(() => iso(now.ms)),
      repositoryKey: () => Effect.succeed("github.com/acme/app"),
      awaitingPermission: () => Effect.succeed(permission),
    });
    const grantOf = (id: string) =>
      Ref.get(board).pipe(
        Effect.map((current) => current.cards.find((card) => card.id === id)?.resources?.grant),
      );
    return { admission, board, fake, commands, grantOf };
  });

const boardWith = (
  cards: ReadonlyArray<BoardCard>,
  stepStates: ReadonlyArray<BoardCardStepState> = [],
): BoardState => ({ cards, nextCardNumberByProject: {}, stepStates });

it("the phase rule: heavy while active, for ten minutes after, and while queued if already heavy", () => {
  const card = granted("a");
  const base = { card, lastActiveAt: T0, now: T0 + HEAVY_TAIL_MS - 1 };
  assert.isTrue(desiredHeavy({ ...base, state: step("a", "running"), active: true }));
  assert.isTrue(desiredHeavy({ ...base, state: null, active: false }));
  assert.isFalse(desiredHeavy({ ...base, now: T0 + HEAVY_TAIL_MS, state: null, active: false }));
  // A queued step keeps a granted heavy phase…
  assert.isTrue(
    desiredHeavy({
      ...base,
      now: T0 + 2 * HEAVY_TAIL_MS,
      state: step("a", "queued"),
      active: false,
    }),
  );
  // …but never makes a light card heavy.
  assert.isFalse(
    desiredHeavy({
      ...base,
      card: granted("a", { heavy: false }),
      now: T0 + 2 * HEAVY_TAIL_MS,
      state: step("a", "queued"),
      active: false,
    }),
  );
});

it.effect(
  "a card waiting on a human goes light ten minutes after its step parked, in any stage",
  () =>
    Effect.gen(function* () {
      const now = { ms: T0 };
      for (const status of ["awaiting-input", "stalled", "paused"] as const) {
        const custom = { ...granted("a"), stage: BoardStageId.make("custom-stage") };
        const h = yield* harness(boardWith([custom], [step("a", status)]), now);
        yield* h.admission.sweep();
        assert.isTrue((yield* h.grantOf("a"))?.heavy, status);
        now.ms += HEAVY_TAIL_MS;
        yield* h.admission.sweep();
        assert.isFalse((yield* h.grantOf("a"))?.heavy, status);
        now.ms = T0;
      }
    }),
);

it.effect(
  "a running step stays heavy past ten minutes; one held on a permission prompt goes light",
  () =>
    Effect.gen(function* () {
      const now = { ms: T0 };
      const running = yield* harness(boardWith([granted("a")], [step("a", "running")]), now);
      yield* running.admission.sweep();
      now.ms += 3 * HEAVY_TAIL_MS;
      yield* running.admission.sweep();
      assert.isTrue((yield* running.grantOf("a"))?.heavy);

      now.ms = T0;
      const held = yield* harness(boardWith([granted("a")], [step("a", "running")]), now, true);
      yield* held.admission.sweep();
      now.ms += HEAVY_TAIL_MS;
      yield* held.admission.sweep();
      assert.isFalse((yield* held.grantOf("a"))?.heavy);
    }),
);

it.effect("the tail is cut short for an idle card when this board waits on capacity there", () =>
  Effect.gen(function* () {
    const now = { ms: T0 };
    const waiting = {
      ...step("b", "queued"),
      queuedBy: "capacity" as const,
      queuedDetail: { workerId: BOARD_LOCAL_WORKER_ID },
    };
    const h = yield* harness(
      boardWith(
        [granted("a"), granted("busy"), { ...buildingCard("b", "b"), worktree: null }],
        [step("busy", "running"), waiting],
      ),
      now,
    );
    yield* h.admission.sweep();
    // The idle card goes light at once; the running one is never evicted.
    assert.isFalse((yield* h.grantOf("a"))?.heavy);
    assert.isTrue((yield* h.grantOf("busy"))?.heavy);
  }),
);

it.effect("a Too-big card, or one queued behind another, evicts no idle card's tail", () =>
  Effect.gen(function* () {
    const now = { ms: T0 };
    for (const detail of [
      { workerId: BOARD_LOCAL_WORKER_ID, dimension: "cpu" as const, tooBig: true },
      { workerId: BOARD_LOCAL_WORKER_ID, behindCardId: BoardCardId.make("c") },
    ]) {
      const waiting = {
        ...step("b", "queued"),
        queuedBy: "capacity" as const,
        queuedDetail: detail,
      };
      const h = yield* harness(
        boardWith([granted("a"), { ...buildingCard("b", "b"), worktree: null }], [waiting]),
        now,
      );
      yield* h.admission.sweep();
      yield* h.admission.releaseForWaiting();
      assert.isTrue((yield* h.grantOf("a"))?.heavy, JSON.stringify(detail));
    }
  }),
);

it.effect("an unanswered claim costs a pass one timeout per worker, not one per candidate", () =>
  Effect.gen(function* () {
    const now = { ms: T0 };
    const fresh = (id: string) => ({ ...buildingCard(id, id), worktree: null });
    const h = yield* harness(boardWith([fresh("a"), fresh("b")]), now);
    yield* h.admission.syncAll();
    h.fake.unreachable.add(BOARD_LOCAL_WORKER_ID);
    const claim = (id: string) =>
      h.admission.placementClaim(fresh(id), BOARD_LOCAL_WORKER_ID, null, false);
    assert.strictEqual((yield* claim("a")).kind, "unavailable");
    assert.strictEqual((yield* claim("b")).kind, "unavailable");
    assert.strictEqual(h.fake.claims.length, 1);
    // Nor is it sent the board's cards: a sync would cost the pass another timeout.
    const syncs = h.fake.syncs.length;
    yield* h.admission.syncAll();
    assert.strictEqual(h.fake.syncs.length, syncs);
    // Once the backoff passes, the worker is asked again.
    h.fake.unreachable.clear();
    now.ms += UNREACHABLE_BACKOFF_MS;
    assert.strictEqual((yield* claim("b")).kind, "granted");
    assert.strictEqual(h.fake.claims.length, 2);
  }),
);

it.effect("a synced worker that leaves a sync unanswered is not sent another until the backoff", () =>
  Effect.gen(function* () {
    const now = { ms: T0 };
    const h = yield* harness(boardWith([granted("a")]), now);
    yield* h.admission.syncAll();
    h.fake.unreachable.add(BOARD_LOCAL_WORKER_ID);
    yield* Ref.update(h.board, (board) => ({ ...board, cards: [...board.cards, granted("b")] }));
    const syncs = h.fake.syncs.length;
    yield* h.admission.syncAll();
    assert.strictEqual(h.fake.syncs.length, syncs + 1);
    yield* h.admission.syncAll();
    assert.strictEqual(h.fake.syncs.length, syncs + 1);
    h.fake.unreachable.clear();
    now.ms += UNREACHABLE_BACKOFF_MS;
    yield* h.admission.syncAll();
    assert.strictEqual(h.fake.syncs.length, syncs + 2);
  }),
);

it.effect("a grant settles when its first heavy step ends, or two hours after placement", () =>
  Effect.gen(function* () {
    const now = { ms: T0 };
    const h = yield* harness(boardWith([granted("a"), granted("b")], [step("b", "running")]), now);
    yield* h.admission.noteStepEnded(step("a", "succeeded"));
    assert.isTrue((yield* h.grantOf("a"))?.settled);
    // A plan-mode step ran in no worktree: nothing settles.
    yield* h.admission.noteStepEnded(step("b", "succeeded", "plan"));
    assert.isFalse((yield* h.grantOf("b"))?.settled);
    now.ms += SETTLE_AFTER_MS;
    yield* h.admission.sweep();
    assert.isTrue((yield* h.grantOf("b"))?.settled);
  }),
);

it.effect("a turn the board didn't start makes a light card heavy with no claim", () =>
  Effect.gen(function* () {
    const now = { ms: T0 };
    const h = yield* harness(boardWith([granted("a", { heavy: false })]), now);
    yield* h.admission.recordUnstartedTurn(BoardCardId.make("a"), "thread-h");
    assert.isTrue((yield* h.grantOf("a"))?.heavy);
    assert.deepStrictEqual(h.fake.claims, []);
    // And the worker hears of it at once.
    assert.strictEqual(h.fake.syncs.at(-1)?.cards[0]?.phase, "heavy");
    // Still heavy while the turn runs, however long; the tail starts when it ends.
    now.ms += HEAVY_TAIL_MS * 2;
    yield* h.admission.sweep();
    assert.isTrue((yield* h.grantOf("a"))?.heavy);
    yield* h.admission.noteTurnEnded("thread-h");
    now.ms += HEAVY_TAIL_MS - 1;
    yield* h.admission.sweep();
    assert.isTrue((yield* h.grantOf("a"))?.heavy);
    now.ms += 1;
    yield* h.admission.sweep();
    assert.isFalse((yield* h.grantOf("a"))?.heavy);
  }),
);

it.effect("a size change reaches a placed card: grows in the background, shrinks at once", () =>
  Effect.gen(function* () {
    const now = { ms: T0 };
    const sized = (id: string, letter: "S" | "L", overrides: Partial<BoardCardGrant> = {}) => {
      const card = granted(id, overrides);
      return {
        ...card,
        resources: {
          ...card.resources!,
          sizing: {
            planner: null,
            edit: { size: { cpu: letter, ram: "M", disk: letter }, by: "human" },
          },
        },
      } as BoardCard;
    };
    const h = yield* harness(
      boardWith([
        sized("big", "L", { settled: true }),
        sized("small", "S"),
        sized("idle", "L", { heavy: false }),
      ]),
      now,
    );
    yield* h.admission.syncAll();
    // Another board holds the rest of the cores: the grow is refused, and nothing is queued.
    h.fake.external.set(BOARD_LOCAL_WORKER_ID, { cpuCores: 12, ramGiB: 0, diskGB: 0 });
    yield* h.admission.resizeGrants();
    // L is 2.5 cores; a settled record's disk is never regrown.
    assert.deepStrictEqual((yield* h.grantOf("big"))?.profile, {
      cpuCores: 2,
      ramGiB: 4,
      diskGB: 5,
    });
    assert.deepStrictEqual((yield* h.grantOf("small"))?.profile, {
      cpuCores: 1.5,
      ramGiB: 4,
      diskGB: 3.75,
    });
    // A light card holds no CPU: its next grow claims the larger profile.
    assert.deepStrictEqual((yield* h.grantOf("idle"))?.profile, {
      cpuCores: 2.5,
      ramGiB: 4,
      diskGB: 6.25,
    });
    // Room frees: the next pass grows it.
    h.fake.external.delete(BOARD_LOCAL_WORKER_ID);
    yield* h.admission.resizeGrants();
    assert.deepStrictEqual((yield* h.grantOf("big"))?.profile, {
      cpuCores: 2.5,
      ramGiB: 4,
      diskGB: 5,
    });
    assert.deepStrictEqual(
      h.fake.claims.map((claim) => [claim.cardId, claim.kind]),
      [
        ["big", "grow"],
        ["big", "grow"],
      ],
    );
  }),
);

it.effect(
  "a board-started step on a light card takes a grow claim first, at its granted profile",
  () =>
    Effect.gen(function* () {
      const now = { ms: T0 };
      const h = yield* harness(
        boardWith([granted("a", { heavy: false, profile: { cpuCores: 6, ramGiB: 8, diskGB: 5 } })]),
        now,
      );
      const card = (yield* Ref.get(h.board)).cards[0]!;
      assert.isNull(yield* h.admission.ensureHeavy(card, "codex", false));
      assert.deepStrictEqual(
        h.fake.claims.map((claim) => [claim.kind, claim.profile.cpuCores]),
        [["grow", 6]],
      );
      assert.isTrue((yield* h.grantOf("a"))?.heavy);
      // Heavy now: the next step needs nothing.
      const heavy = (yield* Ref.get(h.board)).cards[0]!;
      assert.isNull(yield* h.admission.ensureHeavy(heavy, "codex", false));
      assert.lengthOf(h.fake.claims, 1);
      // A worker with no room holds the step on capacity, but nothing is blocked behind it.
      h.fake.external.set(BOARD_LOCAL_WORKER_ID, { cpuCores: 15, ramGiB: 0, diskGB: 0 });
      const light = {
        ...heavy,
        resources: { sizing: null, setup: null, grant: grant({ heavy: false }) },
      };
      const hold = yield* h.admission.ensureHeavy(light, "codex", false);
      assert.deepInclude(hold, { queuedBy: "capacity", blocksWorker: false });
    }),
);

it("syncCards lists cards provisioning or ready with a grant on that worker, never a group", () => {
  const remote = { ...granted("r"), placedWorkerId: W1 };
  const group = {
    ...granted("g"),
    group: {
      target: "own",
      autoBuild: false,
      autoMerge: false,
      autoPlan: false,
      started: false,
      placed: null,
      prevStage: null,
      heading: false,
    },
  } as unknown as BoardCard;
  const ungranted = buildingCard("u", "u");
  const board = boardWith([granted("a"), remote, group, ungranted]);
  const local = syncEntriesFor({
    board,
    workerId: BOARD_LOCAL_WORKER_ID,
    repositoryKey: () => null,
  });
  assert.deepStrictEqual(
    local.map((entry) => entry.cardId),
    ["a"],
  );
  assert.deepStrictEqual(
    syncEntriesFor({ board, workerId: W1, repositoryKey: () => null }).map((entry) => entry.cardId),
    ["r"],
  );
});

it("a denial's hold: capacity blocks the worker for placements only", () => {
  assert.deepStrictEqual(holdForDenial({ reason: "capacity", dimension: "ram" }, W1, "placement"), {
    queuedBy: "capacity",
    detail: { workerId: W1, dimension: "ram" },
    blocksWorker: true,
  });
  assert.isFalse(holdForDenial({ reason: "capacity" }, W1, "grow").blocksWorker);
  assert.strictEqual(holdForDenial({ reason: "quota" }, W1, "placement").queuedBy, "quota");
  assert.strictEqual(holdForDenial({ reason: "not-ready" }, W1, "placement").queuedBy, "setup");
  // A failing readiness check needs a human; a check still running ends by itself.
  assert.deepStrictEqual(
    holdForDenial({ reason: "not-ready", detail: "not-ready" }, W1, "placement").detail,
    { workerId: W1, setupCause: "not-ready" },
  );
  assert.deepStrictEqual(
    holdForDenial({ reason: "not-ready", detail: "checking" }, W1, "placement").detail,
    { workerId: W1 },
  );
});

it("the upgrade's baseline keeps the old throttle: n builds still fit on each worker", () => {
  const snapshot = (cpuCores: number, ramGiB: number) =>
    ({
      at: iso(T0),
      declared: { cpuCores, ramGiB, diskGB: 500 },
      headroom: { cpuCores, ramGiB, diskGB: 500 },
      over: { cpuRam: false, disk: false },
      agents: { running: 0, max: null },
      providers: [],
      readiness: [],
      heavyCards: [],
    }) satisfies BoardWorkerCapacitySnapshot;
  const baseline = upgradeBaseline({
    concurrency: {
      perInstance: {},
      globalMaxConcurrent: 4,
      // `local` had its own limit of 2; W1 had none set, so it falls to the board's 4.
      workers: { local: { maxConcurrent: 2, perInstance: {} } },
    },
    snapshots: new Map<BoardWorkerId, BoardWorkerCapacitySnapshot>([
      [BOARD_LOCAL_WORKER_ID, snapshot(10, 40)],
      [W1, snapshot(32, 64)],
    ]),
  });
  // max(0.9 x 10 / 2, 0.9 x 32 / 4) cores; max(0.9 x 40 / 2, 0.9 x 64 / 4) GiB; disk placeholder.
  assert.deepStrictEqual(baseline, { cpuCores: 7.2, ramGiB: 18, diskGB: 5 });
  // n builds plus two planning threads (0.5 core, 1 GiB each) still fit on local.
  assert.isAtMost(2 * Math.min(baseline!.cpuCores, 4.5) + 1, 10);
  assert.isNull(
    upgradeBaseline({
      concurrency: { perInstance: {}, globalMaxConcurrent: 4, workers: {} },
      snapshots: new Map(),
    }),
  );
});

void projectId;

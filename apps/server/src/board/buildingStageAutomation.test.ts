/**
 * t3o-12 — Building stage automation acceptance suite.
 *
 * Building is the first fully-automated stage: a card entering Building (only by
 * the human "Begin build" gate, D18) has its recipe snapshotted, its worktree
 * provisioned, its build step spawned under the concurrency governor, and — on
 * the agent calling `board_complete_step` — makes the ONE board-driven crossing
 * this spec allows: Building → Code review. The machinery is assembled from
 * t3o-08..t3o-11; this suite proves the assembled behaviour end-to-end through
 * the LIVE reactor (the shared `withGovernor` harness runs the real decider +
 * projector against a stateful engine double, so every assertion is over the
 * board state a real dispatch would produce).
 *
 * The load-bearing invariant is D18: the board never advances a card across a
 * stage boundary on its own EXCEPT Building → Code review on build-step success.
 * These tests assert that directly — not by comment:
 *   - approving a plan (→ Ready) starts no build;
 *   - a card sitting in Ready is never swept into Building while other cards build;
 *   - Building → Code review DOES happen, automatically, on step success.
 * Plus D4 (a retried `board_complete_step` is a no-op, never a double transition)
 * at the assembled reactor level, and the governor bounding the acceptance gate's
 * "N cards against a maxConcurrent:2 instance" as a focused unit proof.
 *
 * The four live acceptance-gate items — killing a provider mid-build, restarting
 * the server mid-build, stalled-agent recovery, and ten real cards at
 * maxConcurrent:2 — need a watched run on a real repository and are NOT asserted
 * here (their decision logic is unit-tested in supervisor.test.ts /
 * supervisorReactor.test.ts / supervisorGovernor.test.ts).
 */
import { BoardCardId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  buildingCard,
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  settingsWith,
  stepCompleted,
  stepStatus,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

// ── A build that cannot be provisioned says so on the card ──────────────────
it.effect("a project that is not a git repository fails the card visibly, not silently", () =>
  withGovernor(
    {
      // No worktree yet: this is a card taking its FIRST run at Building, the
      // path that resolves the base branch before anything is provisioned.
      board: {
        cards: [makeBoardCard({ id: "card-1", stage: "building", orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      notAGitRepo: true,
    },
    ({ slots, pumpDomain, board, decided }) =>
      Effect.gen(function* () {
        yield* pumpDomain(
          movedToBuilding(makeBoardCard({ id: "card-1", stage: "building", orderKey: "m" }), 1),
        );

        // The card cannot build — no worktree, so no thread and no slot.
        assert.strictEqual((yield* board).cards[0]?.worktree, null);
        assert.strictEqual(yield* slots.heldTotal, 0);

        // But it SAYS so: the failure is decided as a card event (which the
        // projection turns into the activity rail's "could not prepare the
        // worktree" row), naming the workspace and why. Before this, the
        // decider rejected the report — the card just sat in Building with
        // nothing running and the only trace was a server-side warning.
        const failures = (yield* decided).filter(
          (event) => event.type === "board.card-worktree-failed",
        );
        // Exactly one row per click: the reason is reported once, by the
        // single provisioning pass `schedule` owns.
        assert.strictEqual(failures.length, 1);
        const error = String(
          (failures[0]?.payload as { readonly error?: unknown } | undefined)?.error,
        );
        assert.include(error, "/tmp/project-1");
        assert.match(error, /not a git repository/);
      }),
  ),
);

// ── D18: Building → Code review on build-step success (the one board-driven
//    crossing) ─────────────────────────────────────────────────────────────
it.effect("D18: a successful build step advances Building → Code review", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("card-1", "m")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");

        // The human "Begin build" gate (Ready → Building) starts the step.
        yield* pumpDomain(movedToBuilding(buildingCard("card-1", "m"), 1));
        assert.strictEqual(stepStatus(yield* board, id), "running");
        // Still in Building while the step runs — no premature advance.
        assert.strictEqual(cardStage(yield* board, id), "building");

        // The agent calls board_complete_step(succeeded) → the board makes its
        // one automatic crossing, and the slot is released.
        yield* pumpDomain(stepCompleted(id, "succeeded", 2));
        assert.strictEqual(cardStage(yield* board, id), "review");
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

// ── D18: approving a plan lands a card in Ready and starts NO build ──────────
it.effect("D18: approving a plan (→ Ready) starts no build — Ready is a resting state", () =>
  withGovernor(
    {
      board: {
        cards: [makeBoardCard({ id: "card-1", stage: "planning", orderKey: "m" })],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");

        // "Approve plan" is the Planning → Ready human gate. The supervisor
        // reacts only to a move INTO Building, so this must select no step and
        // hold no slot: a plan can be approved without a single build starting.
        yield* pumpDomain(
          cardMoved(
            makeBoardCard({ id: "card-1", stage: "ready", orderKey: "m" }),
            "planning",
            "ready",
            1,
          ),
        );
        assert.strictEqual(stepStatus(yield* board, id), null);
        assert.strictEqual(yield* slots.heldTotal, 0);
      }),
  ),
);

// ── D18: a card in Ready never auto-advances into Building ───────────────────
it.effect("D18: a Ready card is never swept into Building while other cards build", () =>
  withGovernor(
    {
      board: {
        // `resting` sits in Ready; `builder` is under the Begin-build gate.
        cards: [
          makeBoardCard({ id: "resting", stage: "ready", orderKey: "a" }),
          buildingCard("builder", "b"),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        const resting = BoardCardId.make("resting");
        const builder = BoardCardId.make("builder");

        // A real build starts for the gated card — the reactor is live...
        yield* pumpDomain(movedToBuilding(buildingCard("builder", "b"), 1));
        assert.strictEqual(stepStatus(yield* board, builder), "running");

        // ...yet the Ready card is untouched: no step, no slot, still Ready.
        // Nothing auto-advances a Ready card into Building (D18).
        assert.strictEqual(stepStatus(yield* board, resting), null);
        assert.strictEqual(cardStage(yield* board, resting), "ready");
        assert.strictEqual(yield* slots.heldTotal, 1);
      }),
  ),
);

// ── D4: a retried board_complete_step is a no-op, never a double transition ──
it.effect("D4: a double build-step completion advances once and never double-releases", () =>
  withGovernor(
    {
      board: { cards: [buildingCard("card-1", "m")], nextCardNumberByProject: {} },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(movedToBuilding(buildingCard("card-1", "m"), 1));

        // First completion: advance to review, release the slot.
        yield* pumpDomain(stepCompleted(id, "succeeded", 2));
        assert.strictEqual(cardStage(yield* board, id), "review");
        assert.strictEqual(yield* slots.heldTotal, 0);

        // The agent retries board_complete_step on a timeout: the second
        // completion is a no-op — no second advance, no negative slot count.
        yield* pumpDomain(stepCompleted(id, "succeeded", 3));
        assert.strictEqual(cardStage(yield* board, id), "review"); // advanced exactly once
        assert.strictEqual(yield* slots.heldTotal, 0); // not driven below zero
      }),
  ),
);

// ── D11: the governor bounds concurrent builds and runs the queue in order ───
//    The acceptance gate's "ten cards vs maxConcurrent:2" needs a watched run;
//    this is its focused unit proof — the bounding and ordering are the same
//    logic at any N.
it.effect("D11: at maxConcurrent 2, two cards build and the rest queue in order", () =>
  withGovernor(
    {
      board: {
        cards: [
          buildingCard("card-a", "a"),
          buildingCard("card-b", "b"),
          buildingCard("card-c", "c"),
          buildingCard("card-d", "d"),
          buildingCard("card-e", "e"),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({
        building: [codexStep],
        globalMaxConcurrent: 10,
        perInstance: { codex: 2 },
      }),
    },
    ({ slots, pumpDomain, board }) =>
      Effect.gen(function* () {
        // Five cards enter Building in order a..e; only two codex slots exist.
        for (const [index, key] of ["a", "b", "c", "d", "e"].entries()) {
          yield* pumpDomain(movedToBuilding(buildingCard(`card-${key}`, key), index + 1));
        }

        const after = yield* board;
        // Exactly two run (the first two by drag order); the rest hold in the
        // queue — the Building column IS the queue (D11).
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-a")), "running");
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-b")), "running");
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-c")), "queued");
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-d")), "queued");
        assert.strictEqual(stepStatus(after, BoardCardId.make("card-e")), "queued");
        assert.strictEqual(yield* slots.heldTotal, 2);

        // card-a finishes → its freed slot flows to the NEXT queued card by
        // order (card-c), never past it; the ceiling still holds at two.
        yield* pumpDomain(stepCompleted(BoardCardId.make("card-a"), "succeeded", 6));
        const promoted = yield* board;
        assert.strictEqual(cardStage(promoted, BoardCardId.make("card-a")), "review");
        assert.strictEqual(stepStatus(promoted, BoardCardId.make("card-b")), "running");
        assert.strictEqual(stepStatus(promoted, BoardCardId.make("card-c")), "running");
        assert.strictEqual(stepStatus(promoted, BoardCardId.make("card-d")), "queued");
        assert.strictEqual(stepStatus(promoted, BoardCardId.make("card-e")), "queued");
        assert.strictEqual(yield* slots.heldTotal, 2);
      }),
  ),
);

/**
 * Auto-merge (T3O-38): an armed card merges its own pull request as soon as
 * the forge accepts it, and a refused merge climbs a classified retry ladder
 * instead of parking the card until someone notices.
 *
 * Driven through the live reactor against the stateful engine double
 * (`withGovernor`), because the behaviour spans the arrival gate, the real
 * decider's arm and hold commands, the forge seam and the 30s tick. The engine
 * double decides every dispatched command with the production decider, so a
 * hold this suite says the card carries is one the decider really recorded.
 *
 * Nothing here sleeps or polls: the sweep is driven by calling the reactor's
 * own `fireAutoMerges` hook, exactly as the auto-start suite drives
 * `startArmed`, and the clock is advanced with `TestClock` where a rung has to
 * come due.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  type BoardCard,
  type BoardCardAutoMergeHold,
  type BoardState,
  type ChangeRequestMergeState,
  type OrchestrationCommand,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import {
  cardAutoMergeUpdated,
  cardMoved,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

/** Enough to clear the ladder's first rung (3 minutes) past its ±60s jitter,
    and not enough to reach the second. The rung is DELIVERED by the existing
    30s supervisor tick, so advancing the clock is the whole of the drive. */
const RUNG_ONE = Duration.minutes(4);

const READY = String(BOARD_SEED_STAGE_IDS.ready);
const REVIEW = String(BOARD_SEED_STAGE_IDS.review);
const BUILDING = String(BOARD_SEED_STAGE_IDS.building);
const MERGE = String(BOARD_SEED_STAGE_IDS.merge);
const DONE = String(BOARD_SEED_STAGE_IDS.done);

const openPr: VcsStatusChangeRequest = {
  number: 284,
  title: "Services index page",
  url: "https://example.test/pull/284",
  baseRef: "main",
  headRef: "board/card-one",
  state: "open",
};

/** A top-level card sitting at the merge stage with a ready worktree. */
const cardAtMerge = (input: { readonly autoMerge?: boolean; readonly id?: string } = {}) =>
  makeBoardCard({
    id: input.id ?? "card-one",
    stage: MERGE,
    orderKey: "m",
    worktree: readyWorktree(input.id ?? "card-one"),
    ...(input.autoMerge === undefined ? {} : { autoMerge: input.autoMerge }),
  });

const probe = (input: {
  readonly passed?: number;
  readonly pending?: number;
  readonly failed?: number;
  readonly mergeable?: "mergeable" | "blocked" | "unknown";
  readonly blockedReason?: ChangeRequestMergeState["blockedReason"];
  readonly headSha?: string;
}): ChangeRequestMergeState => {
  const passed = input.passed ?? 0;
  const pending = input.pending ?? 0;
  const failed = input.failed ?? 0;
  return {
    mergeable: input.mergeable ?? "blocked",
    blockedReason: input.blockedReason ?? null,
    checks: {
      total: passed + pending + failed,
      passed,
      pending,
      failed,
      failing: failed > 0 ? ["ci/test"] : [],
      running: pending > 0 ? ["ci/build"] : [],
    },
    headSha: input.headSha ?? "sha-one",
  };
};

const setup = (input: {
  readonly cards: ReadonlyArray<BoardCard>;
  readonly boardWideAutoMerge?: boolean;
  readonly mergeFailure?: string;
  readonly mergeOutcomes?: ReadonlyArray<string | null>;
  readonly mergeState?: ChangeRequestMergeState;
}) => ({
  board: { cards: input.cards, nextCardNumberByProject: {} },
  settings: settingsWith({
    building: [codexStep],
    globalMaxConcurrent: 3,
    ...(input.boardWideAutoMerge === undefined
      ? {}
      : { merge: { autoMerge: input.boardWideAutoMerge } }),
  }),
  pullRequest: openPr,
  ...(input.mergeFailure === undefined ? {} : { mergeFailure: input.mergeFailure }),
  ...(input.mergeOutcomes === undefined ? {} : { mergeOutcomes: input.mergeOutcomes }),
  ...(input.mergeState === undefined ? {} : { mergeState: input.mergeState }),
});

const holdOf = (board: BoardState, id = "card-one"): BoardCardAutoMergeHold | null =>
  board.cards.find((card) => card.id === BoardCardId.make(id))?.autoMergeHold ?? null;

const stageOf = (board: BoardState, id = "card-one"): string | null =>
  String(board.cards.find((card) => card.id === BoardCardId.make(id))?.stage ?? "") || null;

const mergeRefusedNotes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command) => command.type === "board.card.record-note" && command.kind === "card-merge-refused",
  );

// ── Arming ────────────────────────────────────────────────────────────────

it.effect("merges a per-card-armed card on its ordinary arrival at the merge stage", () =>
  withGovernor(setup({ cards: [cardAtMerge({ autoMerge: true })] }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
      assert.deepStrictEqual(yield* h.mergeAttempts, [{ number: 284 }]);
      assert.strictEqual(stageOf(yield* h.board), DONE);
      // The happy path costs ONE forge call: the probe is only ever asked
      // after a refusal.
      assert.deepStrictEqual(yield* h.mergeStateProbes, []);
    }),
  ),
);

it.effect("leaves an UNARMED card parked for a human click", () =>
  withGovernor(setup({ cards: [cardAtMerge()] }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(cardAtMerge(), REVIEW, MERGE, 1));
      assert.deepStrictEqual(yield* h.mergeAttempts, []);
      assert.strictEqual(stageOf(yield* h.board), MERGE);
    }),
  ),
);

it.effect("merges an unflagged card when the BOARD-WIDE setting is on", () =>
  withGovernor(setup({ cards: [cardAtMerge()], boardWideAutoMerge: true }), (h) =>
    Effect.gen(function* () {
      yield* h.pumpDomain(cardMoved(cardAtMerge(), REVIEW, MERGE, 1));
      assert.deepStrictEqual(yield* h.mergeAttempts, [{ number: 284 }]);
      assert.strictEqual(stageOf(yield* h.board), DONE);
    }),
  ),
);

it.effect("switching the board-wide setting on merges NO card already parked there (D2)", () =>
  withGovernor(setup({ cards: [cardAtMerge()], boardWideAutoMerge: true }), (h) =>
    Effect.gen(function* () {
      // The setting is already on and the card is already here — no arrival,
      // no merge. Flipping a board-wide default is policy for what happens
      // NEXT; eleven irreversible forge operations from one toggle is not a
      // default, it is an accident.
      yield* h.reactor.fireAutoMerges;
      yield* h.reactor.drain;
      assert.deepStrictEqual(yield* h.mergeAttempts, []);
      assert.strictEqual(stageOf(yield* h.board), MERGE);
    }),
  ),
);

it.effect("does not auto-merge a card DRAGGED non-adjacently onto the merge stage (D2)", () =>
  withGovernor(setup({ cards: [cardAtMerge()], boardWideAutoMerge: true }), (h) =>
    Effect.gen(function* () {
      // Building → Merge skips review. A blanket policy must not merge a diff
      // no review round ever saw.
      yield* h.pumpDomain(cardMoved(cardAtMerge(), BUILDING, MERGE, 1));
      assert.deepStrictEqual(yield* h.mergeAttempts, []);
      assert.strictEqual(stageOf(yield* h.board), MERGE);
    }),
  ),
);

it.effect("does not re-merge a card a human pulled BACK out of Done", () =>
  withGovernor(setup({ cards: [cardAtMerge({ autoMerge: true })] }), (h) =>
    Effect.gen(function* () {
      // A backward drag is an UNDO, and answering it by re-merging on the
      // forge is surprising at best.
      yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), DONE, MERGE, 1));
      assert.deepStrictEqual(yield* h.mergeAttempts, []);
    }),
  ),
);

it.effect("merges IMMEDIATELY when the arm is toggled on for a card already parked (D3)", () =>
  withGovernor(setup({ cards: [cardAtMerge()] }), (h) =>
    Effect.gen(function* () {
      // Morally identical to clicking Merge. A control that visibly does
      // nothing to the card in front of you is the complaint this fixes — and
      // it deliberately bypasses the adjacency guard, because a human pointing
      // at one card is not a blanket policy.
      yield* h.pumpDomain(cardAutoMergeUpdated(cardAtMerge(), true, 1));
      assert.deepStrictEqual(yield* h.mergeAttempts, [{ number: 284 }]);
      assert.strictEqual(stageOf(yield* h.board), DONE);
    }),
  ),
);

it.effect("does not merge on an unrelated edit to an armed card parked at merge", () =>
  withGovernor(setup({ cards: [cardAtMerge({ autoMerge: true })] }), (h) =>
    Effect.gen(function* () {
      // Keyed on the payload MARKER, not on the card's state: a title edit on
      // an armed card must never fire a merge.
      const card = cardAtMerge({ autoMerge: true });
      yield* h.pumpDomain({
        type: "board.card-updated",
        sequence: 1,
        payload: { cardId: card.id, card: { ...card, title: "Renamed" } },
      } as never);
      assert.deepStrictEqual(yield* h.mergeAttempts, []);
    }),
  ),
);

it.effect("skips a BLOCKED card silently — no attempt, no rung, no hold (D8)", () =>
  withGovernor(
    setup({
      cards: [
        {
          ...cardAtMerge({ autoMerge: true }),
          blocked: true,
          dependsOn: [BoardCardId.make("dep")],
        },
        makeBoardCard({ id: "dep", stage: BUILDING, orderKey: "b" }),
      ],
    }),
    (h) =>
      Effect.gen(function* () {
        const card = {
          ...cardAtMerge({ autoMerge: true }),
          blocked: true,
          dependsOn: [BoardCardId.make("dep")],
        };
        yield* h.pumpDomain(cardMoved(card, REVIEW, MERGE, 1));
        // The card already wears the amber blocked callout naming the unmet
        // dependency; a second amber pill making a different claim about the
        // same card is worse than nothing.
        assert.deepStrictEqual(yield* h.mergeAttempts, []);
        assert.strictEqual(holdOf(yield* h.board), null);
      }),
  ),
);

// ── The ladder ────────────────────────────────────────────────────────────

it.effect("holds soft on a pending check and merges on the rung where the forge accepts", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      // Refused twice, then accepted.
      mergeOutcomes: ["Required status check 'test' has not passed.", "Still not passed."],
      mergeState: probe({ passed: 3, pending: 2 }),
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        const first = holdOf(yield* h.board);
        assert.strictEqual(first?.classification, "soft");
        assert.strictEqual(first?.attempt, 1);
        assert.strictEqual(first?.detail, "3 of 5 checks green · ci/build still running");
        assert.notStrictEqual(first?.retryAt, null);
        assert.strictEqual(stageOf(yield* h.board), MERGE);

        // Rung one is three minutes out (jittered by up to a minute), and it
        // is DELIVERED by the existing 30s supervisor tick — no new fiber, and
        // no hook a test has to call that production does not.
        yield* h.reactor.fireAutoMerges;
        yield* h.reactor.drain;
        assert.strictEqual((yield* h.mergeAttempts).length, 1);

        yield* TestClock.adjust(RUNG_ONE);
        yield* h.reactor.drain;
        assert.strictEqual((yield* h.mergeAttempts).length, 2);
        const second = holdOf(yield* h.board);
        assert.strictEqual(second?.attempt, 2);
        // The clock measures the WHOLE wait, not the time since the last try.
        assert.strictEqual(second?.heldSince, first?.heldSince);

        yield* TestClock.adjust(RUNG_ONE);
        yield* h.reactor.drain;
        assert.strictEqual((yield* h.mergeAttempts).length, 3);
        assert.strictEqual(stageOf(yield* h.board), DONE);
        // The hold is cleared by the merge that landed: a hold about a merge
        // that already happened is a stale label.
        assert.strictEqual(holdOf(yield* h.board), null);
      }),
  ),
);

it.effect("stops the ladder on the FIRST refusal when a required check failed (D6)", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      mergeFailure: "Required status check 'test' is failing.",
      mergeState: probe({ passed: 3, failed: 1 }),
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        const hold = holdOf(yield* h.board);
        assert.strictEqual(hold?.classification, "checks-failed");
        assert.strictEqual(hold?.attempt, 1);
        // A hard block is visible within minutes of the first refusal rather
        // than after an hour and a half of a pill that claimed to be waiting.
        assert.strictEqual(hold?.retryAt, null);
        // And it is never polled again, however far the clock runs.
        yield* TestClock.adjust(Duration.hours(4));
        yield* h.reactor.drain;
        assert.strictEqual((yield* h.mergeAttempts).length, 1);
        // One rail row, at the moment the ladder actually stopped.
        assert.strictEqual(mergeRefusedNotes(yield* h.commands).length, 1);
      }),
  ),
);

it.effect("stops on a block with every check green — that is a decision, not a wait", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      mergeFailure: "At least 1 approving review is required.",
      mergeState: probe({ passed: 4 }),
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        const hold = holdOf(yield* h.board);
        assert.strictEqual(hold?.classification, "approval-required");
        assert.strictEqual(hold?.retryAt, null);
      }),
  ),
);

it.effect("gives a provider with NO probe the plain ladder rather than an error (D7)", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      mergeFailure: "Pull request is not mergeable.",
      // No `mergeState`: the probe FAILS, exactly as an unsupported provider
      // does. Unclassifiable must degrade to soft, never to a hard verdict.
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        const hold = holdOf(yield* h.board);
        assert.strictEqual(hold?.classification, "soft");
        assert.notStrictEqual(hold?.retryAt, null);
        assert.strictEqual(hold?.detail, null);
      }),
  ),
);

it.effect("walks all eight attempts and then keeps the exhausted hold (D5/D10)", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      mergeFailure: "Required status check 'test' has not passed.",
      mergeState: probe({ passed: 1, pending: 1 }),
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        // The whole ladder is 3+3+5+5+10+20+40 = 86 minutes, jittered by up to
        // a minute each way; two hours clears every rung with room to spare.
        yield* TestClock.adjust(Duration.hours(2));
        yield* h.reactor.drain;
        assert.strictEqual((yield* h.mergeAttempts).length, 8);
        const hold = holdOf(yield* h.board);
        assert.strictEqual(hold?.attempt, 8);
        // KEPT, not cleared: the card must go on saying why it stopped.
        assert.strictEqual(hold?.retryAt, null);
        assert.strictEqual(hold?.classification, "soft");
        assert.strictEqual(mergeRefusedNotes(yield* h.commands).length, 1);

        // And it stays stopped.
        yield* TestClock.adjust(Duration.hours(6));
        yield* h.reactor.drain;
        assert.strictEqual((yield* h.mergeAttempts).length, 8);
      }),
  ),
);

it.effect("climbs the ladder on the SAME head sha, recording it each rung (D9)", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      mergeFailure: "Required status check 'test' has not passed.",
      mergeState: probe({ passed: 1, pending: 1 }),
    }),
    (h) =>
      Effect.gen(function* () {
        // The reset itself is a pure decision, exercised exhaustively in
        // `autoMergeClassification.test.ts`; what the reactor has to get right
        // is that it records the sha every probe answers, so the next rung has
        // something to compare against.
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        assert.strictEqual(holdOf(yield* h.board)?.headSha, "sha-one");
        yield* TestClock.adjust(RUNG_ONE);
        yield* h.reactor.drain;
        assert.strictEqual(holdOf(yield* h.board)?.attempt, 2);
        assert.strictEqual(holdOf(yield* h.board)?.headSha, "sha-one");
      }),
  ),
);

// ── Reverse states ────────────────────────────────────────────────────────

it.effect("clears the hold when the arm is switched off (D10)", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      mergeFailure: "Required status check 'test' has not passed.",
      mergeState: probe({ passed: 1, pending: 1 }),
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        assert.notStrictEqual(holdOf(yield* h.board), null);
        const held = (yield* h.board).cards.find(
          (card) => card.id === BoardCardId.make("card-one"),
        );
        assert.isDefined(held);
        // The clear itself is the DECIDER's (asserted in `decider.board.test`);
        // what the reactor owes is that a disarmed card stops retrying. The
        // event carries the card exactly as the decider leaves it.
        yield* h.pumpDomain(cardAutoMergeUpdated({ ...held!, autoMergeHold: null }, false, 2));
        assert.strictEqual(holdOf(yield* h.board), null);
        yield* TestClock.adjust(Duration.hours(2));
        yield* h.reactor.drain;
        assert.strictEqual((yield* h.mergeAttempts).length, 1);
      }),
  ),
);

it.effect("clears the hold when the card leaves the merge stage (D10)", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      mergeFailure: "Required status check 'test' has not passed.",
      mergeState: probe({ passed: 1, pending: 1 }),
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        assert.notStrictEqual(holdOf(yield* h.board), null);
        const held = (yield* h.board).cards.find(
          (card) => card.id === BoardCardId.make("card-one"),
        );
        assert.isDefined(held);
        // A card sitting in review wearing "Merge held" is a stale label.
        yield* h.pumpDomain(
          cardMoved({ ...held!, stage: BOARD_SEED_STAGE_IDS.review }, MERGE, REVIEW, 2),
        );
        assert.strictEqual(holdOf(yield* h.board), null);
      }),
  ),
);

it.effect("a human Merge click resets the ladder to rung 0 (D10/D11)", () =>
  withGovernor(
    setup({
      cards: [cardAtMerge({ autoMerge: true })],
      mergeFailure: "Required status check 'test' has not passed.",
      mergeState: probe({ passed: 1, pending: 1 }),
    }),
    (h) =>
      Effect.gen(function* () {
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        yield* TestClock.adjust(RUNG_ONE);
        yield* h.reactor.drain;
        assert.strictEqual(holdOf(yield* h.board)?.attempt, 2);

        // The button is live throughout a hold — nothing is running, and
        // clicking is the escape hatch.
        const outcome = yield* h.reactor.mergePullRequest(BoardCardId.make("card-one"));
        assert.strictEqual(outcome.outcome, "refused");
        yield* h.reactor.drain;
        assert.strictEqual(holdOf(yield* h.board)?.attempt, 1);
      }),
  ),
);

// ── The whole point: an unattended dependency clears itself (D15) ──────────

it.effect("an armed dependency merges itself and starts its armed dependent", () =>
  withGovernor(
    {
      board: {
        cards: [
          cardAtMerge({ autoMerge: true }),
          makeBoardCard({
            id: "dependent",
            stage: READY,
            orderKey: "n",
            autoStart: true,
            dependsOn: ["card-one"],
          }),
        ],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
      pullRequest: openPr,
    },
    (h) =>
      Effect.gen(function* () {
        // The card this whole feature exists for: you arm the dependency, go
        // to bed, and the chain resolves without you. Before T3O-38 the
        // dependency parked at Merge waiting for a click and the dependent
        // was still sitting in Ready in the morning.
        yield* h.pumpDomain(cardMoved(cardAtMerge({ autoMerge: true }), REVIEW, MERGE, 1));
        assert.strictEqual(stageOf(yield* h.board), DONE);

        // D15, pinned through the REAL merge path rather than by mocking the
        // ordering. Read BEFORE the Done arrival is delivered: the local base
        // branch has already been fast-forwarded by the time the card reaches
        // Done, so anything the Done arrival starts — the armed dependent —
        // cuts from history that already contains the dependency's commits.
        // Break that ordering and you silently produce agents that cannot see
        // the code they depend on.
        const gitBeforeDone = yield* h.gitInvocations;
        assert.isTrue(
          gitBeforeDone.some(
            (args) => args[0] === "fetch" || (args[0] === "pull" && args[1] === "--ff-only"),
          ),
          `the merged base branch was not synced before Done: ${JSON.stringify(gitBeforeDone)}`,
        );

        // The engine double decides and projects a dispatched command but does
        // not feed its event back into the domain queue, so the Done arrival
        // is handed over here — exactly as the auto-start suite does. In
        // production the reactor's own dispatch loops back through the
        // projection pipeline.
        const merged = (yield* h.board).cards.find(
          (card) => card.id === BoardCardId.make("card-one"),
        );
        assert.isDefined(merged);
        yield* h.pumpDomain(cardMoved(merged!, MERGE, DONE, 2));
        assert.strictEqual(stageOf(yield* h.board, "dependent"), BUILDING);
      }),
  ),
);

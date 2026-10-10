/**
 * A build step whose branch cannot be prepared parks where a human can see it
 * (T3O-15), against the LIVE reactor.
 *
 * The reported card: a split child (PLA-10) moved into Building with its
 * parent, whose repository had no commits, so the parent's integration branch
 * could never be cut and the child had no base. The child's step sat `pending`
 * — no thread, not queued, not stalled — so the card looked idle in Building,
 * the only trace was an activity row saying "the parent card has no branch
 * yet", and every scheduling pass added another identical row.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  boardCardStepState,
  type BoardCard,
  type OrchestrationCommand,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  cardMoved,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  settingsWith,
  stepRequeued,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const building = String(BOARD_SEED_STAGE_IDS.building);
const settings = settingsWith({ building: [codexStep], globalMaxConcurrent: 3 });

const card = (id: string, extra: Partial<BoardCard> = {}): BoardCard => ({
  ...makeBoardCard({ id, stage: building, orderKey: "m" }),
  ...extra,
});

const parent = card("pla-1");
const child = card("pla-10", { parentCardId: BoardCardId.make("pla-1") });
const childId = BoardCardId.make("pla-10");

const worktreeFailures = (events: ReadonlyArray<OrchestrationEvent>, cardId: string) =>
  events.filter(
    (event) =>
      event.type === "board.card-worktree-failed" && String(event.payload.cardId) === cardId,
  );

const threadCreates = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "thread.create");

it.effect("a card in a repository with no commits parks stalled and says how to fix it", () =>
  withGovernor(
    {
      board: { cards: [card("card-1")], nextCardNumberByProject: {} },
      settings,
      unbornBranch: "main",
    },
    ({ pumpDomain, board, slots, commands }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(card("card-1"), 1));

        const state = boardCardStepState(yield* board, BoardCardId.make("card-1"));
        assert.strictEqual(state?.status, "stalled");
        assert.strictEqual(state?.stalledReason, "no-worktree");
        assert.include(state?.lastError ?? "", "has no commits yet");
        assert.include(state?.lastError ?? "", "Make a first commit on 'main'");
        // Nothing ran, so nothing was spent and nothing is held.
        assert.strictEqual(state?.stageEntryRecoveries, 0);
        assert.strictEqual(state?.attempt, 1);
        assert.strictEqual(yield* slots.heldTotal, 0);
        assert.strictEqual(threadCreates(yield* commands).length, 0);
      }),
  ),
);

it.effect("a split child whose parent has no integration branch names the parent's cause", () =>
  withGovernor(
    {
      board: { cards: [parent, child], nextCardNumberByProject: {} },
      settings,
      unbornBranch: "main",
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(child, 1));

        const state = boardCardStepState(yield* board, childId);
        assert.strictEqual(state?.status, "stalled");
        assert.strictEqual(state?.stalledReason, "no-worktree");
        const error = state?.lastError ?? "";
        assert.include(error, "The parent card PLA-1 has no integration branch");
        assert.include(error, "has no commits yet");
      }),
  ),
);

it.effect("a parked card is not re-failed by every later scheduling pass", () =>
  withGovernor(
    {
      board: { cards: [parent, child, card("other")], nextCardNumberByProject: {} },
      settings,
      unbornBranch: "main",
    },
    ({ pumpDomain, decided }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(child, 1));
        assert.strictEqual(worktreeFailures(yield* decided, "pla-10").length, 1);

        // Another card entering Building runs a scheduling pass. Before T3O-15
        // the still-pending child re-failed into a second identical row here.
        yield* pumpDomain(movedToBuilding(card("other"), 2));
        assert.strictEqual(worktreeFailures(yield* decided, "pla-10").length, 1);
      }),
  ),
);

it.effect("Continue after the first commit provisions the branch and starts the build", () =>
  withGovernor(
    {
      board: { cards: [parent, child], nextCardNumberByProject: {} },
      settings,
      unbornBranch: "main",
    },
    ({ pumpDomain, board, commands, makeFirstCommit }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(child, 1));
        const parked = boardCardStepState(yield* board, childId);
        assert.strictEqual(parked?.status, "stalled");

        makeFirstCommit();
        yield* pumpDomain(stepRequeued(parked!, 2));

        const running = boardCardStepState(yield* board, childId);
        assert.strictEqual(running?.status, "running");
        assert.isNotNull(running?.threadId ?? null);
        const provisioned = (yield* commands).filter(
          (command) =>
            command.type === "board.card.provision-worktree" && String(command.cardId) === "pla-10",
        );
        assert.strictEqual(provisioned.length, 1);
        // Cut from the parent's integration branch, which this pass created.
        assert.strictEqual(
          provisioned[0]?.type === "board.card.provision-worktree"
            ? provisioned[0].baseRefName
            : null,
          "board/pla-1",
        );
      }),
  ),
);

it.effect("Continue before the repository is fixed parks it again, spending nothing", () =>
  withGovernor(
    {
      board: { cards: [card("card-1")], nextCardNumberByProject: {} },
      settings,
      unbornBranch: "main",
    },
    ({ pumpDomain, board, commands }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(movedToBuilding(card("card-1"), 1));
        yield* pumpDomain(stepRequeued(boardCardStepState(yield* board, id)!, 2));

        const state = boardCardStepState(yield* board, id);
        assert.strictEqual(state?.status, "stalled");
        assert.strictEqual(state?.stalledReason, "no-worktree");
        assert.include(state?.lastError ?? "", "has no commits yet");
        assert.strictEqual(state?.stageEntryRecoveries, 0);
        assert.strictEqual(threadCreates(yield* commands).length, 0);
      }),
  ),
);

// The stuck arms above all reach a human; these are the other side of the line.
// git ITSELF failing on a healthy repository is a hiccup the next scheduling
// pass may get past, so the step stays pending and nothing is parked.

it.effect("a failed git worktree add leaves the step pending for the next pass to retry", () =>
  withGovernor(
    {
      board: { cards: [card("card-1")], nextCardNumberByProject: {} },
      settings,
      gitFailure: "worktree-add",
    },
    ({ pumpDomain, board, decided }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(card("card-1"), 1));

        const state = boardCardStepState(yield* board, BoardCardId.make("card-1"));
        assert.strictEqual(state?.status, "pending");
        assert.strictEqual(worktreeFailures(yield* decided, "card-1").length, 1);
      }),
  ),
);

it.effect("a git failure that keeps recurring parks the step after three passes", () =>
  withGovernor(
    {
      board: {
        cards: [card("card-1"), card("other-1"), card("other-2"), card("other-3")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
      gitFailure: "worktree-add",
    },
    ({ pumpDomain, board, decided }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        yield* pumpDomain(movedToBuilding(card("card-1"), 1));
        // Each card entering Building runs another scheduling pass.
        yield* pumpDomain(movedToBuilding(card("other-1"), 2));
        assert.strictEqual(boardCardStepState(yield* board, id)?.status, "pending");
        yield* pumpDomain(movedToBuilding(card("other-2"), 3));

        const state = boardCardStepState(yield* board, id);
        assert.strictEqual(state?.status, "stalled");
        assert.strictEqual(state?.stalledReason, "no-worktree");
        assert.include(state?.lastError ?? "", "failed 3 times in a row");
        assert.strictEqual(state?.stageEntryRecoveries, 0);
        const failures = worktreeFailures(yield* decided, "card-1").length;

        // Parked: a later pass no longer re-runs git for it.
        yield* pumpDomain(movedToBuilding(card("other-3"), 4));
        assert.strictEqual(worktreeFailures(yield* decided, "card-1").length, failures);
      }),
  ),
);

it.effect("a card moved out of Building and back starts a fresh run of git retries", () =>
  withGovernor(
    {
      board: {
        cards: [card("card-1"), card("other-1"), card("other-2")],
        nextCardNumberByProject: {},
      },
      settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 1 }),
      gitFailure: "worktree-add",
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        const id = BoardCardId.make("card-1");
        // Two failures, one short of parking.
        yield* pumpDomain(movedToBuilding(card("card-1"), 1));
        yield* pumpDomain(movedToBuilding(card("other-1"), 2));
        assert.strictEqual(boardCardStepState(yield* board, id)?.status, "pending");

        // Out and back: this visit's first failure is its first, not its third.
        yield* pumpDomain(
          cardMoved(card("card-1", { stage: BOARD_SEED_STAGE_IDS.ready }), "building", "ready", 3),
        );
        yield* pumpDomain(movedToBuilding(card("card-1"), 4));
        assert.strictEqual(boardCardStepState(yield* board, id)?.status, "pending");
        yield* pumpDomain(movedToBuilding(card("other-2"), 5));
        assert.strictEqual(boardCardStepState(yield* board, id)?.status, "pending");
      }),
  ),
);

it.effect("a split child whose parent's git branch failed retries rather than parking", () =>
  withGovernor(
    {
      board: { cards: [parent, child], nextCardNumberByProject: {} },
      settings,
      missingBranches: ["board/pla-1"],
      gitFailure: "branch-create",
    },
    ({ pumpDomain, board, decided }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(child, 1));

        const state = boardCardStepState(yield* board, childId);
        assert.strictEqual(state?.status, "pending");
        // Still visible on the child, naming the parent and git's failure.
        const failures = worktreeFailures(yield* decided, "pla-10");
        assert.strictEqual(failures.length, 1);
        const error =
          failures[0]?.type === "board.card-worktree-failed" ? failures[0].payload.error : "";
        assert.include(error, "PLA-1");
        assert.include(error, "Could not create the integration branch 'board/pla-1'");
      }),
  ),
);

it.effect("a project folder that is not a git repository parks the step", () =>
  withGovernor(
    {
      board: { cards: [card("card-1")], nextCardNumberByProject: {} },
      settings,
      notAGitRepo: true,
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(card("card-1"), 1));

        const state = boardCardStepState(yield* board, BoardCardId.make("card-1"));
        assert.strictEqual(state?.status, "stalled");
        assert.strictEqual(state?.stalledReason, "no-worktree");
        assert.include(state?.lastError ?? "", "is not a git repository");
      }),
  ),
);

it.effect("a pinned base that exists nowhere parks the step", () =>
  withGovernor(
    {
      board: {
        cards: [card("card-1", { baseBranch: "release/2.4" })],
        nextCardNumberByProject: {},
      },
      settings,
      missingBranches: ["release/2.4"],
    },
    ({ pumpDomain, board }) =>
      Effect.gen(function* () {
        yield* pumpDomain(movedToBuilding(card("card-1", { baseBranch: "release/2.4" }), 1));

        const state = boardCardStepState(yield* board, BoardCardId.make("card-1"));
        assert.strictEqual(state?.status, "stalled");
        assert.strictEqual(state?.stalledReason, "no-worktree");
        assert.include(state?.lastError ?? "", "'release/2.4' does not exist");
      }),
  ),
);

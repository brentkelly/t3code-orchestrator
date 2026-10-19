/**
 * T3O-24: a pull request that closed before the card existed is not the
 * card's.
 *
 * Board branches are named after card keys, and keys get reused, so
 * `board/t3o-23` can already carry a pull request a card from months ago
 * merged. The forge's branch lookup falls back to the newest pull request on
 * the branch when none is open, so until the new card opens its own, that old
 * merge is what the lookup returns. Adopting it showed the wrong "View PR",
 * pointed Merge at the wrong number, and authorised branch cleanup to delete
 * the new card's unmerged work. The merged-link guard then kept it for good.
 *
 * Against the live reactor and the real decider (`withGovernor`), because the
 * rule lives in both: the reactor ignores and heals, and the decider refuses.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BOARD_SEED_STAGE_IDS,
  type BoardCard,
  type BoardCardPullRequest,
  type OrchestrationCommand,
} from "@t3tools/contracts";

import type { BoardFoundPullRequest } from "./BoardPullRequestGateway.ts";
import {
  NOW,
  cardMoved,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

/** Months before the card (created at `NOW`) existed. */
const BEFORE = "2025-09-09T10:00:00Z";
/** After the card existed. */
const AFTER = "2026-01-02T10:00:00Z";

/** The earlier card's pull request on the same branch, merged long ago. */
const oldMerged: BoardFoundPullRequest = {
  number: 87,
  title: "Stage thread respawn",
  url: "https://github.com/acme/repo/pull/87",
  baseRef: "main",
  headRef: "board/card-1",
  state: "merged",
  mergedAt: BEFORE,
  closedAt: BEFORE,
};

/** This card's own pull request. */
const ownOpen: BoardFoundPullRequest = {
  number: 175,
  title: "Worktree remove hook",
  url: "https://github.com/acme/repo/pull/175",
  baseRef: "main",
  headRef: "board/card-1",
  state: "open",
  mergedAt: null,
  closedAt: null,
};

/** The old merge as the board recorded it before `closedAt` existed. */
const legacyOldLink: BoardCardPullRequest = {
  number: 87,
  url: oldMerged.url,
  state: "merged",
  title: oldMerged.title,
  headBranch: "board/card-1",
  baseRef: "main",
  checkedAt: NOW,
};

const settings = () => settingsWith({ building: [codexStep], globalMaxConcurrent: 4 });

const cardIn = (stage: string, pullRequest: BoardCardPullRequest | null = null): BoardCard =>
  makeBoardCard({
    id: "card-1",
    stage,
    orderKey: "m",
    worktree: readyWorktree("card-1"),
    ...(pullRequest === null ? {} : { pullRequest }),
  });

const inMerge = (pullRequest: BoardCardPullRequest | null = null) =>
  cardIn(String(BOARD_SEED_STAGE_IDS.merge), pullRequest);

const recorded = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "board.card.record-pull-request" ? [command.pullRequest] : [],
  );

const branchCleanupNotes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command) =>
      command.type === "board.card.record-note" && command.kind === "card-branch-deleted",
  );

describe("a pull request older than the card", () => {
  it.effect("is not adopted when it is the only one on the branch", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [inMerge()] },
        settings: settings(),
        pullRequest: oldMerged,
      },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.refreshPullRequest(inMerge().id);
          assert.deepEqual(outcome, { outcome: "none" });
          assert.equal(recorded(yield* h.commands).length, 0);
          assert.equal((yield* h.board).cards[0]!.pullRequest, null);
        }),
    ),
  );

  it.effect("gives way to the card's own open pull request", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [inMerge()] },
        settings: settings(),
        pullRequest: ownOpen,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(inMerge().id);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.pullRequest?.number, 175);
          assert.equal(card.pullRequest?.state, "open");
          // An open pull request records no `closedAt` at all.
          assert.equal(card.pullRequest !== null && "closedAt" in card.pullRequest, false);
        }),
    ),
  );

  it.effect("records when a pull request the card does own merged", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [inMerge()] },
        settings: settings(),
        pullRequest: { ...ownOpen, state: "merged", mergedAt: AFTER, closedAt: AFTER },
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(inMerge().id);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.pullRequest?.state, "merged");
          assert.equal(card.pullRequest?.closedAt, AFTER);
        }),
    ),
  );
});

describe("a card already holding an earlier card's merge heals", () => {
  it.effect("to its own open pull request, learning the old one's date by number", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [inMerge(legacyOldLink)] },
        settings: settings(),
        pullRequestByNumber: oldMerged,
        pullRequest: ownOpen,
      },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.refreshPullRequest(inMerge().id);
          assert.deepEqual(outcome, { outcome: "linked", number: 175 });
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.pullRequest?.number, 175);
          assert.equal(card.pullRequest?.state, "open");
          assert.deepEqual(yield* h.pullRequestGets, [{ number: 87, forced: false }]);
        }),
    ),
  );

  it.effect("to nothing when the branch has no pull request of its own yet", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [inMerge(legacyOldLink)] },
        settings: settings(),
        pullRequest: oldMerged,
      },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.refreshPullRequest(inMerge().id);
          assert.deepEqual(outcome, { outcome: "none" });
          assert.equal((yield* h.board).cards[0]!.pullRequest, null);
        }),
    ),
  );

  it.effect("without a by-number read once its date is recorded", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [inMerge({ ...legacyOldLink, closedAt: BEFORE })],
        },
        settings: settings(),
        pullRequest: ownOpen,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(inMerge().id);
          assert.equal((yield* h.board).cards[0]!.pullRequest?.number, 175);
          assert.equal((yield* h.pullRequestGets).length, 0);
        }),
    ),
  );

  it.effect("to nothing on a card with no worktree to look a branch up in", () => {
    const card = makeBoardCard({
      id: "card-1",
      stage: String(BOARD_SEED_STAGE_IDS.merge),
      orderKey: "m",
      pullRequest: { ...legacyOldLink, closedAt: BEFORE },
    });
    return withGovernor(
      { board: { nextCardNumberByProject: {}, cards: [card] }, settings: settings() },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.refreshPullRequest(card.id);
          assert.deepEqual(outcome, { outcome: "no-branch" });
          assert.deepEqual(recorded(yield* h.commands), [null]);
          assert.equal((yield* h.board).cards[0]!.pullRequest, null);
        }),
    );
  });
});

describe("what the rule leaves alone", () => {
  it.effect("an explicitly linked old pull request", () => {
    const linked = { ...legacyOldLink, linked: true as const, closedAt: BEFORE };
    return withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [inMerge(linked)] },
        settings: settings(),
        pullRequest: ownOpen,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(inMerge().id);
          assert.equal(recorded(yield* h.commands).length, 0);
          assert.equal((yield* h.board).cards[0]!.pullRequest?.number, 87);
          assert.equal((yield* h.pullRequestLookups).length, 0);
        }),
    );
  });

  it.effect("a merge the card owns, when Done has deleted the branch", () => {
    const owned = { ...legacyOldLink, number: 175, closedAt: AFTER };
    return withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [inMerge(owned)] },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(inMerge().id);
          assert.equal(recorded(yield* h.commands).length, 0);
          assert.equal((yield* h.board).cards[0]!.pullRequest?.number, 175);
          // Merged with a known date: nothing left to ask the forge.
          assert.equal((yield* h.pullRequestLookups).length, 0);
          assert.equal((yield* h.pullRequestGets).length, 0);
        }),
    );
  });

  it.effect("a legacy merge the card owns, which is backfilled and kept", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [inMerge({ ...legacyOldLink, number: 175 })],
        },
        settings: settings(),
        pullRequestByNumber: { ...ownOpen, state: "merged", mergedAt: AFTER, closedAt: AFTER },
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(inMerge().id);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.pullRequest?.number, 175);
          assert.equal(card.pullRequest?.state, "merged");
          assert.equal(card.pullRequest?.closedAt, AFTER);
          assert.equal((yield* h.pullRequestLookups).length, 0);
        }),
    ),
  );
});

describe("branch cleanup at Done", () => {
  it.effect("never deletes a branch on the strength of an earlier card's merge", () => {
    const card = inMerge();
    return withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [card] },
        settings: settings(),
        pullRequest: oldMerged,
      },
      (h) =>
        Effect.gen(function* () {
          const done = { ...card, stage: BOARD_SEED_STAGE_IDS.done };
          yield* h.pumpDomain(
            cardMoved(
              done,
              String(BOARD_SEED_STAGE_IDS.merge),
              String(BOARD_SEED_STAGE_IDS.done),
              1,
            ),
          );
          assert.equal((yield* h.board).cards[0]!.pullRequest, null);
          assert.equal(branchCleanupNotes(yield* h.commands).length, 0);
        }),
    );
  });

  it.effect("never deletes one for an old merge the card still holds", () => {
    // The lookup fails, so nothing heals the link: the settle itself must
    // refuse to read it as this card's merge.
    const card = cardIn(String(BOARD_SEED_STAGE_IDS.done), { ...legacyOldLink, closedAt: BEFORE });
    return withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [card] },
        settings: settings(),
        pullRequest: { failWith: "rate limited" },
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(card.id);
          assert.equal((yield* h.board).cards[0]!.pullRequest?.number, 87);
          assert.equal(branchCleanupNotes(yield* h.commands).length, 0);
        }),
    );
  });
});

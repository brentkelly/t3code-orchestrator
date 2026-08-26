/**
 * The card ↔ pull request link, the Merge button, and branch cleanup at Done.
 *
 * Integration tests against the LIVE supervisor reactor wired to the stateful
 * engine double (`withGovernor`), because the behaviour under test spans the
 * reactor, the real decider and the real projector: "the card records its PR"
 * is only true if the command is accepted, decided into an event, and
 * projected back onto the card the reactor next reads.
 *
 * The forge itself is stubbed through `BoardPullRequestGateway` — the two-method
 * seam the board sees — so a test can say "the lookup fails" or "the merge is
 * refused for conflicts" without a real repository or a real `gh`.
 */
import { assert, it, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BOARD_SEED_STAGE_IDS,
  type BoardCard,
  type OrchestrationCommand,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";

import {
  cardMoved,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const openPr: VcsStatusChangeRequest = {
  number: 284,
  title: "Pre-commit format and lint gate",
  url: "https://github.com/acme/repo/pull/284",
  baseRef: "main",
  headRef: "board/card-1",
  state: "open",
};

const settings = (merge?: Parameters<typeof settingsWith>[0]["merge"]) =>
  settingsWith({
    building: [codexStep],
    globalMaxConcurrent: 4,
    ...(merge === undefined ? {} : { merge }),
  });

const cardInMerge = (): BoardCard =>
  makeBoardCard({
    id: "card-1",
    stage: String(BOARD_SEED_STAGE_IDS.merge),
    orderKey: "m",
    worktree: readyWorktree("card-1"),
  });

const recordedPullRequests = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "board.card.record-pull-request");

const movesTo = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "board.card.move" ? [String(command.toStage)] : [],
  );

describe("card ↔ pull request link", () => {
  it.effect("records the pull request a branch lookup finds", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(cardInMerge().id);
          const board = yield* h.board;
          const card = board.cards[0]!;
          assert.equal(card.pullRequest?.number, 284);
          assert.equal(card.pullRequest?.state, "open");
          assert.equal(card.pullRequest?.url, openPr.url);
        }),
    ),
  );

  it.effect("records nothing when a second lookup finds the same pull request", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
      },
      (h) =>
        Effect.gen(function* () {
          // The refresh triggers fire on every step boundary, stage move and
          // card open; the overwhelming majority find exactly what the card
          // already holds. Landing an event for each would bloat the log and
          // republish a shell delta per card open for no change at all.
          yield* h.reactor.refreshPullRequest(cardInMerge().id);
          yield* h.reactor.refreshPullRequest(cardInMerge().id);
          yield* h.reactor.refreshPullRequest(cardInMerge().id);
          assert.equal(recordedPullRequests(yield* h.commands).length, 1);
        }),
    ),
  );

  it.effect("keeps the last known link when the lookup FAILS", () =>
    Effect.gen(function* () {
      // First establish a link, then re-run with a failing gateway. A rate
      // limit or a network blip must leave the badge alone: "we looked and
      // there is none" and "we could not look" are different answers, and
      // recording the first over an existing link would blank a card's PR.
      const linked = {
        ...cardInMerge(),
        pullRequest: {
          number: 284,
          url: openPr.url,
          state: "open" as const,
          headBranch: "board/card-1",
          baseRef: "main",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [linked] },
          settings: settings(),
          pullRequest: { failWith: "API rate limit exceeded" },
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.refreshPullRequest(linked.id);
            assert.equal(recordedPullRequests(yield* h.commands).length, 0);
            const board = yield* h.board;
            assert.equal(board.cards[0]!.pullRequest?.number, 284);
          }),
      );
    }),
  );

  it.effect("never looks up a card with no worktree", () =>
    Effect.gen(function* () {
      const branchless = makeBoardCard({
        id: "card-1",
        stage: String(BOARD_SEED_STAGE_IDS.ready),
        orderKey: "m",
      });
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [branchless] },
          settings: settings(),
          pullRequest: openPr,
        },
        (h) =>
          Effect.gen(function* () {
            // No branch pushed means nothing to look up — the first of the
            // cheap refusals that keep the lookup set bounded by cards
            // actually in flight.
            yield* h.reactor.refreshPullRequest(branchless.id);
            assert.equal(recordedPullRequests(yield* h.commands).length, 0);
          }),
      );
    }),
  );

  it.effect("stops looking up a card whose pull request is merged", () =>
    Effect.gen(function* () {
      const merged = {
        ...cardInMerge(),
        pullRequest: {
          number: 284,
          url: openPr.url,
          state: "merged" as const,
          headBranch: "board/card-1",
          baseRef: "main",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [merged] },
          settings: settings(),
          // A gateway that would answer with something DIFFERENT if asked, so
          // an absent record proves the lookup was skipped rather than that it
          // ran and found no change.
          pullRequest: { ...openPr, number: 999 },
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.refreshPullRequest(merged.id);
            assert.equal(recordedPullRequests(yield* h.commands).length, 0);
            assert.equal((yield* h.board).cards[0]!.pullRequest?.number, 284);
          }),
      );
    }),
  );
});

describe("merging a card's pull request", () => {
  it.effect("merges and advances the card to the next stage", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "merged");
          assert.deepStrictEqual(movesTo(yield* h.commands), [String(BOARD_SEED_STAGE_IDS.done)]);
          assert.equal((yield* h.mergeAttempts).length, 1);
        }),
    ),
  );

  it.effect("reports a refusal, leaves the card put, and does NOT retry", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
        mergeFailure: "Pull request is not mergeable: required status check 'ci' is failing",
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "refused");
          // The forge's own wording reaches the user rather than a paraphrase.
          assert.include(
            result.outcome === "refused" ? result.detail : "",
            "required status check",
          );
          // A block only a human can clear: the card stays where it is, and
          // nothing tries again on its own.
          assert.deepStrictEqual(movesTo(yield* h.commands), []);
          assert.equal((yield* h.mergeAttempts).length, 1);
        }),
    ),
  );

  it.effect("starts the conflict-resolution step when the merge conflicts", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
        mergeFailure: "Pull request is not mergeable: merge conflict between base and head",
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "conflict");
          // The stage's own thread: the merge stage resolves to the
          // conflict-resolution prompt in build mode, so this starts that step
          // and nothing else — the stage auto-executes nothing.
          const started = (yield* h.commands).filter(
            (command) => command.type === "board.card.start-stage-thread",
          );
          assert.equal(started.length, 1);
          // Not merged, so the card does not move.
          assert.deepStrictEqual(movesTo(yield* h.commands), []);
        }),
    ),
  );

  it.effect("treats GitHub's own conflict wording as a conflict", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
        // What `gh` prints when the merge commit cannot be constructed. The
        // word "conflict" does not appear, so this is the case a matcher keyed
        // only on that word would misread as a policy block.
        mergeFailure: "Pull request is not mergeable: the merge commit cannot be cleanly created",
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "conflict");
        }),
    ),
  );

  it.effect("does NOT read a missing approval as a conflict", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: openPr,
        // "not mergeable" is GitHub's wrapper for EVERY refusal. Reading it as
        // a conflict would start an agent to merge base into a branch that has
        // nothing wrong with it, and push the result.
        mergeFailure: "Pull request is not mergeable: At least 1 approving review is required",
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "refused");
          const started = (yield* h.commands).filter(
            (command) => command.type === "board.card.start-stage-thread",
          );
          assert.deepStrictEqual(started, []);
        }),
    ),
  );

  it.effect("refuses to merge a pull request that is already merged", () =>
    Effect.gen(function* () {
      const merged = {
        ...cardInMerge(),
        pullRequest: {
          number: 284,
          url: openPr.url,
          state: "merged" as const,
          headBranch: "board/card-1",
          baseRef: "main",
          checkedAt: "2026-01-01T00:00:00.000Z",
        },
      };
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [merged] },
          settings: settings(),
          pullRequest: openPr,
        },
        (h) =>
          Effect.gen(function* () {
            const result = yield* h.reactor.mergePullRequest(merged.id);
            assert.equal(result.outcome, "not-open");
            // Never reached the forge: a merged PR is terminal, so there is
            // nothing to ask and nothing to do.
            assert.equal((yield* h.mergeAttempts).length, 0);
          }),
      );
    }),
  );

  it.effect("reports no-pull-request rather than merging blind", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [cardInMerge()] },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          const result = yield* h.reactor.mergePullRequest(cardInMerge().id);
          assert.equal(result.outcome, "no-pull-request");
          assert.equal((yield* h.mergeAttempts).length, 0);
        }),
    ),
  );
});

describe("branch cleanup at Done", () => {
  const doneMove = (card: BoardCard, sequence: number) =>
    cardMoved(
      card,
      String(BOARD_SEED_STAGE_IDS.merge),
      String(BOARD_SEED_STAGE_IDS.done),
      sequence,
    );

  it.effect("refreshes the pull request as the card enters Done", () =>
    Effect.gen(function* () {
      const card = cardInMerge();
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [card] },
          settings: settings(),
          pullRequest: { ...openPr, state: "merged" },
        },
        (h) =>
          Effect.gen(function* () {
            // The decision to delete a branch is made against what the forge
            // says NOW, not a cached `open` from before someone merged the PR
            // on GitHub while the card sat in the merge stage.
            const done = { ...card, stage: BOARD_SEED_STAGE_IDS.done };
            yield* h.pumpDomain(doneMove(done, 1));
            const recorded = recordedPullRequests(yield* h.commands);
            assert.equal(recorded.length, 1);
            assert.equal((yield* h.board).cards[0]!.pullRequest?.state, "merged");
          }),
      );
    }),
  );

  it.effect("leaves an UNMERGED pull request's branch alone at Done", () =>
    Effect.gen(function* () {
      const card = cardInMerge();
      yield* withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [card] },
          settings: settings(),
          pullRequest: openPr,
        },
        (h) =>
          Effect.gen(function* () {
            const done = { ...card, stage: BOARD_SEED_STAGE_IDS.done };
            yield* h.pumpDomain(doneMove(done, 1));
            // Still open: the commits do not live in the base branch, so the
            // branch is the only place the work exists. Nothing is deleted.
            assert.equal((yield* h.board).cards[0]!.pullRequest?.state, "open");
          }),
      );
    }),
  );
});

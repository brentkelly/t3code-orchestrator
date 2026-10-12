/**
 * Linking a pull request to a card explicitly (T3O-18).
 *
 * Against the LIVE supervisor reactor and the real decider and projector
 * (`withGovernor`), with the forge stubbed at `BoardPullRequestGateway`. A
 * card made for a pull request — a review card per stack layer, a card with
 * no worktree — must track it exactly as it would a pull request its own
 * branch opened: live status, merge, settling at Done.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BOARD_SEED_STAGE_IDS,
  type BoardCard,
  type BoardCardPullRequest,
  type OrchestrationCommand,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";

import {
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

/** Stack layer 2 — a pull request on a branch that is not the card's own. */
const layerPr: VcsStatusChangeRequest = {
  number: 75,
  title: "Stack layer 2",
  url: "https://github.com/acme/repo/pull/75",
  baseRef: "stack/layer-1",
  headRef: "stack/layer-2",
  state: "open",
};

const settings = () => settingsWith({ building: [codexStep], globalMaxConcurrent: 4 });

const reviewCard = (overrides: { worktree?: BoardCard["worktree"]; stage?: string } = {}) =>
  makeBoardCard({
    id: "card-1",
    stage: overrides.stage ?? String(BOARD_SEED_STAGE_IDS.review),
    orderKey: "m",
    worktree: overrides.worktree ?? null,
  });

const linkedRecord = (overrides: Partial<BoardCardPullRequest> = {}): BoardCardPullRequest => ({
  number: 75,
  url: layerPr.url,
  state: "open",
  title: layerPr.title,
  headBranch: layerPr.headRef,
  baseRef: layerPr.baseRef,
  linked: true,
  checkedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const linkCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter((command) => command.type === "board.card.set-linked-pull-request");

const branchCleanupNotes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command) =>
      command.type === "board.card.record-note" && command.kind === "card-branch-deleted",
  );

describe("linking a pull request to a card", () => {
  it.effect("links a pull request to a card with no worktree, checked with the forge", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [reviewCard()] },
        settings: settings(),
        pullRequestByNumber: layerPr,
      },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.linkPullRequest(reviewCard().id, {
            url: layerPr.url,
          });
          assert.deepEqual(outcome, { outcome: "linked", number: 75 });
          // Asked by number, and forced: a person naming a PR asks about it now.
          assert.deepEqual(yield* h.pullRequestGets, [{ number: 75, forced: true }]);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.pullRequest?.number, 75);
          assert.equal(card.pullRequest?.state, "open");
          assert.equal(card.pullRequest?.headBranch, "stack/layer-2");
          assert.isTrue(card.pullRequest?.linked);
        }),
    ),
  );

  it.effect("linking the same pull request again changes nothing and duplicates nothing", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [reviewCard()] },
        settings: settings(),
        pullRequestByNumber: layerPr,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.linkPullRequest(reviewCard().id, { number: 75 });
          const again = yield* h.reactor.linkPullRequest(reviewCard().id, {
            repository: "acme/repo",
            number: 75,
          });
          assert.deepEqual(again, { outcome: "linked", number: 75 });
          assert.equal(linkCommands(yield* h.commands).length, 1);
          assert.equal((yield* h.board).cards[0]!.pullRequestHistory.length, 0);
        }),
    ),
  );

  it.effect("refuses a pull request the forge does not know, in its own words", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [reviewCard()] },
        settings: settings(),
        pullRequestByNumber: { failWith: "Could not resolve to a PullRequest with the number of 9." },
      },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.linkPullRequest(reviewCard().id, { number: 9 });
          assert.equal(outcome.outcome, "refused");
          assert.include(
            outcome.outcome === "refused" ? outcome.detail : "",
            "Could not resolve to a PullRequest",
          );
          assert.equal(linkCommands(yield* h.commands).length, 0);
          assert.isNull((yield* h.board).cards[0]!.pullRequest);
        }),
    ),
  );

  it.effect("refuses a pull request on another repository without asking the forge", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [reviewCard()] },
        settings: settings(),
        pullRequestByNumber: layerPr,
      },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.linkPullRequest(reviewCard().id, {
            url: "https://github.com/zeald/core.z5/pull/75",
          });
          assert.equal(outcome.outcome, "refused");
          assert.include(outcome.outcome === "refused" ? outcome.detail : "", "acme/repo");
          assert.deepEqual(yield* h.pullRequestGets, []);
        }),
    ),
  );

  it.effect("clears an explicit link, and answers none when there is none to clear", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [{ ...reviewCard(), pullRequest: linkedRecord() }],
        },
        settings: settings(),
        pullRequestByNumber: layerPr,
      },
      (h) =>
        Effect.gen(function* () {
          assert.deepEqual(yield* h.reactor.linkPullRequest(reviewCard().id, null), {
            outcome: "unlinked",
          });
          assert.isNull((yield* h.board).cards[0]!.pullRequest);
          assert.deepEqual(yield* h.reactor.linkPullRequest(reviewCard().id, null), {
            outcome: "none",
          });
        }),
    ),
  );
});

describe("refreshing a linked pull request", () => {
  it.effect("refreshes by number on a card with no worktree and records the merge", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [{ ...reviewCard(), pullRequest: linkedRecord() }],
        },
        settings: settings(),
        pullRequestByNumber: { ...layerPr, state: "merged" },
      },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.refreshPullRequest(reviewCard().id);
          assert.deepEqual(outcome, { outcome: "linked", number: 75 });
          assert.deepEqual(yield* h.pullRequestLookups, []);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.pullRequest?.state, "merged");
          assert.isTrue(card.pullRequest?.linked);
        }),
    ),
  );

  it.effect("never lets the card's branch lookup replace a linked pull request", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [
            {
              ...reviewCard({ worktree: readyWorktree("card-1") }),
              pullRequest: linkedRecord(),
            },
          ],
        },
        settings: settings(),
        // The card's own branch has a DIFFERENT pull request open.
        pullRequest: { ...layerPr, number: 999, headRef: "board/card-1" },
        pullRequestByNumber: { ...layerPr, isDraft: true },
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(reviewCard().id);
          assert.deepEqual(yield* h.pullRequestLookups, []);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.pullRequest?.number, 75);
          assert.isTrue(card.pullRequest?.isDraft);
          assert.isTrue(card.pullRequest?.linked);
        }),
    ),
  );

  it.effect("keeps a linked pull request when the by-number lookup fails", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [{ ...reviewCard(), pullRequest: linkedRecord() }],
        },
        settings: settings(),
        pullRequestByNumber: { failWith: "GitHub API rate limit exceeded." },
      },
      (h) =>
        Effect.gen(function* () {
          const outcome = yield* h.reactor.refreshPullRequest(reviewCard().id);
          assert.deepEqual(outcome, {
            outcome: "lookup-failed",
            detail: "GitHub API rate limit exceeded.",
          });
          assert.equal((yield* h.board).cards[0]!.pullRequest?.number, 75);
        }),
    ),
  );
});

describe("settling a card with a linked pull request", () => {
  it.effect("a card in Done settles when its linked pull request is found merged", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [
            {
              ...reviewCard({
                stage: String(BOARD_SEED_STAGE_IDS.done),
                worktree: readyWorktree("card-1"),
              }),
              pullRequest: linkedRecord(),
            },
          ],
        },
        settings: settings(),
        pullRequestByNumber: { ...layerPr, state: "merged" },
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.refreshPullRequest(reviewCard().id);
          assert.equal((yield* h.board).cards[0]!.pullRequest?.state, "merged");
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
          assert.equal(branchCleanupNotes(yield* h.commands).length, 1);
        }),
    ),
  );

  it.effect("linking an already-merged pull request to a card in Done settles it", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [
            reviewCard({
              stage: String(BOARD_SEED_STAGE_IDS.done),
              worktree: readyWorktree("card-1"),
            }),
          ],
        },
        settings: settings(),
        pullRequestByNumber: { ...layerPr, state: "merged" },
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.linkPullRequest(reviewCard().id, { number: 75 });
          assert.equal((yield* h.board).cards[0]!.pullRequest?.state, "merged");
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
        }),
    ),
  );
});

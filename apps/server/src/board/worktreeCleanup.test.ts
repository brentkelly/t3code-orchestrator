/**
 * T3O-52: finished cards give their worktree back, and a kept one says why.
 *
 * The supervisor half — which cards are swept, when, and what the card records
 * — through the governor harness. The git half (the durability rule itself) is
 * proven against real repositories in `worktree.test.ts`; here the git stub
 * answers "durable" or not, and the assertions are about what the board does
 * with that answer.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  BOARD_SEED_STAGE_IDS,
  type BoardCard,
  type BoardCardPullRequest,
  type OrchestrationCommand,
  type OrchestrationEvent,
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

const settings = (reclaimWorktreeOnDone = true) =>
  settingsWith({ building: [codexStep], globalMaxConcurrent: 4, reclaimWorktreeOnDone });

const cachedPr = (state: BoardCardPullRequest["state"]): BoardCardPullRequest => ({
  number: 284 as BoardCardPullRequest["number"],
  url: "https://github.com/acme/repo/pull/284",
  state,
  headBranch: "board/card-1",
  baseRef: "main",
  checkedAt: "2026-01-01T00:00:00.000Z" as BoardCardPullRequest["checkedAt"],
});

const forgePr = (state: VcsStatusChangeRequest["state"]): VcsStatusChangeRequest => ({
  number: 284,
  title: "A card",
  url: "https://github.com/acme/repo/pull/284",
  baseRef: "main",
  headRef: "board/card-1",
  state,
});

const doneCard = (overrides: Partial<Parameters<typeof makeBoardCard>[0]> = {}): BoardCard =>
  makeBoardCard({
    id: "card-1",
    stage: String(BOARD_SEED_STAGE_IDS.done),
    orderKey: "d",
    worktree: readyWorktree("card-1"),
    ...overrides,
  });

const reclaims = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) => (command.type === "board.card.reclaim-worktree" ? [command] : []));

const reclaimedEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
  events.flatMap((event) => (event.type === "board.card-worktree-reclaimed" ? [event] : []));

const branchCleanupNotes = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command) =>
      command.type === "board.card.record-note" && command.kind === "card-branch-deleted",
  );

describe("reclaim at Done (D2)", () => {
  it.effect(
    "reclaims a Done card with NO pull request whose work is durable, keeping its branches",
    () =>
      withGovernor(
        {
          board: { nextCardNumberByProject: {}, cards: [doneCard()] },
          settings: settings(),
          pullRequest: null,
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.reactor.drainWorktreeSweep;
            assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
            assert.equal((yield* h.board).cards[0]!.worktree?.status, "reclaimed");
            // Branch deletion still needs a merged pull request (D2).
            assert.equal(branchCleanupNotes(yield* h.commands).length, 0);
          }),
      ),
  );

  it.effect("keeps a Done card whose commits exist nowhere else, and says how many", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.worktree?.status, "ready");
          assert.equal(
            card.worktree?.reclaimBlockedReason,
            "2 commits not in the base branch or a merged pull request",
          );
          // One `kept` event, marked as a changed reason so the rail rows it.
          const events = reclaimedEvents(yield* h.decided);
          assert.equal(events.length, 1);
          assert.equal(events[0]!.payload.reasonChanged, true);
        }),
    ),
  );

  it.effect("re-checking a kept card with the same refusal writes nothing new", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          // A card open, twice — each refresh re-runs the reclaim half.
          yield* h.reactor.refreshPullRequest((yield* h.board).cards[0]!.id);
          yield* h.reactor.refreshPullRequest((yield* h.board).cards[0]!.id);
          assert.equal(reclaims(yield* h.commands).length, 1);
        }),
    ),
  );

  it.effect("names an open pull request as the reason its work is not yet durable", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ pullRequest: cachedPr("open") })],
        },
        settings: settings(),
        pullRequest: forgePr("open"),
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.equal(
            (yield* h.board).cards[0]!.worktree?.reclaimBlockedReason,
            "Pull request #284 is still open",
          );
        }),
    ),
  );

  it.effect("leaves Done cards alone, unflagged, with reclaimWorktreeOnDone off", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(false),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          assert.equal(reclaims(yield* h.commands).length, 0);
        }),
    ),
  );

  it.effect("never reclaims a card that has not reached Done", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.merge) })],
        },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    ),
  );
});

describe("the cleanup sweep (D3/D4)", () => {
  it.effect("refreshes a Done card cached `open` at boot, and reclaims it once merged", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ pullRequest: cachedPr("open") })],
        },
        settings: settings(),
        pullRequest: forgePr("merged"),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.equal((yield* h.pullRequestLookups).length, 1);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.pullRequest?.state, "merged");
          assert.equal(card.worktree?.status, "reclaimed");
          // A merged card's branches go too, once.
          assert.equal(branchCleanupNotes(yield* h.commands).length, 1);
        }),
    ),
  );

  it.effect("makes no forge call for a Done card already cached merged", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ pullRequest: cachedPr("merged") })],
        },
        settings: settings(),
        pullRequest: forgePr("merged"),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.equal((yield* h.pullRequestLookups).length, 0);
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
        }),
    ),
  );

  it.effect("a kept card gets no branch-cleanup row from the sweep", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ pullRequest: cachedPr("merged") })],
        },
        settings: settings(),
        pullRequest: forgePr("merged"),
        worktreeDirty: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.equal(branchCleanupNotes(yield* h.commands).length, 0);
        }),
    ),
  );

  it.effect("reclaims an archived card's worktree even with reclaimWorktreeOnDone off", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [
            {
              ...doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building) }),
              archivedAt: "2026-01-01T00:00:00.000Z" as BoardCard["archivedAt"],
            },
          ],
        },
        settings: settings(false),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
        }),
    ),
  );

  it.effect("coalesces a burst of requests into at most one follow-up pass", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          const passes = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
            calls.filter((args) => args[0] === "worktree" && args[1] === "list").length;
          const before = passes(yield* h.gitInvocations);
          yield* h.reactor.sweepWorktrees();
          yield* h.reactor.sweepWorktrees();
          yield* h.reactor.sweepWorktrees();
          yield* h.reactor.sweepWorktrees();
          yield* h.reactor.drainWorktreeSweep;
          const ran = passes(yield* h.gitInvocations) - before;
          assert.isAtLeast(ran, 1);
          assert.isAtMost(ran, 2);
        }),
    ),
  );

  it.effect("runs a pass when a worktree is provisioned", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          const before = (yield* h.gitInvocations).length;
          const card = (yield* h.board).cards[0]!;
          yield* h.pumpDomain({
            type: "board.card-worktree-ready",
            sequence: 1,
            payload: { cardId: card.id, card },
          } as unknown as OrchestrationEvent);
          yield* h.reactor.drainWorktreeSweep;
          assert.isAbove((yield* h.gitInvocations).length, before);
        }),
    ),
  );

  const porcelain = (entries: ReadonlyArray<readonly [string, string]>) =>
    [
      "worktree /tmp/project",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      ...entries.flatMap(([path, branch]) => [
        `worktree ${path}`,
        "HEAD 2222222222222222222222222222222222222222",
        `branch refs/heads/${branch}`,
        "",
      ]),
    ].join("\n");

  it.effect("removes a durable board worktree that no card owns", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          // A live card keeps the project on the board, and owns its own
          // checkout — which must NOT be touched.
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building) })],
        },
        settings: settings(),
        pullRequest: null,
        registeredWorktrees: porcelain([
          ["/tmp/wt/card-1", "board/card-1"],
          ["/tmp/wt/ghost", "board/ghost"],
          ["/tmp/wt/mine", "feature/not-the-boards"],
        ]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/ghost"]);
        }),
    ),
  );

  it.effect("keeps an orphan whose commits exist nowhere else", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building) })],
        },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
        registeredWorktrees: porcelain([["/tmp/wt/ghost", "board/ghost"]]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    ),
  );
});

describe("Remove worktree (D5)", () => {
  it.effect("force-removes a kept worktree and records it as forced", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeDirty: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          const card = (yield* h.board).cards[0]!;
          const result = yield* h.reactor.forceRemoveWorktree(card.id);
          assert.deepEqual(result, { outcome: "removed" });
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
          const after = (yield* h.board).cards[0]!;
          assert.equal(after.worktree?.status, "reclaimed");
          assert.equal(after.worktree?.reclaimBlockedReason, null);
          const forced = reclaimedEvents(yield* h.decided).at(-1)!;
          assert.equal(forced.payload.forced, true);
          // The branch is kept: no branch cleanup ran.
          assert.equal(branchCleanupNotes(yield* h.commands).length, 0);
        }),
    ),
  );

  it.effect("refuses a card that is still being worked", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building) })],
        },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          const card = (yield* h.board).cards[0]!;
          const result = yield* h.reactor.forceRemoveWorktree(card.id);
          assert.deepEqual(result, { outcome: "not-finished" });
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    ),
  );

  it.effect("answers no-worktree when there is nothing left on disk", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [
            doneCard({
              worktree: { ...readyWorktree("card-1"), status: "reclaimed", path: null },
            }),
          ],
        },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          const card = (yield* h.board).cards[0]!;
          assert.deepEqual(yield* h.reactor.forceRemoveWorktree(card.id), {
            outcome: "no-worktree",
          });
        }),
    ),
  );
});

describe("the move into Done", () => {
  it.effect("reclaims as the card arrives, with no pull request at all", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.merge) })],
        },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          const card = (yield* h.board).cards[0]!;
          yield* h.pumpDomain(
            cardMoved(
              { ...card, stage: BOARD_SEED_STAGE_IDS.done },
              String(BOARD_SEED_STAGE_IDS.merge),
              String(BOARD_SEED_STAGE_IDS.done),
              1,
            ),
          );
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
        }),
    ),
  );
});

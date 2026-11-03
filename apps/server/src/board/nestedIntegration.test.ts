/**
 * Recursive integration branches and the destructive group flows (T3O-28),
 * against the LIVE reactor: a nested own-branch group cuts its branch from the
 * outer one, children base on the nearest own branch, sync-base fires at every
 * level, and a confirmed group archive discards the subtree's branch work.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  defaultBoardCardGroup,
  EMPTY_BOARD_STATE,
  ProviderInstanceId,
  type BoardCard,
  type BoardCardGroup,
  type BoardCardPullRequest,
  type BoardCardStepState,
  type BoardCardWorktree,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  aliveThreadShell,
  cardMoved,
  cardStage,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  NOW,
  readyWorktree,
  settingsWith,
  withGovernor,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";

const settings = settingsWith({ building: [codexStep], globalMaxConcurrent: 4 });
const building = String(BOARD_SEED_STAGE_IDS.building);
const review = String(BOARD_SEED_STAGE_IDS.review);
const merge = String(BOARD_SEED_STAGE_IDS.merge);
const done = String(BOARD_SEED_STAGE_IDS.done);

const ownGroup = (overrides: Partial<BoardCardGroup> = {}): BoardCardGroup =>
  defaultBoardCardGroup(
    EMPTY_BOARD_STATE,
    { stage: BOARD_SEED_STAGE_IDS.ready },
    { target: "own", autoBuild: true, started: true, ...overrides },
  );

const branchOnly = (id: string, baseRefName: string): BoardCardWorktree => ({
  ...readyWorktree(id),
  baseRefName,
  path: null,
  status: "branch-only",
});

const card = (
  id: string,
  stage: string,
  overrides: Partial<BoardCard> & { readonly parent?: string } = {},
): BoardCard => {
  const { parent, ...rest } = overrides;
  return {
    ...makeBoardCard({ id, stage, orderKey: "m" }),
    ...(parent === undefined ? {} : { parentCardId: BoardCardId.make(parent) }),
    ...rest,
  };
};

const commandsOfType = <T extends string>(
  commands: ReadonlyArray<{ readonly type: string }>,
  type: T,
) => commands.filter((command) => command.type === type) as ReadonlyArray<Record<string, unknown>>;

describe("a depth-3 tree: an own group nested in an own group (T3O-28)", () => {
  it.effect("cuts outer from trunk, inner from outer, and bases the leaf on inner", () =>
    Effect.gen(function* () {
      const outer = card("card-outer", building, { group: ownGroup() });
      const inner = card("card-inner", building, { group: ownGroup(), parent: "card-outer" });
      const leaf = card("card-leaf", building, { parent: "card-inner" });
      yield* withGovernor(
        {
          board: { cards: [outer, inner, leaf], nextCardNumberByProject: {} },
          settings,
          missingBranches: ["board/card-outer", "board/card-inner"],
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(leaf, 1));
            const recorded = commandsOfType(
              yield* h.commands,
              "board.card.record-integration-branch",
            );
            assert.deepStrictEqual(
              recorded.map((command) => [command.cardId, command.branch, command.baseRefName]),
              [
                ["card-outer", "board/card-outer", "main"],
                // The inner group's final review lands on the outer branch.
                ["card-inner", "board/card-inner", "board/card-outer"],
              ],
            );
            const git = yield* h.gitInvocations;
            const cutOrder = git
              .filter((args) => args[0] === "branch" && args[1] === "--no-track")
              .map((args) => `${args[2]}<-${args[3]}`);
            assert.deepStrictEqual(cutOrder, [
              "board/card-outer<-main",
              "board/card-inner<-board/card-outer",
            ]);
            const provisioned = commandsOfType(
              yield* h.commands,
              "board.card.provision-worktree",
            ).find((command) => command.cardId === "card-leaf");
            assert.strictEqual(provisioned?.baseRefName, "board/card-inner");
          }),
      );
    }),
  );

  it.effect("an inherit group never cuts a branch; its children land on the nearest own", () =>
    Effect.gen(function* () {
      const outer = card("card-outer", building, { group: ownGroup() });
      const heading = card("card-heading", building, {
        parent: "card-outer",
        group: defaultBoardCardGroup(EMPTY_BOARD_STATE, { stage: BOARD_SEED_STAGE_IDS.ready }),
      });
      const leaf = card("card-leaf", building, { parent: "card-heading" });
      yield* withGovernor(
        {
          board: { cards: [outer, heading, leaf], nextCardNumberByProject: {} },
          settings,
          missingBranches: ["board/card-outer", "board/card-heading"],
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(leaf, 1));
            const recorded = commandsOfType(
              yield* h.commands,
              "board.card.record-integration-branch",
            );
            assert.deepStrictEqual(
              recorded.map((command) => command.cardId),
              ["card-outer"],
            );
            const provisioned = commandsOfType(
              yield* h.commands,
              "board.card.provision-worktree",
            ).find((command) => command.cardId === "card-leaf");
            assert.strictEqual(provisioned?.baseRefName, "board/card-outer");
          }),
      );
    }),
  );

  it.effect("a top-level inherit group's children land on trunk and cut nothing", () =>
    Effect.gen(function* () {
      const epic = card("card-epic", building, {
        group: defaultBoardCardGroup(
          EMPTY_BOARD_STATE,
          { stage: BOARD_SEED_STAGE_IDS.ready },
          { started: true, autoBuild: true },
        ),
      });
      const leaf = card("card-leaf", building, { parent: "card-epic" });
      yield* withGovernor(
        {
          board: { cards: [epic, leaf], nextCardNumberByProject: {} },
          settings,
          missingBranches: ["board/card-epic"],
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(leaf, 1));
            assert.lengthOf(
              commandsOfType(yield* h.commands, "board.card.record-integration-branch"),
              0,
            );
            const provisioned = commandsOfType(
              yield* h.commands,
              "board.card.provision-worktree",
            ).find((command) => command.cardId === "card-leaf");
            assert.strictEqual(provisioned?.baseRefName, "main");
          }),
      );
    }),
  );
});

/** The settled last step of a converged review round, recorded at `tip`. The
    harness's rev-parse answers "main" for every unset ref, so any other tip
    reads as a base that moved. */
const settledReview = (cardId: string, tip: string): BoardCardStepState => ({
  cardId: BoardCardId.make(cardId),
  stepId: "review@1",
  stepLabel: "Review · round 1",
  stageLabel: "Code review",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: tip,
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "review it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "auto",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 600_000,
  threadId: null,
  status: "succeeded",
  slotHeld: false,
  forceStart: false,
  queuedBy: null,
  startedAt: null,
  updatedAt: NOW,
});

const convergedRound = (cardId: string) =>
  ({
    cardId: BoardCardId.make(cardId),
    stepId: "review@1",
    outcome: "succeeded",
    summary: "clean",
    payload: JSON.stringify({ reviewedSha: "sha-reviewed", findings: [] }),
    threadId: null,
    completedAt: NOW,
  }) as const;

describe("sync-base fires on siblings at every level (T3O-28)", () => {
  const outer = card("card-outer", building, {
    group: ownGroup(),
    worktree: branchOnly("card-outer", "main"),
  });

  it.effect("a leaf on the inner branch whose base moved bounces back to review", () => {
    const inner = card("card-inner", building, {
      parent: "card-outer",
      group: ownGroup(),
      worktree: branchOnly("card-inner", "board/card-outer"),
    });
    const leaf = card("card-leaf", merge, {
      parent: "card-inner",
      worktree: { ...readyWorktree("card-leaf"), baseRefName: "board/card-inner" },
    });
    return withGovernor(
      {
        board: {
          cards: [outer, inner, leaf],
          stepStates: [settledReview("card-leaf", "sha-before-sibling-merged")],
          stepCompletions: [convergedRound("card-leaf")],
          nextCardNumberByProject: {},
        },
        settings,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(leaf, review, merge, 1));
          assert.strictEqual(cardStage(yield* h.board, leaf.id), review);
        }),
    );
  });

  it.effect("the inner group's own integration review, on the outer branch, bounces too", () => {
    const inner = card("card-inner", merge, {
      parent: "card-outer",
      group: ownGroup(),
      worktree: { ...readyWorktree("card-inner"), baseRefName: "board/card-outer" },
    });
    const finished = card("card-leaf", done, { parent: "card-inner" });
    return withGovernor(
      {
        board: {
          cards: [outer, inner, finished],
          stepStates: [settledReview("card-inner", "sha-before-sibling-merged")],
          stepCompletions: [convergedRound("card-inner")],
          nextCardNumberByProject: {},
        },
        settings,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(inner, review, merge, 1));
          assert.strictEqual(cardStage(yield* h.board, inner.id), review);
        }),
    );
  });

  it.effect("the outer group's review, landing on trunk, is not intercepted", () => {
    const top = card("card-outer", merge, {
      group: ownGroup(),
      worktree: { ...readyWorktree("card-outer"), baseRefName: "main" },
    });
    const finished = card("card-leaf", done, { parent: "card-outer" });
    return withGovernor(
      {
        board: {
          cards: [top, finished],
          stepStates: [settledReview("card-outer", "sha-before-sibling-merged")],
          stepCompletions: [convergedRound("card-outer")],
          nextCardNumberByProject: {},
        },
        settings,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(top, review, merge, 1));
          assert.strictEqual(cardStage(yield* h.board, top.id), merge);
        }),
    );
  });
});

const openPullRequest = (number: number, headBranch: string): BoardCardPullRequest => ({
  number,
  url: `https://example.test/pr/${number}`,
  state: "open",
  title: "Work",
  headBranch,
  baseRef: "main",
  checkedAt: NOW,
});

const archivedEvent = (archived: BoardCard, sequence: number, discard: boolean): HarnessEvent =>
  ({
    type: "board.card-archived",
    sequence,
    payload: {
      cardId: archived.id,
      archivedAt: NOW,
      card: archived,
      ...(discard ? { discard: true } : {}),
    },
  }) as unknown as HarnessEvent;

const remoteDeletes = (git: ReadonlyArray<ReadonlyArray<string>>) =>
  git.filter((args) => args[0] === "push" && args.includes("--delete")).map((args) => args.at(-1));

describe("archiving a group discards its subtree's work (T3O-28)", () => {
  it.effect(
    "closes pull requests and deletes branches, remote copies and branch-only included",
    () => {
      const group = card("card-group", review, {
        group: ownGroup(),
        worktree: branchOnly("card-group", "main"),
        archivedAt: NOW,
      });
      const child = card("card-child", merge, {
        parent: "card-group",
        worktree: { ...readyWorktree("card-child"), baseRefName: "board/card-group" },
        pullRequest: openPullRequest(7, "board/card-child"),
        archivedAt: NOW,
      });
      const deferred = card("card-later", "deferred", { parent: "card-group", archivedAt: NOW });
      return withGovernor(
        {
          board: { cards: [group, child, deferred], nextCardNumberByProject: {} },
          settings,
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(archivedEvent(group, 1, true));
            yield* h.pumpDomain(archivedEvent(child, 2, true));
            yield* h.pumpDomain(archivedEvent(deferred, 3, true));
            yield* h.reactor.drain;
            assert.deepStrictEqual(yield* h.closePullRequestCalls, [{ number: 7 }]);
            assert.sameMembers(remoteDeletes(yield* h.gitInvocations), [
              "board/card-group",
              "board/card-child",
            ]);
            assert.include(yield* h.removedWorktrees, "/tmp/wt/card-child");
            const after = yield* h.board;
            for (const id of ["card-group", "card-child"]) {
              const found = after.cards.find((candidate) => candidate.id === id);
              assert.strictEqual(found?.worktree?.status, "reclaimed");
            }
          }),
      );
    },
  );

  it.effect("also discards a child that was archived before the group", () => {
    const group = card("card-group", review, {
      group: ownGroup(),
      worktree: branchOnly("card-group", "main"),
      archivedAt: NOW,
    });
    const earlier = card("card-early", building, {
      parent: "card-group",
      worktree: {
        ...readyWorktree("card-early"),
        baseRefName: "board/card-group",
        path: null,
        status: "reclaimed",
      },
      pullRequest: openPullRequest(8, "board/card-early"),
      archivedAt: "2025-12-01T00:00:00.000Z" as BoardCard["archivedAt"],
    });
    return withGovernor(
      { board: { cards: [group, earlier], nextCardNumberByProject: {} }, settings },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(archivedEvent(group, 1, true));
          yield* h.reactor.drain;
          assert.deepStrictEqual(yield* h.closePullRequestCalls, [{ number: 8 }]);
          assert.sameMembers(remoteDeletes(yield* h.gitInvocations), [
            "board/card-group",
            "board/card-early",
          ]);
        }),
    );
  });

  it.effect(
    "a plain archive keeps an unmerged branch-only branch, and deletes a merged one",
    () => {
      const merged: BoardCardPullRequest = {
        ...openPullRequest(9, "board/card-group"),
        state: "merged",
      };
      const unmerged = card("card-group", review, {
        worktree: branchOnly("card-group", "main"),
        archivedAt: NOW,
      });
      return Effect.gen(function* () {
        yield* withGovernor(
          { board: { cards: [unmerged], nextCardNumberByProject: {} }, settings },
          (h) =>
            Effect.gen(function* () {
              yield* h.pumpDomain(archivedEvent(unmerged, 1, false));
              yield* h.reactor.drain;
              assert.lengthOf(remoteDeletes(yield* h.gitInvocations), 0);
            }),
        );
        const integrated = { ...unmerged, pullRequest: merged };
        yield* withGovernor(
          { board: { cards: [integrated], nextCardNumberByProject: {} }, settings },
          (h) =>
            Effect.gen(function* () {
              yield* h.pumpDomain(archivedEvent(integrated, 1, false));
              yield* h.reactor.drain;
              assert.deepStrictEqual(remoteDeletes(yield* h.gitInvocations), ["board/card-group"]);
            }),
        );
      });
    },
  );
});

describe("a second-round split after reclaim (T3O-28)", () => {
  it.effect("cuts a fresh integration branch rather than reusing the reclaimed slice", () => {
    const parent = card("card-parent", building, {
      group: ownGroup(),
      worktree: { ...readyWorktree("card-parent"), path: null, status: "reclaimed" },
    });
    const leaf = card("card-leaf", building, { parent: "card-parent" });
    return withGovernor(
      {
        board: { cards: [parent, leaf], nextCardNumberByProject: {} },
        settings,
        missingBranches: ["board/card-parent"],
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(leaf, 1));
          const recorded = commandsOfType(
            yield* h.commands,
            "board.card.record-integration-branch",
          );
          assert.deepStrictEqual(
            recorded.map((command) => command.cardId),
            ["card-parent"],
          );
          assert.isTrue(
            (yield* h.gitInvocations).some(
              (args) => args[0] === "branch" && args[2] === "board/card-parent",
            ),
          );
          const after = (yield* h.board).cards.find((candidate) => candidate.id === parent.id);
          assert.strictEqual(after?.worktree?.status, "branch-only");
        }),
    );
  });
});

const workCancelledEvent = (cancelled: BoardCard, sequence: number): HarnessEvent =>
  ({
    type: "board.card-updated",
    sequence,
    payload: { cardId: cancelled.id, card: cancelled, workCancelled: true },
  }) as unknown as HarnessEvent;

/** What the decider leaves after cancel-work: a heading group at Sprint whose
    pull request is retired and whose worktree is still there. */
const asCancelled = (started: BoardCard): BoardCard => ({
  ...started,
  stage: BOARD_SEED_STAGE_IDS.sprint,
  group: defaultBoardCardGroup(
    EMPTY_BOARD_STATE,
    { stage: BOARD_SEED_STAGE_IDS.sprint },
    { heading: true, prevStage: BOARD_SEED_STAGE_IDS.sprint },
  ),
  pullRequest: null,
  pullRequestHistory: [openPullRequest(41, `board/${started.id}`)],
});

describe("cancelling a started leaf's work to make it a parent (T3O-28)", () => {
  it.effect(
    "abandons the step, stops its thread, closes the PR, then reclaims and deletes the branch",
    () =>
      withGovernor(
        {
          board: {
            cards: [card("card-x", "ready", { worktree: readyWorktree("card-x") })],
            nextCardNumberByProject: {},
          },
          settings,
        },
        (h) =>
          Effect.gen(function* () {
            const leaf = card("card-x", building, { worktree: readyWorktree("card-x") });
            yield* h.pumpDomain(movedToBuilding(leaf, 1));
            const running = (yield* h.board).stepStates?.find((state) => state.cardId === leaf.id);
            assert.strictEqual(running?.status, "running");
            const threadId = String(running!.threadId);
            yield* Ref.update(
              h.shells,
              (current) => new Map([...current, [threadId, aliveThreadShell(threadId)]]),
            );

            const started = (yield* h.board).cards.find((candidate) => candidate.id === leaf.id)!;
            yield* h.pumpDomain(workCancelledEvent(asCancelled(started), 2));
            yield* h.reactor.drain;

            const after = yield* h.board;
            const state = after.stepStates?.find((candidate) => candidate.cardId === leaf.id);
            assert.strictEqual(state?.status, "abandoned");
            assert.isTrue(
              (yield* h.commands).some(
                (command) => command.type === "thread.interrupt" && command.threadId === threadId,
              ),
            );
            assert.deepStrictEqual(yield* h.closePullRequestCalls, [{ number: 41 }]);
            assert.include(yield* h.removedWorktrees, "/tmp/wt/card-x");
            assert.deepStrictEqual(remoteDeletes(yield* h.gitInvocations), ["board/card-x"]);
          }),
      ),
  );

  it.effect("a kept worktree keeps its branch, and Remove worktree then takes both", () => {
    const cancelled = asCancelled(card("card-x", building, { worktree: readyWorktree("card-x") }));
    return withGovernor(
      {
        board: { cards: [cancelled], nextCardNumberByProject: {} },
        settings,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(workCancelledEvent(cancelled, 1));
          yield* h.reactor.drain;
          assert.deepStrictEqual(yield* h.removedWorktrees, []);
          assert.lengthOf(remoteDeletes(yield* h.gitInvocations), 0);

          const removed = yield* h.reactor.forceRemoveWorktree(cancelled.id);
          assert.deepStrictEqual(removed, { outcome: "removed" });
          assert.include(yield* h.removedWorktrees, "/tmp/wt/card-x");
          assert.deepStrictEqual(remoteDeletes(yield* h.gitInvocations), ["board/card-x"]);
        }),
    );
  });

  it.effect("the worktree sweep retries a kept cancelled worktree once its work is safe", () => {
    const cancelled = asCancelled(card("card-x", building, { worktree: readyWorktree("card-x") }));
    return withGovernor(
      {
        board: { cards: [cancelled], nextCardNumberByProject: {} },
        settings,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(workCancelledEvent(cancelled, 1));
          yield* h.reactor.drain;
          assert.deepStrictEqual(yield* h.removedWorktrees, []);
          h.setWorktreeUndurable(false);
          yield* h.reactor.sweepWorktrees();
          yield* h.reactor.drainWorktreeSweep;
          assert.include(yield* h.removedWorktrees, "/tmp/wt/card-x");
          assert.deepStrictEqual(remoteDeletes(yield* h.gitInvocations), ["board/card-x"]);
        }),
    );
  });

  it.effect("Check again reclaims a kept cancelled worktree once its work is safe", () => {
    const cancelled = asCancelled(card("card-x", building, { worktree: readyWorktree("card-x") }));
    return withGovernor(
      {
        board: { cards: [cancelled], nextCardNumberByProject: {} },
        settings,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(workCancelledEvent(cancelled, 1));
          yield* h.reactor.drain;
          assert.deepStrictEqual(yield* h.removedWorktrees, []);
          h.setWorktreeUndurable(false);
          const result = yield* h.reactor.checkWorktree(cancelled.id);
          assert.deepStrictEqual(result, { outcome: "removed" });
          assert.deepStrictEqual(remoteDeletes(yield* h.gitInvocations), ["board/card-x"]);
        }),
    );
  });
});

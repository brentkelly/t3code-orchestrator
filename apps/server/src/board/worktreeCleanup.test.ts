// @effect-diagnostics nodeBuiltinImport:off
/**
 * Finished cards give their worktree back, and a kept one says why. The git stub answers
 * "durable" or not; the durability rule itself is proven in `worktree.test.ts`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import {
  BOARD_SEED_STAGE_IDS,
  BoardWorkerGitError,
  type BoardCard,
  type BoardCardPullRequest,
  type BoardWorktreeAtDone,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";

import { layerTest } from "../config.ts";
import {
  cardMoved,
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
  type HarnessCommand,
  type HarnessEvent,
} from "./supervisorHarness.testkit.ts";
import type { BoardReadModel } from "./projector.ts";
import type { BoardCardWorkspace, BoardWorkspacesShape } from "./workspace/BoardWorkspace.ts";
import { makeBoardWorkspaces } from "./workspace/workspaceLayer.ts";

/** `remove-if-clean` unless a test says otherwise: most of this suite is the safety rule. */
const settings = (worktreeAtDone: BoardWorktreeAtDone = "remove-if-clean") =>
  settingsWith({ building: [codexStep], globalMaxConcurrent: 4, worktreeAtDone });

const cachedPr = (state: BoardCardPullRequest["state"]): BoardCardPullRequest => ({
  number: 284 as BoardCardPullRequest["number"],
  url: "https://github.com/acme/repo/pull/284",
  state,
  title: null,
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

/** A config whose worktrees directory is a fresh temp dir: the orphan
    sweep only claims checkouts beneath it. */
const ownWorktrees = () => {
  const baseDir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-sweep-")),
  );
  const serverConfig = layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
    Layer.orDie,
  );
  return { dir: NodePath.join(baseDir, "worktrees"), serverConfig };
};

/** Change one card in the read model, as a concurrent command would. */
const editCard = (
  model: Ref.Ref<BoardReadModel>,
  cardId: string,
  edit: (card: BoardCard) => BoardCard,
) =>
  Ref.update(model, (current) => ({
    ...current,
    board:
      current.board === undefined
        ? current.board
        : {
            ...current.board,
            cards: current.board.cards.map((card) => (card.id === cardId ? edit(card) : card)),
          },
  }));

const reclaims = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.flatMap((command) => (command.type === "board.card.reclaim-worktree" ? [command] : []));

const reclaimedEvents = (events: ReadonlyArray<HarnessEvent>) =>
  events.flatMap((event) => (event.type === "board.card-worktree-reclaimed" ? [event] : []));

const branchCleanupNotes = (commands: ReadonlyArray<HarnessCommand>) =>
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
            // Branch deletion still needs a merged pull request.
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

  it.effect("reclaims a Done card whose checkout folder is already gone", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        // Not durable, so only the missing folder can account for a removal.
        worktreeUndurable: true,
        registeredWorktrees: [
          "worktree /repo",
          "branch refs/heads/main",
          "",
          "worktree /tmp/wt/card-1",
          "branch refs/heads/board/card-1",
          "prunable gitdir file points to non-existent location",
          "",
        ].join("\n"),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.worktree?.status, "reclaimed");
          assert.equal(card.worktree?.reclaimBlockedReason, null);
        }),
    ),
  );

  it.effect("reclaims a Done card whose deleted checkout git has already pruned", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
        // Only the main checkout is left: /tmp/wt/card-1 is neither listed nor on disk.
        registeredWorktrees: ["worktree /repo", "branch refs/heads/main", ""].join("\n"),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
          const card = (yield* h.board).cards[0]!;
          assert.equal(card.worktree?.status, "reclaimed");
          assert.equal(card.worktree?.reclaimBlockedReason, null);
        }),
    ),
  );

  it.effect("Check again on a finished card whose project is gone says it could not check", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [{ ...doneCard(), projectId: "project-missing" as BoardCard["projectId"] }],
        },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          const result = yield* h.reactor.checkWorktree((yield* h.board).cards[0]!.id);
          assert.deepEqual(result, { outcome: "failed" });
          assert.deepEqual(yield* h.removedWorktrees, []);
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
        settings: settings("keep"),
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

  it.effect("keeps an archived card's worktree under keep, unflagged (T3O-123)", () =>
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
        settings: settings("keep"),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          // Archive follows the setting now; it used to always reclaim.
          assert.deepEqual(yield* h.removedWorktrees, []);
          assert.equal(reclaims(yield* h.commands).length, 0);
          assert.equal((yield* h.board).cards[0]!.worktree?.status, "ready");
        }),
    ),
  );

  it.effect("Check again reclaims a kept archived card outside Done", () =>
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
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          // The work has since reached the remote; the human asks again.
          h.setWorktreeUndurable(false);
          const result = yield* h.reactor.checkWorktree((yield* h.board).cards[0]!.id);
          assert.deepEqual(result, { outcome: "removed" });
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
        }),
    ),
  );

  it.effect("Check again answers a repeat refusal, though it writes nothing new", () =>
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
          const before = reclaims(yield* h.commands).length;
          const result = yield* h.reactor.checkWorktree((yield* h.board).cards[0]!.id);
          assert.deepEqual(result, {
            outcome: "kept",
            reason: "2 commits not in the base branch or a merged pull request",
          });
          assert.equal(reclaims(yield* h.commands).length, before);
        }),
    ),
  );

  it.effect("Check again says so when another cleanup of the card is already running", () => {
    let check: Effect.Effect<unknown> = Effect.void;
    const answers: Array<unknown> = [];
    return withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
        // The human clicks while the boot sweep's probe of this card runs.
        duringDurabilityProbe: () =>
          answers.length > 0
            ? Effect.void
            : Effect.asVoid(check.pipe(Effect.tap((a) => Effect.sync(() => answers.push(a))))),
      },
      (h) =>
        Effect.gen(function* () {
          check = Effect.flatMap(h.board, (board) => h.reactor.checkWorktree(board.cards[0]!.id));
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(answers, [{ outcome: "busy" }]);
        }),
    );
  });

  it.effect("Check again on a Done card under keep says the setting keeps it", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings("keep"),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          const result = yield* h.reactor.checkWorktree((yield* h.board).cards[0]!.id);
          assert.deepEqual(result, { outcome: "kept-by-setting" });
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    ),
  );

  it.effect("abandons a reclaim when the card leaves Done while the probe runs", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(),
        pullRequest: null,
        // A human drags the card back out of Done carrying its pull request
        // while the fetches run: the round advances under the reclaim.
        duringDurabilityProbe: (model) =>
          editCard(model, "card-1", (card) => ({
            ...card,
            stage: BOARD_SEED_STAGE_IDS.building,
            pullRequestHistory: [...card.pullRequestHistory, cachedPr("open")],
          })),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          assert.equal(reclaims(yield* h.commands).length, 0);
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
        // A pass is counted by its orphan listing, which needs a config.
        serverConfig: ownWorktrees().serverConfig,
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
          } as unknown as HarnessEvent);
          yield* h.reactor.drainWorktreeSweep;
          assert.isAbove((yield* h.gitInvocations).length, before);
        }),
    ),
  );

  it.effect("a worktree event re-probes no kept worktree but its own card's", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [
            doneCard(),
            makeBoardCard({
              id: "card-2",
              stage: String(BOARD_SEED_STAGE_IDS.done),
              orderKey: "e",
              worktree: readyWorktree("card-2"),
            }),
          ],
        },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
      },
      (h) =>
        Effect.gen(function* () {
          // Boot keeps both, each with its reason.
          yield* h.reactor.drainWorktreeSweep;
          const kept = (yield* h.board).cards;
          assert.isNotNull(kept[0]!.worktree?.reclaimBlockedReason ?? null);
          assert.isNotNull(kept[1]!.worktree?.reclaimBlockedReason ?? null);
          const before = (yield* h.gitCwds).length;
          yield* h.pumpDomain({
            type: "board.card-worktree-ready",
            sequence: 1,
            payload: { cardId: kept[1]!.id, card: kept[1]! },
          } as unknown as HarnessEvent);
          yield* h.reactor.drainWorktreeSweep;
          const cwds = (yield* h.gitCwds).slice(before);
          assert.notInclude(cwds, "/tmp/wt/card-1");
          assert.include(cwds, "/tmp/wt/card-2");

          // A kept worktree is still retried once its last probe is old enough.
          yield* TestClock.adjust("31 minutes");
          const later = (yield* h.gitCwds).length;
          yield* h.pumpDomain({
            type: "board.card-worktree-ready",
            sequence: 2,
            payload: { cardId: kept[1]!.id, card: kept[1]! },
          } as unknown as HarnessEvent);
          yield* h.reactor.drainWorktreeSweep;
          assert.include((yield* h.gitCwds).slice(later), "/tmp/wt/card-1");
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

  it.effect("removes a durable board worktree that no card owns", () => {
    const own = ownWorktrees();
    const owned = NodePath.join(own.dir, "repo", "board-card-1");
    const ghost = NodePath.join(own.dir, "repo", "board-ghost");
    return withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          // A live card keeps the project on the board, and owns its own
          // checkout — which must NOT be touched.
          cards: [
            doneCard({
              stage: String(BOARD_SEED_STAGE_IDS.building),
              worktree: { ...readyWorktree("card-1"), path: owned },
            }),
          ],
        },
        settings: settings(),
        pullRequest: null,
        serverConfig: own.serverConfig,
        registeredWorktrees: porcelain([
          [owned, "board/card-1"],
          [ghost, "board/ghost"],
          [NodePath.join(own.dir, "repo", "mine"), "feature/not-the-boards"],
        ]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, [ghost]);
        }),
    );
  });

  it.effect("leaves board worktrees outside its own worktrees directory alone", () => {
    const own = ownWorktrees();
    // Another T3 environment on the same repository — the live install, seen
    // from a dev server seeded with a copy of its database — whose cards this
    // board does not know.
    const foreign = ownWorktrees();
    return withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building), worktree: null })],
        },
        settings: settings(),
        pullRequest: null,
        serverConfig: own.serverConfig,
        registeredWorktrees: porcelain([
          [NodePath.join(foreign.dir, "repo", "board-t3o-99"), "board/t3o-99"],
          ["/tmp/elsewhere/board-ghost", "board/ghost"],
        ]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    );
  });

  it.effect("claims no orphans without a worktrees directory to scope them", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building) })],
        },
        settings: settings(),
        pullRequest: null,
        registeredWorktrees: porcelain([["/tmp/wt/ghost", "board/ghost"]]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    ),
  );

  it.effect("never treats another project's live card, or the main checkout, as an orphan", () => {
    const own = ownWorktrees();
    const otherPath = NodePath.join(own.dir, "repo", "board-other-1");
    return withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [
            doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building) }),
            {
              ...makeBoardCard({
                id: "other-1",
                stage: String(BOARD_SEED_STAGE_IDS.building),
                orderKey: "o",
                worktree: { ...readyWorktree("other-1"), path: otherPath },
              }),
              projectId: "project-other" as BoardCard["projectId"],
            },
          ],
        },
        settings: settings(),
        pullRequest: null,
        serverConfig: own.serverConfig,
        registeredWorktrees: [
          // The repository itself, checked out on a board branch by hand.
          "worktree /tmp/project",
          "HEAD 1111111111111111111111111111111111111111",
          "branch refs/heads/board/by-hand",
          "",
          `worktree ${otherPath}`,
          "HEAD 2222222222222222222222222222222222222222",
          "branch refs/heads/board/other-1",
          "",
        ].join("\n"),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    );
  });

  it.effect("keeps a checkout whose card starts provisioning it while the probe runs", () => {
    const own = ownWorktrees();
    const path = NodePath.join(own.dir, "repo", "board-card-1");
    return withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          // No worktree yet in the pass's snapshot, so its checkout reads as
          // an orphan — until the card records it mid-probe.
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building), worktree: null })],
        },
        settings: settings(),
        pullRequest: null,
        serverConfig: own.serverConfig,
        registeredWorktrees: porcelain([[path, "board/card-1"]]),
        duringDurabilityProbe: (model) =>
          editCard(model, "card-1", (card) => ({
            ...card,
            worktree: { ...readyWorktree("card-1"), path },
          })),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    );
  });

  it.effect("keeps an orphan whose commits exist nowhere else", () => {
    const own = ownWorktrees();
    return withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.building) })],
        },
        settings: settings(),
        pullRequest: null,
        worktreeUndurable: true,
        serverConfig: own.serverConfig,
        registeredWorktrees: porcelain([[NodePath.join(own.dir, "repo", "ghost"), "board/ghost"]]),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    );
  });
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

  it.effect("answers failed, not no-worktree, when the card's project is gone", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [{ ...doneCard(), projectId: "project-missing" as BoardCard["projectId"] }],
        },
        settings: settings(),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          const card = (yield* h.board).cards[0]!;
          assert.deepEqual(yield* h.reactor.forceRemoveWorktree(card.id), { outcome: "failed" });
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

// ── worktreeAtDone (T3O-123) ────────────────────────────────────────────

type WorktreeOps = Partial<
  Pick<BoardCardWorkspace, "snapshotWorktree" | "stripWorktree" | "retireWorktree">
>;

/** The harness's real local workspace, with some worktree operations replaced. */
const withWorktreeOps =
  (ops: WorktreeOps) =>
  (local: Parameters<typeof makeBoardWorkspaces>[0]): BoardWorkspacesShape => {
    const workspaces = makeBoardWorkspaces(local);
    const wrap = (workspace: BoardCardWorkspace): BoardCardWorkspace => ({ ...workspace, ...ops });
    return {
      ...workspaces,
      forCard: (card) => Effect.map(workspaces.forCard(card), wrap),
      localProject: (projectId) => Effect.map(workspaces.localProject(projectId), wrap),
      forWorker: (workerId, projectId) =>
        Effect.map(workspaces.forWorker(workerId, projectId), wrap),
      groupByWorkspace: (cards) =>
        Effect.map(workspaces.groupByWorkspace(cards), (groups) =>
          groups.map((group) => ({ ...group, workspace: wrap(group.workspace) })),
        ),
    };
  };

const cleanupNotes = (commands: ReadonlyArray<HarnessCommand>) =>
  commands.flatMap((command) =>
    command.type === "board.card.record-note" && command.kind === "card-worktree-cleanup"
      ? [command.detail]
      : [],
  );

const SNAPSHOT_REF = "refs/t3o/discarded/T3O-1-20260101T000000";

const arriveInDone = (h: Parameters<Parameters<typeof withGovernor>[1]>[0]) =>
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
    yield* h.reactor.drain;
  });

describe("worktreeAtDone: remove (T3O-123)", () => {
  it.effect("snapshots a dirty worktree, then force-removes it and names the ref", () => {
    const snapshots: Array<string> = [];
    const retires: Array<string> = [];
    return withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.merge) })],
        },
        settings: settings("remove"),
        pullRequest: null,
        worktreeDirty: true,
        worktreeUndurable: true,
        workspaces: withWorktreeOps({
          snapshotWorktree: (input) =>
            Effect.sync(() => {
              snapshots.push(`${input.worktreePath} ${input.cardKey}`);
              return { outcome: "snapshotted", ref: SNAPSHOT_REF, sha: "a".repeat(40) } as const;
            }),
          retireWorktree: (input) =>
            Effect.sync(() => {
              retires.push(`${input.worktreePath} ${input.kind}`);
              return { outcome: "removed", hookWarning: null } as const;
            }),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* arriveInDone(h);
          assert.deepEqual(snapshots, [`/tmp/wt/card-1 ${(yield* h.board).cards[0]!.key}`]);
          // No clean/pushed check: dirty and unpushed, it goes anyway.
          assert.deepEqual(retires, ["/tmp/wt/card-1 forced"]);
          assert.equal((yield* h.board).cards[0]!.worktree?.status, "reclaimed");
          const [note] = cleanupNotes(yield* h.commands);
          assert.include(note, SNAPSHOT_REF);
          assert.include(note, `git checkout -b <name> ${SNAPSHOT_REF}`);
        }),
    );
  });

  it.effect("a retry whose work an earlier snapshot already saved records no second note", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings("remove"),
        pullRequest: null,
        worktreeDirty: true,
        workspaces: withWorktreeOps({
          snapshotWorktree: () =>
            Effect.succeed({
              outcome: "snapshotted",
              ref: SNAPSHOT_REF,
              sha: "a".repeat(40),
              reused: true,
            } as const),
          retireWorktree: () => Effect.succeed({ outcome: "removed", hookWarning: null } as const),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.equal((yield* h.board).cards[0]!.worktree?.status, "reclaimed");
          assert.deepEqual(cleanupNotes(yield* h.commands), []);
        }),
    ),
  );

  it.effect("a merged card whose branch Done deletes is removed only when clean", () =>
    withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ pullRequest: cachedPr("merged") })],
        },
        settings: settings("remove"),
        pullRequest: forgePr("merged"),
        // Commits made after the merge live only on the branch Done is about to delete.
        worktreeUndurable: true,
        workspaces: withWorktreeOps({
          snapshotWorktree: () => Effect.die("a branch Done deletes must not be force-removed"),
          retireWorktree: () => Effect.die("a branch Done deletes must not be force-removed"),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          const kept = (yield* h.board).cards[0]!.worktree;
          assert.equal(kept?.status, "ready");
          assert.include(kept?.reclaimBlockedReason ?? "", "its branch is deleted at Done");
        }),
    ),
  );

  it.effect("an open pull request that merges after the reclaim found its worktree kept", () => {
    let forge = forgePr("open");
    const forced: Array<string> = [];
    return withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ pullRequest: cachedPr("open") })],
        },
        settings: settings("remove"),
        pullRequestOf: () => forge,
        worktreeUndurable: true,
        workspaces: withWorktreeOps({
          snapshotWorktree: () =>
            Effect.sync(() => {
              forced.push("snapshot");
              return { outcome: "snapshotted", ref: SNAPSHOT_REF, sha: "a".repeat(40) } as const;
            }),
          retireWorktree: () =>
            Effect.sync(() => {
              forced.push("retire");
              return { outcome: "removed", hookWarning: null } as const;
            }),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(forced, []);
          assert.equal((yield* h.board).cards[0]!.worktree?.status, "ready");
          // The merge lands later; Done's branch cleanup runs with the worktree still holding it.
          forge = forgePr("merged");
          yield* h.reactor.refreshPullRequest((yield* h.board).cards[0]!.id);
          assert.equal((yield* h.board).cards[0]!.pullRequest?.state, "merged");
          assert.deepEqual(forced, []);
          assert.equal((yield* h.board).cards[0]!.worktree?.status, "ready");
        }),
    );
  });

  it.effect("falls back to the safety rule, saying why, when the changes are over the cap", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings("remove"),
        pullRequest: null,
        worktreeDirty: true,
        workspaces: withWorktreeOps({
          snapshotWorktree: () =>
            Effect.succeed({ outcome: "over-cap", bytes: 300 * 1024 * 1024 } as const),
          retireWorktree: () => Effect.die("a worktree over the cap must not be force-removed"),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          const kept = (yield* h.board).cards[0]!.worktree;
          assert.equal(kept?.status, "ready");
          assert.equal(
            kept?.reclaimBlockedReason,
            "1 uncommitted change (README.md). It was not force-removed: its uncommitted changes (300 MB) are over the 200 MB snapshot cap",
          );
        }),
    ),
  );

  it.effect("an old worker that lacks the snapshot falls back to the safety rule", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings("remove"),
        pullRequest: null,
        worktreeDirty: true,
        workspaces: withWorktreeOps({
          snapshotWorktree: () =>
            Effect.fail(
              new BoardWorkerGitError({
                operation: "snapshotWorktree",
                detail: "This worker's T3o is too old for the board's git operations; update it.",
              }),
            ),
          retireWorktree: () => Effect.die("an unsnapshotted worktree must not be force-removed"),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, []);
          assert.include(
            (yield* h.board).cards[0]!.worktree?.reclaimBlockedReason ?? "",
            "couldn't be saved first (This worker's T3o is too old",
          );
        }),
    ),
  );

  it.effect("a clean worktree a failed snapshot held back is still removed by the rule", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings("remove"),
        pullRequest: null,
        workspaces: withWorktreeOps({
          snapshotWorktree: () =>
            Effect.fail(new BoardWorkerGitError({ operation: "snapshotWorktree", detail: "old" })),
        }),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
        }),
    ),
  );
});

describe("worktreeAtDone: kept worktrees are stripped (T3O-123)", () => {
  const recordingStrip = (calls: Array<boolean>, outcome: "stripped" | "pending" = "stripped") =>
    withWorktreeOps({
      stripWorktree: (input) =>
        Effect.sync(() => {
          calls.push(input.onlyIfPending);
          return outcome === "stripped"
            ? ({ outcome: "stripped", freedBytes: 3 * 1024 ** 3 } as const)
            : ({ outcome: "pending", reason: "cargo is still running in the worktree" } as const);
        }),
    });

  it.effect("under keep, strips as the card arrives in Done, with no badge or reclaim", () => {
    const calls: Array<boolean> = [];
    return withGovernor(
      {
        board: {
          nextCardNumberByProject: {},
          cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.merge) })],
        },
        settings: settings("keep"),
        pullRequest: null,
        workspaces: recordingStrip(calls),
      },
      (h) =>
        Effect.gen(function* () {
          yield* arriveInDone(h);
          assert.deepEqual(calls, [false]);
          assert.deepEqual(yield* h.removedWorktrees, []);
          assert.equal(reclaims(yield* h.commands).length, 0);
          assert.deepEqual(cleanupNotes(yield* h.commands), [
            "Removed 3.0 GB of ignored files from the kept worktree",
          ]);
        }),
    );
  });

  it.effect("strips nothing of a card put back to work after the cleanup judged it", () => {
    const calls: Array<boolean> = [];
    const backToWork: { model: Ref.Ref<BoardReadModel> | null } = { model: null };
    return withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings("keep"),
        pullRequest: null,
        workspaces: (local) => {
          const workspaces = recordingStrip(calls)(local);
          return {
            ...workspaces,
            // The card is dragged back out of Done just as its cleanup reaches the worker.
            forCard: (card) =>
              Effect.gen(function* () {
                const model = backToWork.model;
                if (model !== null) {
                  backToWork.model = null;
                  yield* editCard(model, "card-1", (current) => ({
                    ...current,
                    stage: BOARD_SEED_STAGE_IDS.building,
                    pullRequestHistory: [...current.pullRequestHistory, cachedPr("open")],
                  }));
                }
                return yield* workspaces.forCard(card);
              }),
          };
        },
      },
      (h) =>
        Effect.gen(function* () {
          backToWork.model = h.model;
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(calls, []);
        }),
    );
  });

  it.effect("a routine sweep only retries a pending strip, never starts one", () => {
    const calls: Array<boolean> = [];
    return withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings("keep"),
        pullRequest: null,
        workspaces: recordingStrip(calls),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepEqual(calls, [true]);
        }),
    );
  });

  it.effect(
    "under remove-if-clean, strips a worktree the rule kept; a foreign process is noted",
    () => {
      const calls: Array<boolean> = [];
      return withGovernor(
        {
          board: {
            nextCardNumberByProject: {},
            cards: [doneCard({ stage: String(BOARD_SEED_STAGE_IDS.merge) })],
          },
          settings: settings("remove-if-clean"),
          pullRequest: null,
          worktreeUndurable: true,
          workspaces: recordingStrip(calls, "pending"),
        },
        (h) =>
          Effect.gen(function* () {
            yield* arriveInDone(h);
            assert.deepEqual(calls, [false]);
            assert.deepEqual(yield* h.removedWorktrees, []);
            assert.deepEqual(cleanupNotes(yield* h.commands), [
              "Left the kept worktree's ignored files for now: cargo is still running in the worktree. The board retries once it has stopped",
            ]);
          }),
      );
    },
  );

  it.effect("archive follows keep: the archived card's worktree is kept and stripped", () => {
    const calls: Array<boolean> = [];
    const card = doneCard();
    return withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [card] },
        settings: settings("keep"),
        pullRequest: null,
        workspaces: recordingStrip(calls),
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          calls.length = 0;
          const archived = {
            ...card,
            archivedAt: "2026-01-02T00:00:00.000Z" as BoardCard["archivedAt"],
          };
          yield* h.pumpDomain({
            type: "board.card-archived",
            sequence: 1,
            payload: { cardId: card.id, archivedAt: archived.archivedAt, card: archived },
          } as unknown as HarnessEvent);
          yield* h.reactor.drain;
          assert.deepEqual(calls, [false]);
          assert.deepEqual(yield* h.removedWorktrees, []);
        }),
    );
  });
});

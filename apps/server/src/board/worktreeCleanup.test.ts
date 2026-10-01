// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3O-52: finished cards give their worktree back, and a kept one says why.
 *
 * The supervisor half — which cards are swept, when, and what the card records
 * — through the governor harness. The git half (the durability rule itself) is
 * proven against real repositories in `worktree.test.ts`; here the git stub
 * answers "durable" or not, and the assertions are about what the board does
 * with that answer.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  BOARD_SEED_STAGE_IDS,
  type BoardCard,
  type BoardCardPullRequest,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
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
  model: Ref.Ref<OrchestrationReadModel>,
  cardId: string,
  edit: (card: BoardCard) => BoardCard,
) =>
  Ref.update(model, (current) => ({
    ...current,
    board:
      current.board === undefined || current.board === null
        ? current.board
        : {
            ...current.board,
            cards: current.board.cards.map((card) => (card.id === cardId ? edit(card) : card)),
          },
  }));

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

  it.effect(
    "Check again reclaims a kept archived card outside Done with reclaimWorktreeOnDone off",
    () =>
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

  it.effect("Check again on a Done card with Done cleanup off says it is not reclaimed", () =>
    withGovernor(
      {
        board: { nextCardNumberByProject: {}, cards: [doneCard()] },
        settings: settings(false),
        pullRequest: null,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          const result = yield* h.reactor.checkWorktree((yield* h.board).cards[0]!.id);
          assert.deepEqual(result, { outcome: "not-finished" });
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

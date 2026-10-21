/**
 * T3o (T3O-64, D21): a card placed on a worker has its git and forge work done
 * THERE, against the live reactor.
 *
 * Placement does not exist yet (T3O-65), so these suites supply their own: one
 * card is placed on an in-process worker whose `boardWorker.git.*` handlers run
 * a local workspace of the worker's own. Every git command the worker runs is
 * logged separately from the central server's, so "on that worker" is a
 * checked fact: the central server runs none for the placed card.
 *
 * And a worker the board cannot reach is no git failure: nothing is reported
 * on the card, no provisioning attempt is spent, and the next pass retries.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  type BoardCard,
  type BoardCardPullRequest,
  type VcsStatusChangeRequest,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  cardMoved,
  codexStep,
  makeBoardCard,
  movedToBuilding,
  readyWorktree,
  settingsWith,
  withGovernor,
  type HarnessCommand,
  type HarnessEvent,
} from "../supervisorHarness.testkit.ts";
import { bindBoardWorkspace } from "./BoardWorkspace.ts";
import {
  makeInProcessWorker,
  remoteOver,
  TEST_WORKER_ID,
  type InProcessWorker,
} from "./inProcessWorker.testkit.ts";
import type { LocalBoardWorkspaceDeps } from "./LocalBoardWorkspace.ts";
import { makeBoardWorkspaces } from "./workspaceLayer.ts";

const BUILDING = String(BOARD_SEED_STAGE_IDS.building);
const REVIEW = String(BOARD_SEED_STAGE_IDS.review);
const MERGE = String(BOARD_SEED_STAGE_IDS.merge);
const DONE = String(BOARD_SEED_STAGE_IDS.done);

const placedId = BoardCardId.make("card-1");

/** The worker's checkouts as git lists them: its project, then the card's
    worktree — so the worker recognises the paths the board names. */
const workerWorktrees = (...paths: ReadonlyArray<readonly [string, string]>) =>
  [
    "worktree /worker/project",
    "branch refs/heads/main",
    "",
    ...paths.flatMap(([path, branch]) => [`worktree ${path}`, `branch refs/heads/${branch}`, ""]),
  ].join("\n");

interface Placement {
  readonly worker: () => InProcessWorker;
  /** Every git argv the WORKER ran. */
  readonly workerGit: Array<ReadonlyArray<string>>;
  readonly workspaces: (local: LocalBoardWorkspaceDeps) => ReturnType<typeof makeBoardWorkspaces>;
}

/**
 * Card `card-1` placed on an in-process worker; every other card local. The
 * worker's workspace runs over the harness's own git stub (so fixtures answer
 * the same), wrapped to log what the worker ran.
 */
const placeCardOnWorker = (options: { readonly reachable?: boolean } = {}): Placement => {
  const workerGit: Array<ReadonlyArray<string>> = [];
  let worker: InProcessWorker | null = null;
  // The stub's worktrees are not on disk; a real private git dir takes the
  // central board's owner marker.
  let privateGitDir: string | null = null;
  return {
    workerGit,
    worker: () => worker!,
    workspaces: (local) => {
      const git = {
        ...local.git,
        execute: (input: Parameters<GitVcsDriver.GitVcsDriver["Service"]["execute"]>[0]) => {
          workerGit.push(input.args);
          const ran = local.git.execute(input);
          if (input.args[0] !== "rev-parse" || input.args[1] !== "--absolute-git-dir") return ran;
          return ran.pipe(
            Effect.flatMap(() =>
              privateGitDir !== null
                ? Effect.succeed(privateGitDir)
                : local.fileSystem.makeTempDirectory({ prefix: "t3o-worker-gitdir-" }).pipe(
                    Effect.tap((dir) => Effect.sync(() => void (privateGitDir = dir))),
                    Effect.orDie,
                  ),
            ),
            Effect.map((dir) => ({ stdout: `${dir}\n`, stderr: "", exitCode: 0 })),
          );
        },
      } as GitVcsDriver.GitVcsDriver["Service"];
      worker = makeInProcessWorker(
        makeBoardWorkspaces({
          ...local,
          git,
          projectRoot: () => Effect.succeed("/worker/project"),
        }),
      );
      worker.reachable = options.reachable ?? true;
      const remote = remoteOver(worker);
      return makeBoardWorkspaces(local, {
        placementOf: (card) =>
          Effect.succeed(
            card.id === placedId ? { workerId: TEST_WORKER_ID, projectId: card.projectId } : null,
          ),
        remote: (placement) =>
          Effect.succeed(
            bindBoardWorkspace({
              workspace: remote,
              projectId: placement.projectId,
              checkoutPath: "/worker/project",
            }),
          ),
      });
    },
  };
};

const commandsOf = (commands: ReadonlyArray<HarnessCommand>, type: string, cardId = placedId) =>
  commands.filter(
    (command) =>
      command.type === type && String((command as { cardId?: unknown }).cardId) === String(cardId),
  );

const worktreeFailures = (events: ReadonlyArray<HarnessEvent>) =>
  events.filter(
    (event) =>
      event.type === "board.card-worktree-failed" &&
      String(event.payload.cardId) === String(placedId),
  );

const building = (id: string): BoardCard => makeBoardCard({ id, stage: BUILDING, orderKey: "m" });

const openPr: VcsStatusChangeRequest = {
  number: 501,
  title: "A placed card",
  url: "https://example.test/pull/501",
  baseRef: "main",
  headRef: "board/card-1",
  state: "open",
};

const linkedPr: BoardCardPullRequest = {
  number: openPr.number,
  url: openPr.url,
  state: "open",
  title: null,
  headBranch: openPr.headRef,
  baseRef: openPr.baseRef,
  checkedAt: "2026-01-01T00:00:00.000Z",
};

describe("a card placed on a worker (T3O-64)", () => {
  it.effect("provisions its worktree on that worker", () => {
    const placement = placeCardOnWorker();
    return withGovernor(
      {
        board: { cards: [building("card-1")], nextCardNumberByProject: {} },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 4 }),
        registeredWorktrees: workerWorktrees(["/tmp/worktrees/board/card-1", "board/card-1"]),
        workspaces: placement.workspaces,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(building("card-1"), 1));
          const commands = yield* h.commands;
          assert.strictEqual(commandsOf(commands, "board.card.provision-worktree").length, 1);
          const recorded = commandsOf(commands, "board.card.record-worktree");
          assert.strictEqual(recorded.length, 1);
          assert.strictEqual(
            (recorded[0] as { readonly path: string }).path,
            "/tmp/worktrees/board/card-1",
          );
          const calls = placement.worker().calls;
          for (const method of [
            "boardWorker.git.resolveDefaultBranch",
            "boardWorker.git.ensureLocalBaseBranch",
            // Pins gh's default inside, on the worker.
            "boardWorker.git.provisionWorktree",
          ] as const) {
            assert.include(calls, method);
          }
          // Every git command for the card ran on the worker.
          assert.deepStrictEqual(yield* h.gitInvocations, placement.workerGit);
          assert.isAbove(placement.workerGit.length, 0);
        }),
    );
  });

  it.effect("reads its pull request, and merges it, through that worker", () => {
    const placement = placeCardOnWorker();
    const atMerge = makeBoardCard({
      id: "card-1",
      stage: MERGE,
      orderKey: "m",
      worktree: readyWorktree("card-1"),
      pullRequest: linkedPr,
    });
    return withGovernor(
      {
        board: { cards: [atMerge], nextCardNumberByProject: {} },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
        pullRequest: openPr,
        registeredWorktrees: workerWorktrees(["/tmp/wt/card-1", "board/card-1"]),
        workspaces: placement.workspaces,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(cardMoved(atMerge, REVIEW, MERGE, 1));
          yield* h.reactor.refreshPullRequest(placedId, { force: true });
          const result = yield* h.reactor.mergePullRequest(placedId);
          assert.strictEqual(result.outcome, "merged");
          assert.strictEqual((yield* h.mergeAttempts).length, 1);
          const calls = placement.worker().calls;
          assert.include(calls, "boardWorker.git.mergePullRequest");
          // The post-merge fast-forward runs on the merging card's worker.
          assert.include(calls, "boardWorker.git.pullMergedBaseBranch");
          assert.isTrue(
            calls.includes("boardWorker.git.getPullRequest") ||
              calls.includes("boardWorker.git.pullRequestByBranch"),
          );
          assert.deepStrictEqual(yield* h.gitInvocations, placement.workerGit);
        }),
    );
  });

  it.effect("reclaims its worktree on that worker once it is Done", () => {
    const placement = placeCardOnWorker();
    const done = makeBoardCard({
      id: "card-1",
      stage: DONE,
      orderKey: "d",
      worktree: readyWorktree("card-1"),
    });
    return withGovernor(
      {
        board: { cards: [done], nextCardNumberByProject: {} },
        settings: settingsWith({
          building: [codexStep],
          globalMaxConcurrent: 4,
          reclaimWorktreeOnDone: true,
        }),
        pullRequest: null,
        registeredWorktrees: workerWorktrees(["/tmp/wt/card-1", "board/card-1"]),
        workspaces: placement.workspaces,
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.reactor.drainWorktreeSweep;
          assert.deepStrictEqual(yield* h.removedWorktrees, ["/tmp/wt/card-1"]);
          assert.strictEqual((yield* h.board).cards[0]!.worktree?.status, "reclaimed");
          const calls = placement.worker().calls;
          for (const method of [
            "boardWorker.git.goneWorktreePath",
            "boardWorker.git.probeWorktreeDurability",
            "boardWorker.git.retireWorktree",
          ] as const) {
            assert.include(calls, method);
          }
          assert.deepStrictEqual(yield* h.gitInvocations, placement.workerGit);
        }),
    );
  });
});

describe("a worker the board cannot reach (T3O-64)", () => {
  it.effect(
    "spends no provisioning attempt, reports nothing, and provisions once it is back",
    () => {
      const placement = placeCardOnWorker({ reachable: false });
      return withGovernor(
        {
          board: {
            cards: [building("card-1"), building("other-1"), building("other-2")],
            nextCardNumberByProject: {},
          },
          settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 4 }),
          registeredWorktrees: workerWorktrees(["/tmp/worktrees/board/card-1", "board/card-1"]),
          workspaces: placement.workspaces,
        },
        (h) =>
          Effect.gen(function* () {
            yield* h.pumpDomain(movedToBuilding(building("card-1"), 1));
            // Another card's arrival runs another pass, still unreachable.
            yield* h.pumpDomain(movedToBuilding(building("other-1"), 2));
            const before = yield* h.commands;
            assert.strictEqual(commandsOf(before, "board.card.provision-worktree").length, 0);
            assert.strictEqual(commandsOf(before, "board.card.fail-worktree").length, 0);
            assert.strictEqual(commandsOf(before, "board.card.recover-step").length, 0);
            assert.strictEqual(worktreeFailures(yield* h.decided).length, 0);
            const card = (yield* h.board).cards.find((entry) => entry.id === placedId)!;
            assert.isNull(card.worktree);

            placement.worker().reachable = true;
            yield* h.pumpDomain(movedToBuilding(building("other-2"), 3));
            const after = yield* h.commands;
            assert.strictEqual(commandsOf(after, "board.card.provision-worktree").length, 1);
            assert.strictEqual(commandsOf(after, "board.card.record-worktree").length, 1);
            const provisioned = (yield* h.board).cards.find((entry) => entry.id === placedId)!;
            assert.strictEqual(provisioned.worktree?.status, "ready");
            assert.strictEqual(provisioned.worktree?.attempts, 1);
          }),
      );
    },
  );

  it.effect("a provision the worker drops mid-way resumes without a second attempt", () => {
    const placement = placeCardOnWorker();
    return withGovernor(
      {
        board: {
          cards: [building("card-1"), building("other-1")],
          nextCardNumberByProject: {},
        },
        settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 4 }),
        registeredWorktrees: workerWorktrees(["/tmp/worktrees/board/card-1", "board/card-1"]),
        workspaces: (local) => {
          const shape = placement.workspaces(local);
          placement.worker().dropOn.add("boardWorker.git.provisionWorktree");
          return shape;
        },
      },
      (h) =>
        Effect.gen(function* () {
          yield* h.pumpDomain(movedToBuilding(building("card-1"), 1));
          const dropped = (yield* h.board).cards.find((entry) => entry.id === placedId)!;
          // The slice is recorded and still provisioning; nothing failed.
          assert.strictEqual(dropped.worktree?.status, "provisioning");
          assert.strictEqual(dropped.worktree?.attempts, 1);
          assert.strictEqual(worktreeFailures(yield* h.decided).length, 0);

          placement.worker().dropOn.clear();
          yield* h.pumpDomain(movedToBuilding(building("other-1"), 2));
          const commands = yield* h.commands;
          assert.strictEqual(commandsOf(commands, "board.card.provision-worktree").length, 1);
          assert.strictEqual(commandsOf(commands, "board.card.record-worktree").length, 1);
          const resumed = (yield* h.board).cards.find((entry) => entry.id === placedId)!;
          assert.strictEqual(resumed.worktree?.status, "ready");
          assert.strictEqual(resumed.worktree?.attempts, 1);
          assert.strictEqual(worktreeFailures(yield* h.decided).length, 0);
        }),
    );
  });

  it.effect(
    "a merge against an unreachable worker is refused as retryable, not as a failure",
    () => {
      const placement = placeCardOnWorker();
      const atMerge = makeBoardCard({
        id: "card-1",
        stage: MERGE,
        orderKey: "m",
        worktree: readyWorktree("card-1"),
        pullRequest: linkedPr,
      });
      return withGovernor(
        {
          board: { cards: [atMerge], nextCardNumberByProject: {} },
          settings: settingsWith({ building: [codexStep], globalMaxConcurrent: 3 }),
          pullRequest: openPr,
          registeredWorktrees: workerWorktrees(["/tmp/wt/card-1", "board/card-1"]),
          workspaces: placement.workspaces,
        },
        (h) =>
          Effect.gen(function* () {
            placement.worker().reachable = false;
            const result = yield* h.reactor.mergePullRequest(placedId);
            assert.strictEqual(result.outcome, "refused");
            // Never put to the forge, and never read as a conflict to fix.
            assert.strictEqual((yield* h.mergeAttempts).length, 0);
            assert.strictEqual((yield* h.mergeStateProbes).length, 0);
            assert.isFalse("permanent" in result && result.permanent === true);
          }),
      );
    },
  );
});

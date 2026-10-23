/**
 * T3o (T3O-65, prototype 5.1–5.4): moving a card to another worker.
 *
 * The mover against a decider-backed engine double and stub workspaces that
 * log which worker each git operation ran on — so "retired on A, provisioned
 * on B" is a checked fact, and a failed provision is shown not to touch A.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  BoardCardId,
  BoardStageId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
  type BoardCardStepState,
  type BoardCardWorktree,
  type BoardState,
  type BoardWorkerId,
  type BoardWorkerView,
  type BoardWorkspaceDurability,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { BoardEngine, type BoardEngineShape } from "../BoardEngine.ts";
import { boardDecidedEvents, type BoardCommand } from "../decider.ts";
import { decideBoardCommandOnModel } from "../decisionContext.testkit.ts";
import { projectBoardEvent, type BoardEvent } from "../projector.ts";
import { ThreadGateway, type ThreadGatewayShape } from "../ThreadGateway.ts";
import {
  BoardWorkspaces,
  type BoardCardWorkspace,
  type BoardWorkspacesShape,
} from "../workspace/BoardWorkspace.ts";
import { WorkerUnavailable } from "./WorkerConnections.ts";
import { BoardCardMover, BoardCardMoverLive, boardPushRequestText } from "./BoardCardMove.ts";
import { BoardPlacement } from "./BoardPlacement.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const cardId = BoardCardId.make("card-1");
const W1 = EnvironmentId.make("env-w1");
const REPOSITORY = {
  canonicalKey: "github.com/acme/repo",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/repo.git",
  },
  provider: "github",
  owner: "acme",
  name: "repo",
} as const;

const readyWorktree: BoardCardWorktree = {
  branch: "board/t3-1",
  baseRefName: "main",
  path: "/tmp/worktrees/t3-1",
  status: "ready",
  attempts: 1,
  lastError: null,
  reclaimBlockedReason: null,
};

const makeCard = (overrides: Partial<BoardCard> = {}): BoardCard => ({
  id: cardId,
  key: "T3-1",
  cardNumber: 1,
  projectId,
  labels: [],
  stage: BoardStageId.make("building"),
  orderKey: "m",
  title: "Card",
  briefRef: null,
  dependsOn: [],
  parentCardId: null,
  sourcePlanId: null,
  threadLinks: [
    {
      threadId: ThreadId.make("thread-build"),
      role: "building",
      linkedAt: NOW,
      tombstonedAt: null,
    },
  ],
  attachments: [],
  externalRef: null,
  humanInLoop: null,
  reviewOverrides: null,
  modelOverrides: null,
  splitRationale: null,
  baseBranch: null,
  scheduledStartAt: null,
  autoStart: false,
  autoMerge: false,
  autoMergeHold: null,
  pinnedWorkerId: null,
  placedWorkerId: BOARD_LOCAL_WORKER_ID,
  workerMove: null,
  placementOrphaned: null,
  worktree: readyWorktree,
  pullRequest: null,
  pullRequestHistory: [],
  pullRequestFloor: null,
  blocked: false,
  archivedAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const runningStep = (status: BoardCardStepState["status"]): BoardCardStepState => ({
  cardId,
  stepId: "building",
  stepLabel: null,
  stageLabel: "Building",
  attempt: 1,
  stallCount: 0,
  stageEntryRecoveries: 0,
  humanTurnAt: null,
  lastNudgeAt: null,
  baseTipAtRoundStart: null,
  lastError: null,
  awaitingReason: "question",
  stalledReason: "gave-up",
  retryAt: null,
  prompt: "build it",
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
  mode: "build",
  runtimeMode: "full-access",
  humanInLoop: false,
  maxAttempts: 3,
  timeoutMs: 60_000,
  threadId: ThreadId.make("thread-build"),
  status,
  slotHeld: status === "running",
  forceStart: false,
  queuedBy: null,
  startedAt: NOW,
  updatedAt: NOW,
});

const workerView = (online = true): BoardWorkerView => ({
  id: W1,
  label: "w1",
  url: "http://w1:3773",
  addedAt: NOW,
  status: {
    state: online ? "online" : "offline",
    lastSeenAt: null,
    t3oVersion: null,
    protocolVersion: 1,
  },
  snapshot: {
    providers: [],
    checkouts: [
      {
        projectId: ProjectId.make("w1-project"),
        title: "repo",
        workspaceRoot: "/home/w1/repo",
        repositoryKey: "github.com/acme/repo",
      },
    ],
    projectsFolder: null,
    reportedAt: NOW,
  },
});

const clean: BoardWorkspaceDurability = {
  hasWorkingTreeChanges: false,
  changedPaths: [],
  openPullRequestNumber: null,
  durable: true,
  unmergedCount: 0,
  unpushedCount: 0,
  hasUpstream: true,
  unpushedCommits: [],
  baseFetched: false,
};

interface Fixture {
  readonly board: BoardState;
  readonly online?: boolean;
  readonly durability?: BoardWorkspaceDurability | "unreachable";
  readonly provisionFails?: string;
  /** The source refuses to retire: a git error, or something written since the check. */
  readonly retireFails?: "error" | "blocked";
  /** The card's branch was never pushed (T3O-66). */
  readonly noRemoteBranch?: boolean;
  /** The target can't reach the remote to ask about the branch. */
  readonly remoteUnreachable?: boolean;
  /** What every probe after the first finds: work written since the check. */
  readonly durabilityAfterCheck?: BoardWorkspaceDurability;
}

/** Every git operation the move ran, with the worker it ran on. */
type GitCall = readonly [worker: BoardWorkerId, operation: string];

const makeLayer = (fixture: Fixture) =>
  Effect.gen(function* () {
    const model = yield* Ref.make({
      snapshotSequence: 0,
      projects: [],
      threads: [],
      board: fixture.board,
      updatedAt: NOW,
    } as never as Parameters<typeof decideBoardCommandOnModel>[0]["readModel"]);
    const events = yield* Ref.make<ReadonlyArray<BoardEvent>>([]);
    const git = yield* Ref.make<ReadonlyArray<GitCall>>([]);
    const sent = yield* Ref.make<ReadonlyArray<{ threadId: string; text: string }>>([]);
    let sequence = 0;
    let probes = 0;

    const engine = {
      dispatch: (command: BoardCommand) =>
        Effect.gen(function* () {
          const decided = boardDecidedEvents(
            yield* decideBoardCommandOnModel({ command, readModel: yield* Ref.get(model) }),
          );
          for (const planned of decided) {
            const event = { ...planned, sequence: ++sequence } as BoardEvent;
            yield* Ref.set(model, yield* projectBoardEvent(yield* Ref.get(model), event));
            yield* Ref.update(events, (all) => [...all, event]);
          }
          return { sequence };
        }).pipe(Effect.orDie),
      getReadModel: Ref.get(model),
      latestSequence: Effect.sync(() => sequence),
      streamBoardEvents: () => Stream.empty,
      liveBoardEvents: Stream.empty,
      subscribeBoardEvents: Effect.succeed(Stream.empty),
    } as unknown as BoardEngineShape;

    const workspaceOn = (workerId: BoardWorkerId) => {
      const log = (operation: string) =>
        Ref.update(git, (all) => [...all, [workerId, operation] as const]);
      return {
        workerId,
        projectId,
        checkoutPath: "/checkout",
        probeWorktreeDurability: () =>
          log("probeWorktreeDurability").pipe(
            Effect.andThen(
              fixture.durability === "unreachable"
                ? Effect.fail(
                    new WorkerUnavailable({ workerId: W1, state: "offline", message: "offline" }),
                  )
                : Effect.sync(() =>
                    ++probes > 1 && fixture.durabilityAfterCheck !== undefined
                      ? fixture.durabilityAfterCheck
                      : (fixture.durability ?? clean),
                  ),
            ),
          ),
        remoteBranchTip: () =>
          log("remoteBranchTip").pipe(
            Effect.andThen(
              fixture.remoteUnreachable === true
                ? Effect.fail({
                    _tag: "BoardWorkerGitError",
                    operation: "remoteBranchTip",
                    detail: "The remote origin couldn't be reached.",
                  })
                : Effect.succeed(
                    fixture.noRemoteBranch === true
                      ? null
                      : { sha: "4e1a9c2", subject: "Wire it", committedAt: NOW, author: "agent" },
                  ),
            ),
          ),
        retireWorktree: () =>
          log("retireWorktree").pipe(
            Effect.andThen(
              fixture.retireFails === "error"
                ? Effect.fail({
                    _tag: "BoardWorkerGitError",
                    operation: "retireWorktree",
                    detail: "fatal: worktree is locked",
                  })
                : Effect.succeed(
                    fixture.retireFails === "blocked"
                      ? ({ outcome: "blocked", reason: "it has uncommitted changes" } as const)
                      : ({ outcome: "removed", hookWarning: null } as const),
                  ),
            ),
          ),
        provisionWorktreeFromRemoteBranch: (input: { branch: string; baseRefName: string }) =>
          log("provisionWorktreeFromRemoteBranch").pipe(
            Effect.andThen(
              fixture.provisionFails === undefined
                ? Effect.succeed({
                    path: `/home/${workerId}/worktrees/t3-1`,
                    branch: input.branch,
                    baseRefName: input.baseRefName,
                  })
                : Effect.fail({
                    _tag: "BoardWorkerGitError",
                    operation: "provisionWorktreeFromRemoteBranch",
                    detail: fixture.provisionFails,
                  }),
            ),
          ),
      } as unknown as BoardCardWorkspace;
    };

    const workspaces = {
      forCard: () =>
        Effect.map(Ref.get(model), (m) =>
          workspaceOn(m.board!.cards[0]!.placedWorkerId ?? BOARD_LOCAL_WORKER_ID),
        ),
      forWorker: (workerId: BoardWorkerId) => Effect.succeed(workspaceOn(workerId)),
    } as unknown as BoardWorkspacesShape;

    const threads = {
      project: () =>
        Effect.succeed({ id: projectId, workspaceRoot: "/repo", repositoryIdentity: REPOSITORY }),
      send: (input: { threadId: string; text: string }) =>
        Ref.update(sent, (all) => [...all, { threadId: input.threadId, text: input.text }]),
    } as unknown as ThreadGatewayShape;

    const layer = BoardCardMoverLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(BoardEngine, engine),
          Layer.succeed(BoardWorkspaces, workspaces),
          Layer.succeed(ThreadGateway, threads),
          Layer.succeed(BoardPlacement, {
            workers: Effect.succeed({
              defaultWorkerId: BOARD_LOCAL_WORKER_ID,
              workers: [workerView(fixture.online ?? true)],
              setups: [],
            }),
            changes: Stream.empty,
          }),
        ),
      ),
    );
    return {
      layer,
      card: Effect.map(Ref.get(model), (m) => m.board!.cards[0]!),
      events: Ref.get(events),
      git: Ref.get(git),
      sent: Ref.get(sent),
    };
  });

const board = (card: BoardCard, stepStates?: ReadonlyArray<BoardCardStepState>): BoardState => ({
  cards: [card],
  nextCardNumberByProject: {},
  workers: [{ id: W1, label: "w1", url: "http://w1:3773", addedAt: NOW }],
  ...(stepStates === undefined ? {} : { stepStates }),
});

/** Run `body` with the mover over a fixture. */
const withMover = <A>(
  fixture: Fixture,
  body: (
    mover: BoardCardMover["Service"],
    f: Effect.Success<ReturnType<typeof makeLayer>>,
  ) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const f = yield* makeLayer(fixture);
    return yield* Effect.flatMap(BoardCardMover, (mover) => body(mover, f)).pipe(
      Effect.provide(f.layer),
    );
  });

it.layer(NodeServices.layer)("moving a card to another worker (T3O-65)", (it) => {
  it.effect("a card with no worktree is a pin, not a move", () =>
    withMover({ board: board(makeCard({ worktree: null, placedWorkerId: null })) }, (mover) =>
      Effect.gen(function* () {
        expect(yield* mover.check(cardId, W1)).toEqual({ outcome: "pin" });
      }),
    ),
  );

  it.effect("refuses while a step is running, naming its thread", () =>
    withMover({ board: board(makeCard(), [runningStep("running")]) }, (mover, f) =>
      Effect.gen(function* () {
        const checked = yield* mover.move(cardId, W1);
        assert.strictEqual(checked.outcome, "step-running");
        if (checked.outcome === "step-running") {
          expect(checked.threadId).toBe("thread-build");
          expect(checked.workerId).toBe(BOARD_LOCAL_WORKER_ID);
        }
        expect(yield* f.git).toEqual([]);
        expect(yield* f.events).toEqual([]);
      }),
    ),
  );

  it.effect("refuses unpushed work, listing the commits and files", () =>
    withMover(
      {
        board: board(makeCard()),
        durability: {
          ...clean,
          durable: false,
          unpushedCount: 2,
          unpushedCommits: [
            { sha: "b81f0de", subject: "Wire typed bridge into preload" },
            { sha: "9c03a1e", subject: "Add IPC schema tests" },
          ],
          hasWorkingTreeChanges: true,
          changedPaths: ["src/bridge.ts", "src/ipc/gen.ts"],
        },
      },
      (mover, f) =>
        Effect.gen(function* () {
          const checked = yield* mover.move(cardId, W1);
          assert.strictEqual(checked.outcome, "unpushed");
          if (checked.outcome === "unpushed") {
            expect(checked.unpushedCount).toBe(2);
            expect(checked.commits.map((commit) => commit.sha)).toEqual(["b81f0de", "9c03a1e"]);
            expect(checked.changedPaths).toEqual(["src/bridge.ts", "src/ipc/gen.ts"]);
            expect(checked.branch).toBe("board/t3-1");
          }
          // Nothing was retired or provisioned.
          expect((yield* f.git).map(([, operation]) => operation)).toEqual([
            "probeWorktreeDurability",
          ]);
          expect((yield* f.card).workerMove).toBeNull();
        }),
    ),
  );

  it.effect("refuses a branch with no upstream, and a source that doesn't answer", () =>
    Effect.gen(function* () {
      yield* withMover(
        { board: board(makeCard()), durability: { ...clean, hasUpstream: false } },
        (mover) =>
          Effect.gen(function* () {
            expect((yield* mover.check(cardId, W1)).outcome).toBe("no-upstream");
          }),
      );
      yield* withMover({ board: board(makeCard()), durability: "unreachable" }, (mover) =>
        Effect.gen(function* () {
          expect(yield* mover.check(cardId, W1)).toEqual({
            outcome: "source-unreachable",
            workerId: BOARD_LOCAL_WORKER_ID,
          });
        }),
      );
    }),
  );

  it.effect("refuses a target that is offline", () =>
    withMover({ board: board(makeCard()), online: false }, (mover) =>
      Effect.gen(function* () {
        const checked = yield* mover.check(cardId, W1);
        assert.strictEqual(checked.outcome, "refused");
        if (checked.outcome === "refused") expect(checked.detail).toContain("offline");
      }),
    ),
  );

  it.effect("when pushed: retires on the source, provisions on the target, updates the path", () =>
    withMover({ board: board(makeCard()) }, (mover, f) =>
      Effect.gen(function* () {
        const checked = yield* mover.check(cardId, W1);
        expect(checked).toEqual({
          outcome: "ready",
          fromWorkerId: BOARD_LOCAL_WORKER_ID,
          branch: "board/t3-1",
          tip: { sha: "4e1a9c2", subject: "Wire it", committedAt: NOW, author: "agent" },
        });
        expect(yield* mover.move(cardId, W1)).toEqual({ outcome: "started" });
        yield* mover.drain;

        expect(
          (yield* f.git).filter(
            ([, operation]) =>
              operation === "retireWorktree" || operation === "provisionWorktreeFromRemoteBranch",
          ),
        ).toEqual([
          [BOARD_LOCAL_WORKER_ID, "retireWorktree"],
          [W1, "provisionWorktreeFromRemoteBranch"],
        ]);
        const moved = yield* f.card;
        expect(moved.worktree?.path).toBe("/home/env-w1/worktrees/t3-1");
        expect(moved.worktree?.status).toBe("ready");
        expect(moved.placedWorkerId).toBe(W1);
        expect(moved.pinnedWorkerId).toBe(W1);
        expect(moved.workerMove).toBeNull();
        // Each step is on the record, in order.
        expect(
          (yield* f.events).map((event) =>
            event.type === "board.card-worker-move-recorded"
              ? event.payload.step.phase
              : event.type,
          ),
        ).toEqual(["start", "retired", "done"]);
      }),
    ),
  );

  it.effect("Follow default moves to the board's default and lands the card unpinned", () =>
    withMover({ board: { ...board(makeCard()), defaultWorkerId: W1 } }, (mover, f) =>
      Effect.gen(function* () {
        expect(yield* mover.move(cardId, null)).toEqual({ outcome: "started" });
        yield* mover.drain;
        const landed = yield* f.card;
        expect(landed.placedWorkerId).toBe(W1);
        expect(landed.worktree?.path).toBe(`/home/${W1}/worktrees/t3-1`);
        // Following, not pinned: once the worktree goes, a default change moves it.
        expect(landed.pinnedWorkerId).toBeNull();
      }),
    ),
  );

  it.effect("a failed provision leaves Move failed and does not restore the old worktree", () =>
    withMover(
      { board: board(makeCard()), provisionFails: "fatal: couldn't find remote ref board/t3-1" },
      (mover, f) =>
        Effect.gen(function* () {
          expect(yield* mover.move(cardId, W1)).toEqual({ outcome: "started" });
          yield* mover.drain;
          const failed = yield* f.card;
          expect(failed.workerMove?.status).toBe("failed");
          expect(failed.workerMove?.error).toContain("couldn't find remote ref");
          expect(failed.worktree?.status).toBe("reclaimed");
          expect(failed.placedWorkerId).toBeNull();
          // Nothing was provisioned back on the source.
          expect(
            (yield* f.git).filter(
              ([worker, operation]) =>
                worker === BOARD_LOCAL_WORKER_ID &&
                operation === "provisionWorktreeFromRemoteBranch",
            ),
          ).toEqual([]);
        }),
    ),
  );

  it.effect("a failed retire keeps the card on its source, worktree intact and movable", () =>
    Effect.gen(function* () {
      for (const retireFails of ["error", "blocked"] as const) {
        yield* withMover({ board: board(makeCard()), retireFails }, (mover, f) =>
          Effect.gen(function* () {
            const answer = yield* mover.move(cardId, W1);
            assert.strictEqual(answer.outcome, "refused");
            if (answer.outcome === "refused") expect(answer.detail).toContain("stays on");
            yield* mover.drain;
            const kept = yield* f.card;
            // Not wedged in Move failed: the card runs on where it was.
            expect(kept.workerMove).toBeNull();
            expect(kept.worktree?.status).toBe("ready");
            expect(kept.worktree?.path).toBe(readyWorktree.path);
            expect(kept.placedWorkerId).toBe(BOARD_LOCAL_WORKER_ID);
            expect((yield* f.git).map(([, operation]) => operation)).not.toContain(
              "provisionWorktreeFromRemoteBranch",
            );
            // The failure is still on the record for the activity rail.
            const phases = (yield* f.events).flatMap((event) =>
              event.type === "board.card-worker-move-recorded" ? [event.payload.step.phase] : [],
            );
            expect(phases).toEqual(["start", "failed"]);
            // And it can be checked for a move again.
            expect((yield* mover.check(cardId, W1)).outcome).toBe("ready");
          }),
        );
      }
    }),
  );

  it.effect("a move cut off by a restart is closed when the mover starts", () =>
    Effect.gen(function* () {
      const moving = {
        fromWorkerId: BOARD_LOCAL_WORKER_ID,
        toWorkerId: W1,
        status: "moving",
        sha: "4e1a9c2",
        error: null,
        startedAt: NOW,
      } as const;
      // Cut off before retire: the card still holds its worktree, so it stays
      // where it was and can be moved again.
      yield* withMover({ board: board(makeCard({ workerMove: moving })) }, (mover, f) =>
        Effect.gen(function* () {
          expect((yield* f.card).workerMove).toBeNull();
          expect((yield* mover.check(cardId, W1)).outcome).toBe("ready");
        }),
      );
      // Cut off after retire: Move failed, and a retry provisions on the target.
      const retired = makeCard({
        workerMove: moving,
        placedWorkerId: null,
        worktree: { ...readyWorktree, path: null, status: "reclaimed" },
      });
      yield* withMover({ board: board(retired) }, (mover, f) =>
        Effect.gen(function* () {
          const failed = (yield* f.card).workerMove;
          expect(failed?.status).toBe("failed");
          expect(failed?.error).toContain("restarted");
          expect((yield* mover.move(cardId, W1)).outcome).toBe("started");
          yield* mover.drain;
          expect((yield* f.card).placedWorkerId).toBe(W1);
        }),
      );
    }),
  );

  it.effect("a retry after a failed move provisions from the remote without retiring", () =>
    withMover(
      {
        board: board(
          makeCard({
            placedWorkerId: null,
            worktree: { ...readyWorktree, path: null, status: "reclaimed" },
            workerMove: {
              fromWorkerId: BOARD_LOCAL_WORKER_ID,
              toWorkerId: W1,
              status: "failed",
              sha: null,
              error: "Creating the worktree failed: disk full",
              startedAt: NOW,
            },
          }),
        ),
      },
      (mover, f) =>
        Effect.gen(function* () {
          const checked = yield* mover.check(cardId, W1);
          assert.strictEqual(checked.outcome, "ready");
          if (checked.outcome === "ready") expect(checked.fromWorkerId).toBeNull();
          yield* mover.move(cardId, W1);
          yield* mover.drain;
          expect((yield* f.git).map(([, operation]) => operation)).not.toContain("retireWorktree");
          expect((yield* f.card).placedWorkerId).toBe(W1);
          expect((yield* f.card).workerMove).toBeNull();
        }),
    ),
  );

  it.effect("refuses a branch gone from the remote before anything is retired", () =>
    // The upstream still resolves locally, so nothing reads as unpushed.
    withMover({ board: board(makeCard()), noRemoteBranch: true }, (mover, f) =>
      Effect.gen(function* () {
        const moved = yield* mover.move(cardId, W1);
        assert.strictEqual(moved.outcome, "refused");
        if (moved.outcome === "refused") expect(moved.detail).toContain("isn't on the remote");
        expect((yield* f.git).map(([, operation]) => operation)).not.toContain("retireWorktree");
        expect(yield* f.events).toEqual([]);
        expect((yield* f.card).worktree?.status).toBe("ready");
      }),
    ),
  );

  it.effect("a failed move whose branch left the remote restarts from base once confirmed", () =>
    withMover(
      {
        board: board(
          makeCard({
            stage: BoardStageId.make("review"),
            placedWorkerId: null,
            worktree: { ...readyWorktree, path: null, status: "reclaimed" },
            workerMove: {
              fromWorkerId: BOARD_LOCAL_WORKER_ID,
              toWorkerId: W1,
              status: "failed",
              sha: null,
              error: "Creating the worktree failed: couldn't find remote ref",
              startedAt: NOW,
            },
          }),
        ),
        noRemoteBranch: true,
      },
      (mover, f) =>
        Effect.gen(function* () {
          expect(yield* mover.check(cardId, W1)).toEqual({
            outcome: "no-remote-branch",
            workerId: BOARD_LOCAL_WORKER_ID,
            branch: "board/t3-1",
            baseRefName: "main",
            backToStage: "Building",
          });
          // Unconfirmed, nothing happens.
          expect((yield* mover.move(cardId, W1)).outcome).toBe("no-remote-branch");
          expect(yield* f.events).toEqual([]);
          expect(yield* mover.move(cardId, W1, undefined, { restartFromBase: true })).toEqual({
            outcome: "started",
          });
          const card = yield* f.card;
          expect(card.workerMove).toBeNull();
          expect(card.worktree).toBeNull();
          expect(card.stage).toBe("building");
          expect(card.pinnedWorkerId).toBe(W1);
        }),
    ),
  );

  it.effect("work written between the check and the retire refuses the move", () =>
    withMover(
      {
        board: board(makeCard()),
        durabilityAfterCheck: { ...clean, durable: false, unpushedCount: 1 },
      },
      (mover, f) =>
        Effect.gen(function* () {
          const moved = yield* mover.move(cardId, W1);
          assert.strictEqual(moved.outcome, "refused");
          if (moved.outcome === "refused") expect(moved.detail).toContain("stays on");
          yield* mover.drain;
          expect((yield* f.git).map(([, operation]) => operation)).toEqual([
            "probeWorktreeDurability",
            "remoteBranchTip",
            "probeWorktreeDurability",
          ]);
          const kept = yield* f.card;
          expect(kept.workerMove).toBeNull();
          expect(kept.worktree?.status).toBe("ready");
          expect(kept.placedWorkerId).toBe(BOARD_LOCAL_WORKER_ID);
        }),
    ),
  );

  it.effect("ask agent to push sends the request to the card's latest thread", () =>
    withMover({ board: board(makeCard(), [runningStep("succeeded")]) }, (mover, f) =>
      Effect.gen(function* () {
        expect(yield* mover.askAgentToPush(cardId)).toEqual({
          outcome: "sent",
          threadId: "thread-build",
        });
        expect(yield* f.sent).toEqual([
          { threadId: "thread-build", text: boardPushRequestText("board/t3-1") },
        ]);
      }),
    ),
  );

  // ── Force-move (T3O-66, prototype 5.5–5.6) ──────────────────────────

  /** A card with a worktree on W1, which is offline. */
  const onOfflineW1 = (stepStates?: ReadonlyArray<BoardCardStepState>): Fixture => ({
    board: board(makeCard({ placedWorkerId: W1, worktree: readyWorktree }), stepStates),
    online: false,
  });

  it.effect("force-move is refused while the card's worker is reachable", () =>
    withMover(
      { board: board(makeCard({ placedWorkerId: W1, worktree: readyWorktree })) },
      (mover) =>
        Effect.gen(function* () {
          const checked = yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID, { force: true });
          assert.strictEqual(checked.outcome, "refused");
        }),
    ),
  );

  it.effect("force-move off an offline worker continues from the remote branch", () =>
    withMover(onOfflineW1([runningStep("running")]), (mover, f) =>
      Effect.gen(function* () {
        const checked = yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID, { force: true });
        assert.strictEqual(checked.outcome, "ready");
        if (checked.outcome === "ready") {
          expect(checked.fromWorkerId).toBe(W1);
          expect(checked.tip?.sha).toBe("4e1a9c2");
        }
        // Without force it can't even be checked.
        expect((yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID)).outcome).toBe("step-running");
        const started = yield* mover.move(cardId, BOARD_LOCAL_WORKER_ID, undefined, {
          force: true,
        });
        expect(started).toEqual({ outcome: "started" });
        yield* mover.drain;
        // Nothing ran on W1: the remote branch was read and provisioned here.
        expect(yield* f.git).toEqual([
          [BOARD_LOCAL_WORKER_ID, "remoteBranchTip"],
          [BOARD_LOCAL_WORKER_ID, "remoteBranchTip"],
          [BOARD_LOCAL_WORKER_ID, "provisionWorktreeFromRemoteBranch"],
        ]);
        const phases = (yield* f.events).flatMap((event) =>
          event.type === "board.card-worker-move-recorded" ? [event.payload.step] : [],
        );
        expect(phases.map((step) => step.phase)).toEqual(["start", "abandoned", "done"]);
        expect(phases[0]).toMatchObject({ force: true, sha: "4e1a9c2" });
        // The abandoned worktree is recorded where it was left.
        expect(phases[1]).toEqual({ phase: "abandoned", worktreePath: readyWorktree.path });
        const card = yield* f.card;
        expect(card.placedWorkerId).toBe(BOARD_LOCAL_WORKER_ID);
        expect(card.worktree?.path).toBe(`/home/${BOARD_LOCAL_WORKER_ID}/worktrees/t3-1`);
      }),
    ),
  );

  it.effect("force-move off a removed worker continues from the remote branch", () =>
    withMover(
      {
        board: {
          ...board(
            makeCard({
              placedWorkerId: W1,
              worktree: readyWorktree,
              placementOrphaned: { workerId: W1, workerLabel: "w1", orphanedAt: NOW },
            }),
          ),
          workers: [],
        },
      },
      (mover, f) =>
        Effect.gen(function* () {
          const checked = yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID, { force: true });
          assert.strictEqual(checked.outcome, "ready");
          yield* mover.move(cardId, BOARD_LOCAL_WORKER_ID, undefined, { force: true });
          yield* mover.drain;
          const card = yield* f.card;
          expect(card.placementOrphaned).toBeNull();
          expect(card.placedWorkerId).toBe(BOARD_LOCAL_WORKER_ID);
        }),
    ),
  );

  it.effect("with no remote branch, force-move restarts from base only once confirmed", () =>
    withMover(
      {
        ...onOfflineW1(),
        board: board(
          makeCard({
            stage: BoardStageId.make("review"),
            placedWorkerId: W1,
            worktree: readyWorktree,
          }),
        ),
        noRemoteBranch: true,
      },
      (mover, f) =>
        Effect.gen(function* () {
          const checked = yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID, { force: true });
          expect(checked).toEqual({
            outcome: "no-remote-branch",
            workerId: W1,
            branch: "board/t3-1",
            baseRefName: "main",
            backToStage: "Building",
          });
          // The first confirmation is not enough.
          const unconfirmed = yield* mover.move(cardId, BOARD_LOCAL_WORKER_ID, undefined, {
            force: true,
          });
          expect(unconfirmed.outcome).toBe("no-remote-branch");
          expect(yield* f.events).toEqual([]);
          const restarted = yield* mover.move(cardId, BOARD_LOCAL_WORKER_ID, undefined, {
            force: true,
            restartFromBase: true,
          });
          expect(restarted).toEqual({ outcome: "started" });
          yield* mover.drain;
          expect((yield* f.git).map(([, operation]) => operation)).not.toContain(
            "provisionWorktreeFromRemoteBranch",
          );
          const card = yield* f.card;
          // Back to the start of Build, the branch forgotten, on the target.
          expect(card.stage).toBe("building");
          expect(card.worktree).toBeNull();
          expect(card.pinnedWorkerId).toBe(BOARD_LOCAL_WORKER_ID);
          expect(card.workerMove).toBeNull();
          expect(card.title).toBe("Card");
        }),
    ),
  );

  it.effect("a remote that can't be asked refuses the force-move rather than offer a restart", () =>
    withMover({ ...onOfflineW1(), remoteUnreachable: true }, (mover, f) =>
      Effect.gen(function* () {
        const checked = yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID, { force: true });
        assert.strictEqual(checked.outcome, "refused");
        const moved = yield* mover.move(cardId, BOARD_LOCAL_WORKER_ID, undefined, {
          force: true,
          restartFromBase: true,
        });
        assert.strictEqual(moved.outcome, "refused");
        expect(yield* f.events).toEqual([]);
      }),
    ),
  );

  it.effect("with no remote branch, a Done card is not restarted", () =>
    withMover(
      {
        ...onOfflineW1(),
        board: board(
          makeCard({
            stage: BoardStageId.make("done"),
            placedWorkerId: W1,
            worktree: readyWorktree,
          }),
        ),
        noRemoteBranch: true,
      },
      (mover, f) =>
        Effect.gen(function* () {
          assert.strictEqual(
            (yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID, { force: true })).outcome,
            "refused",
          );
          const moved = yield* mover.move(cardId, BOARD_LOCAL_WORKER_ID, undefined, {
            force: true,
            restartFromBase: true,
          });
          assert.strictEqual(moved.outcome, "refused");
          expect(yield* f.events).toEqual([]);
          expect((yield* f.card).stage).toBe("done");
        }),
    ),
  );

  it.effect("with no remote branch, a card not yet at Build restarts in its own stage", () =>
    withMover(
      {
        ...onOfflineW1(),
        board: board(
          makeCard({
            stage: BoardStageId.make("planning"),
            placedWorkerId: W1,
            worktree: readyWorktree,
          }),
        ),
        noRemoteBranch: true,
      },
      (mover, f) =>
        Effect.gen(function* () {
          // The confirmation is told the card keeps its stage.
          const checked = yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID, { force: true });
          expect(checked).toMatchObject({ outcome: "no-remote-branch", backToStage: null });
          const restarted = yield* mover.move(cardId, BOARD_LOCAL_WORKER_ID, undefined, {
            force: true,
            restartFromBase: true,
          });
          expect(restarted).toEqual({ outcome: "started" });
          const card = yield* f.card;
          expect(card.stage).toBe("planning");
          expect(card.worktree).toBeNull();
          expect(card.workerMove).toBeNull();
        }),
    ),
  );

  it.effect("force-move of a card with no worktree re-pins it", () =>
    withMover(
      { board: board(makeCard({ worktree: null, pinnedWorkerId: W1 })), online: false },
      (mover, f) =>
        Effect.gen(function* () {
          expect(yield* mover.check(cardId, BOARD_LOCAL_WORKER_ID, { force: true })).toEqual({
            outcome: "pin",
          });
          expect(
            yield* mover.move(cardId, BOARD_LOCAL_WORKER_ID, undefined, { force: true }),
          ).toEqual({ outcome: "started" });
          expect((yield* f.card).pinnedWorkerId).toBe(BOARD_LOCAL_WORKER_ID);
        }),
    ),
  );
});

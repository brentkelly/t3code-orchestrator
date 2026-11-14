/**
 * The central server's worker management, as a service so RPC handlers, MCP tools
 * and agents share one path. Workers join with a code through `BoardWorkerJoin`;
 * `remove` deletes nothing on the worker.
 */
import * as FileSystem from "effect/FileSystem";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  BOARD_LOCAL_WORKER_ABBREVIATION,
  BOARD_LOCAL_WORKER_ID,
  BOARD_WORKER_SETUP_LOG_MAX_LENGTH,
  BoardWorkerActionError,
  boardCardEffectiveWorkerId,
  boardCardStepState,
  boardCardWorkerRemovalOutcome,
  boardStageById,
  boardThreadLinkWorkerId,
  boardWorkerProxyPath,
  CommandId,
  EMPTY_BOARD_STATE,
  ProjectId,
  type BoardWorker,
  type BoardWorkerJoinCodeCreated,
  type BoardWorkerRemovePreview,
  type BoardWorkerRemovePreviewCard,
  type BoardWorkerSetup,
  type BoardWorkersRenameInput,
  type BoardWorkersSetupProjectInput,
  type BoardWorkersState,
  type BoardWorkerId,
  type BoardWorkerRemovalClassification,
  boardCardHoldsWorktree,
  type BoardWorkerThreadAccess,
  type BoardWorkerView,
  type EnvironmentId,
  type ProjectCloneSnapshot,
  type BoardCardId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BoardWorkerJoin } from "../tunnel/BoardWorkerJoin.ts";
import { BoardWorkerJoinStore } from "../tunnel/BoardWorkerJoinStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { GitVcsDriver } from "../../vcs/GitVcsDriver.ts";
import { BoardWorkspaces, type BoardCardWorkspace } from "../workspace/BoardWorkspace.ts";
import { BoardEngine } from "../BoardEngine.ts";
import { isBoardCommandInvariantError } from "../errors.ts";
import { classifyCloneFailure, cloneDestination, cloneFailureMessage } from "./setupFailure.ts";
import { WorkerConnections, workerSecretName } from "./WorkerConnections.ts";
import { BoardRelayStore } from "./BoardRelayStore.ts";
import { bootStatus } from "./WorkerSnapshotStore.ts";
import { WorkerRpcError, type WorkerRpc } from "./WorkerTransport.ts";

/** What a board user may hold on a worker: never more than their own board scopes. */
const BOARD_USER_WORKER_SCOPES = [
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthFilesystemReadScope,
] as const;

export interface BoardWorkersShape {
  readonly createJoinCode: Effect.Effect<BoardWorkerJoinCodeCreated>;
  readonly cancelJoinCode: (codeId: string) => Effect.Effect<void, BoardWorkerActionError>;
  readonly rename: (input: BoardWorkersRenameInput) => Effect.Effect<void, BoardWorkerActionError>;
  /** A session for this caller on a worker, to open its threads through the board. */
  readonly threadAccess: (
    workerId: EnvironmentId,
    caller: {
      readonly sessionId: string;
      readonly scopes: ReadonlyArray<string>;
      readonly deviceLabel: string;
    },
  ) => Effect.Effect<BoardWorkerThreadAccess, BoardWorkerActionError>;
  readonly remove: (
    workerId: EnvironmentId,
  ) => Effect.Effect<{ readonly revoked: boolean }, BoardWorkerActionError>;
  /** What removing the worker would do to its cards. */
  readonly removePreview: (
    workerId: EnvironmentId,
  ) => Effect.Effect<BoardWorkerRemovePreview, BoardWorkerActionError>;
  readonly setDefault: (workerId: BoardWorkerId) => Effect.Effect<void, BoardWorkerActionError>;
  readonly setupProject: (
    input: BoardWorkersSetupProjectInput,
  ) => Effect.Effect<BoardWorkerSetup, BoardWorkerActionError>;
  /** T3o: clone a project into its folder on this server, only when the folder is missing or
      empty, with this server's own git credentials (T3O-87). Planning needs the checkout. */
  readonly cloneHere: (projectId: ProjectId) => Effect.Effect<void, BoardWorkerActionError>;
  readonly dismissSetup: (input: {
    readonly projectId: ProjectId;
    readonly workerId: EnvironmentId;
  }) => Effect.Effect<void>;
  /** The board's worker summary now. */
  readonly state: Effect.Effect<BoardWorkersState>;
  /** The summary now, then again after every runtime change — connection
      status, snapshots, setups — subscribed atomically with the first read.
      Registry changes ride the board log. Each access subscribes. */
  readonly states: Stream.Stream<BoardWorkersState>;
  /** T3o: workers mid-removal, which no card is placed on (T3O-87). */
  readonly beingRemoved: Effect.Effect<ReadonlySet<BoardWorkerId>>;
}

export class BoardWorkers extends Context.Service<BoardWorkers, BoardWorkersShape>()(
  "t3/board/workers/BoardWorkers",
) {}

/** How long Remove waits for the worker to give the session back. */
const RELEASE_TIMEOUT = "5 seconds";

/** How long Remove waits for the worker to stop each running step. */
const STOP_TIMEOUT = "5 seconds";

/** How many times, a second apart, Remove reads a stopped step's thread for its turn to end. */
const TURN_END_CHECKS = 30;

/** How long Set up waits for the worker to accept the clone. Starting one
    only checks the folder and spawns git, so this is generous. */
const SETUP_START_TIMEOUT = "30 seconds";

const setupKey = (workerId: EnvironmentId, projectId: ProjectId) => `${workerId}\u0000${projectId}`;

const actionError = (code: BoardWorkerActionError["code"], message: string) =>
  new BoardWorkerActionError({ code, message });

/**
 * T3o: one worktree's fate when its worker is removed (T3O-87): pushed where the remote lacks
 * commits, then `reclaimed` (branch kept) or `fresh` (nothing beyond its base, no remote
 * branch), else `orphaned` for a human: dirty, unpushable, or the worker didn't answer.
 */
export const classifyRemovalWorktree = Effect.fn("BoardWorkers.classifyRemovalWorktree")(function* (
  workspace: BoardCardWorkspace,
  worktree: {
    readonly worktreePath: string;
    readonly branch: string;
    readonly baseRefName: string;
  },
) {
  const orphaned = "orphaned" as const;
  const probe = yield* workspace
    .probeWorktreeDurability({
      ...worktree,
      mergedPullRequestNumbers: [],
      openPullRequestNumber: null,
      baseAlreadyFetched: false,
    })
    .pipe(Effect.option);
  if (Option.isNone(probe) || probe.value.hasWorkingTreeChanges) return orphaned;
  // Read afresh each time: after a push it must see the branch the push just made.
  const onRemote = Effect.suspend(() =>
    workspace.remoteBranchTip({ branch: worktree.branch }),
  ).pipe(
    Effect.map((tip) => tip !== null),
    Effect.orElseSucceed(() => null),
  );
  if (probe.value.unpushedCount === 0) {
    const remote = yield* onRemote;
    if (remote === null) return orphaned;
    if (remote) return "reclaimed" as const;
    if (probe.value.hasUpstream) return orphaned;
    // Nothing beyond its base and no remote branch: the next placement cuts it fresh.
    if (probe.value.unmergedCount === 0) return "fresh" as const;
    // Commits beyond its base that no remote branch of its own holds: push them below.
  }
  // Commits the remote lacks: push the card's own branch, never forced. A worker too old to
  // know the operation can't be pushed.
  const pushed = yield* workspace
    .pushCardBranch({ worktreePath: worktree.worktreePath, branch: worktree.branch })
    .pipe(Effect.orElseSucceed(() => ({ pushed: false, detail: null })));
  if (!pushed.pushed) return orphaned;
  return (yield* onRemote) === true ? ("reclaimed" as const) : orphaned;
});

export const makeBoardWorkers = Effect.gen(function* () {
  const engine = yield* BoardEngine;
  const connections = yield* WorkerConnections;
  const secrets = yield* ServerSecretStore;
  const environment = yield* ServerEnvironment;
  const projects = yield* ProjectService;
  const git = yield* GitVcsDriver;
  // T3o: where removal probes and pushes a card's worktree (T3O-87). Absent in a harness.
  const workspaces = yield* Effect.serviceOption(BoardWorkspaces);
  /** Workers mid-removal: the gate and step spawns skip them. In memory only. */
  const beingRemoved = new Set<BoardWorkerId>();
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* SecureRandom.SecureRandom;
  const relayStore = yield* BoardRelayStore;
  const join = yield* BoardWorkerJoin;
  const joinStore = yield* BoardWorkerJoinStore;
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  const sessionStore = yield* Effect.serviceOption(SessionStore);

  const setups = yield* SubscriptionRef.make(new Map<string, BoardWorkerSetup>());
  const followers = yield* FiberMap.make<string>();

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  // A failing random source is a broken host, not something a caller handles.
  const newUuid = crypto.uuidV4().pipe(Effect.orDie);
  const newCommandId = newUuid.pipe(Effect.map(CommandId.make));
  const registry = engine.getReadModel.pipe(
    Effect.map((model) => model.board?.workers ?? ([] as ReadonlyArray<BoardWorker>)),
  );
  const defaultWorkerId = engine.getReadModel.pipe(
    Effect.map((model): BoardWorkerId => model.board?.defaultWorkerId ?? BOARD_LOCAL_WORKER_ID),
  );

  const syncConnections = registry.pipe(Effect.flatMap(connections.sync));
  const localLabel = Option.isNone(serverSettings)
    ? Effect.succeed<string | null>(null)
    : serverSettings.value.getSettings.pipe(
        Effect.map((settings) => settings.board?.workers.localLabel ?? null),
        Effect.orElseSucceed(() => null),
      );

  const state: BoardWorkersShape["state"] = Effect.gen(function* () {
    const workers = yield* registry;
    const runtime = yield* connections.current;
    return {
      defaultWorkerId: yield* defaultWorkerId,
      workers: workers.map((worker): BoardWorkerView => ({
        ...worker,
        status: runtime.get(worker.id)?.status ?? bootStatus(undefined),
        snapshot: runtime.get(worker.id)?.snapshot ?? null,
      })),
      setups: [...(yield* SubscriptionRef.get(setups)).values()],
      joinCodes: yield* join.views,
      localLabel: yield* localLabel,
    };
  });

  /** Best effort: an unreadable cursor already reads as "start at the head". */
  const forgetSignalCursor = (workerId: EnvironmentId) =>
    relayStore
      .forgetSignalCursor(workerId)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board worker cursor not forgotten", { workerId, cause }),
        ),
      );

  // ── Joining, renaming and thread access (T3O-84) ───────────────────

  const createJoinCode: BoardWorkersShape["createJoinCode"] = join.createCode;
  const cancelJoinCode: BoardWorkersShape["cancelJoinCode"] = join.cancelCode;

  const rename: BoardWorkersShape["rename"] = Effect.fn("BoardWorkers.rename")(function* (input) {
    if (input.workerId === BOARD_LOCAL_WORKER_ID) {
      if (input.abbreviation !== BOARD_LOCAL_WORKER_ABBREVIATION) {
        return yield* actionError(
          "invalid",
          `The board server's abbreviation is always ${BOARD_LOCAL_WORKER_ABBREVIATION}.`,
        );
      }
      if (Option.isNone(serverSettings)) return yield* actionError("internal", "No settings here.");
      yield* serverSettings.value
        .updateSettings({ board: { workers: { localLabel: input.label } } })
        .pipe(Effect.mapError(() => actionError("internal", "The new name wasn't saved.")));
      return;
    }
    const worker = (yield* registry).find((candidate) => candidate.id === input.workerId);
    if (worker === undefined) {
      return yield* actionError("not-found", "That worker isn't on this board.");
    }
    yield* engine
      .dispatch({
        type: "board.worker.register",
        commandId: yield* newCommandId,
        mode: "rename",
        worker: { ...worker, label: input.label, abbreviation: input.abbreviation },
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.mapError((cause) =>
          isBoardCommandInvariantError(cause)
            ? actionError("invalid", cause.message)
            : actionError("internal", cause.message),
        ),
      );
  });

  const threadAccess: BoardWorkersShape["threadAccess"] = Effect.fn("BoardWorkers.threadAccess")(
    function* (workerId, caller) {
      const worker = (yield* registry).find((candidate) => candidate.id === workerId);
      if (worker === undefined) {
        return yield* actionError("not-found", "That worker isn't on this board.");
      }
      const scopes = BOARD_USER_WORKER_SCOPES.filter((scope) => caller.scopes.includes(scope));
      if (!scopes.includes(AuthOrchestrationReadScope)) {
        return yield* actionError("forbidden", "Your session can't read threads on this board.");
      }
      const rpc = yield* connections
        .get(workerId)
        .pipe(Effect.mapError(() => actionError("not-online", `${worker.label} is offline.`)));
      const central = yield* environment.getDescriptor;
      const issued = yield* rpc
        .mintUserSession({
          boardSessionId: caller.sessionId,
          scopes,
          label: `${caller.deviceLabel} via T3o board (${central.label})`,
        })
        .pipe(Effect.mapError((error) => actionError("not-online", error.message)));
      return {
        workerId,
        path: boardWorkerProxyPath(workerId),
        bearerToken: issued.bearerToken,
        expiresAt: issued.expiresAt,
      };
    },
  );

  /** A board client session went: so do the worker sessions minted for it. Workers
      offline now catch up from `liveBoardSessionIds` when their tunnel comes back. */
  const revokeUserSessionsFor = Effect.fn("BoardWorkers.revokeUserSessionsFor")(function* (
    boardSessionId: string,
  ) {
    for (const worker of yield* registry) {
      const rpc = yield* connections.get(worker.id).pipe(Effect.option);
      if (Option.isNone(rpc)) continue;
      yield* rpc.value
        .revokeUserSessions([boardSessionId])
        .pipe(Effect.timeout(RELEASE_TIMEOUT), Effect.ignore);
    }
  });

  const readBoard = engine.getReadModel.pipe(
    Effect.map((model) => model.board ?? EMPTY_BOARD_STATE),
  );

  /** The registered worker removal is about. The default worker is retired (T3O-87). */
  const removable = Effect.fn("BoardWorkers.removable")(function* (workerId: EnvironmentId) {
    const worker = (yield* registry).find((candidate) => candidate.id === workerId);
    if (worker === undefined) {
      return yield* actionError("not-found", "That worker isn't on this board.");
    }
    return worker;
  });

  const removePreview: BoardWorkersShape["removePreview"] = Effect.fn("BoardWorkers.removePreview")(
    function* (workerId) {
      const worker = yield* removable(workerId);
      const board = yield* readBoard;
      const toDefault: BoardWorkerRemovePreviewCard[] = [];
      const byHand: BoardWorkerRemovePreviewCard[] = [];
      for (const card of board.cards) {
        if (card.archivedAt !== null) continue;
        const live = boardCardStepState(board, card.id);
        const outcome = boardCardWorkerRemovalOutcome(card, live, workerId);
        if (outcome === null) continue;
        const running =
          live !== null && (live.status === "running" || live.status === "completing");
        const row = {
          cardId: card.id,
          key: card.key,
          title: card.title,
          detail:
            outcome === "fallback"
              ? (boardStageById(board, card.stage)?.label ?? card.stage)
              : running
                ? `${live.stepLabel ?? live.stageLabel ?? "Current"} step running`
                : "Has worktree",
          running,
        };
        (outcome === "fallback" ? toDefault : byHand).push(row);
      }
      // Removing the default itself leaves this server as the default.
      const fallbackTo =
        board.defaultWorkerId === undefined || board.defaultWorkerId === workerId
          ? BOARD_LOCAL_WORKER_ID
          : board.defaultWorkerId;
      return {
        workerId,
        workerLabel: worker.label,
        defaultWorkerLabel:
          fallbackTo === BOARD_LOCAL_WORKER_ID
            ? "This server (local)"
            : ((yield* registry).find((candidate) => candidate.id === fallbackTo)?.label ??
              fallbackTo),
        toDefault,
        byHand,
      };
    },
  );

  /** The steps running on a worker, which removal parks and stops. */
  const runningStepsOn = (workerId: EnvironmentId) =>
    readBoard.pipe(
      Effect.map((board) =>
        board.cards.flatMap((card) => {
          const live = boardCardStepState(board, card.id);
          if (live === null || live.threadId === null) return [];
          if (live.status !== "running" && live.status !== "completing") return [];
          // Where its thread runs: the link says, else where the card runs.
          const link = card.threadLinks.find((candidate) => candidate.threadId === live.threadId);
          const runsOn =
            link === undefined ? boardCardEffectiveWorkerId(card) : boardThreadLinkWorkerId(link);
          return runsOn === workerId
            ? [{ cardId: card.id, stepId: live.stepId, threadId: live.threadId }]
            : [];
        }),
      ),
    );

  /**
   * T3o: what removal does with each card on a reachable worker (T3O-87): a card with no
   * worktree there is unplaced; a clean worktree is pushed where the remote lacks commits, then
   * reclaimed with its branch kept, or cleared when it has nothing beyond its base; anything
   * dirty or unpushable waits for a human. Nothing on the worker is deleted.
   */
  const classifyForRemoval = Effect.fn("BoardWorkers.classifyForRemoval")(function* (
    workerId: EnvironmentId,
    /** Cards whose step may still be writing to its worktree: never probed, a human decides. */
    unsettled: ReadonlySet<BoardCardId>,
  ) {
    const board = yield* readBoard;
    const classifications: Array<BoardWorkerRemovalClassification> = [];
    for (const card of board.cards) {
      if (card.placedWorkerId !== workerId && card.pinnedWorkerId !== workerId) continue;
      if (card.placedWorkerId !== workerId || !boardCardHoldsWorktree(card)) {
        classifications.push({ cardId: card.id, outcome: "unplaced" });
        continue;
      }
      const worktree = card.worktree;
      if (
        Option.isNone(workspaces) ||
        worktree === null ||
        worktree.path === null ||
        unsettled.has(card.id)
      ) {
        classifications.push({ cardId: card.id, outcome: "orphaned" });
        continue;
      }
      const workspace = yield* workspaces.value.forWorker(workerId, card.projectId);
      classifications.push({
        cardId: card.id,
        outcome: yield* classifyRemovalWorktree(workspace, {
          worktreePath: worktree.path,
          branch: worktree.branch,
          baseRefName: worktree.baseRefName,
        }),
      });
    }
    return classifications;
  });

  /** Whether a stopped thread's turn has ended, read for up to TURN_END_CHECKS seconds. */
  const turnEnded = Effect.fn("BoardWorkers.turnEnded")(function* (
    gateway: WorkerRpc["gateway"],
    threadId: ThreadId,
  ) {
    for (let check = 0; check < TURN_END_CHECKS; check += 1) {
      const read = yield* gateway
        .threadState(threadId)
        .pipe(Effect.timeout(STOP_TIMEOUT), Effect.option);
      if (Option.isNone(read)) return false;
      const thread = read.value;
      if (
        thread === null ||
        !thread.alive ||
        (thread.activeTurnRef === null &&
          thread.sessionStatus !== "running" &&
          thread.sessionStatus !== "starting")
      ) {
        return true;
      }
      yield* Effect.sleep("1 second");
    }
    return false;
  });

  const remove: BoardWorkersShape["remove"] = Effect.fn("BoardWorkers.remove")(
    function* (workerId) {
      yield* removable(workerId);
      // T3o: no card is placed there, and no step starts there, while it is removed (T3O-87).
      beingRemoved.add(workerId);
      return yield* removeSequence(workerId).pipe(
        Effect.ensuring(Effect.sync(() => beingRemoved.delete(workerId))),
      );
    },
  );

  const removeSequence = Effect.fn("BoardWorkers.removeSequence")(function* (
    workerId: EnvironmentId,
  ) {
    const running = yield* runningStepsOn(workerId);
    const rpc = yield* connections.get(workerId).pipe(Effect.option);
    // T3o: park each running step the way a human Stop does, then stop its session, before
    // anything is probed: a stop alone reads as an unattended turn ending, and the supervisor
    // would put the agent back to work mid-probe (T3O-87).
    // A step that wasn't parked, or whose turn didn't end, could still commit after its probe.
    const unsettled = new Set<BoardCardId>();
    if (Option.isSome(rpc)) {
      const stopped: Array<{ readonly step: (typeof running)[number]; readonly paused: boolean }> =
        [];
      for (const step of running) {
        const paused = yield* engine
          .dispatch({
            type: "board.card.pause-step",
            commandId: yield* newCommandId,
            cardId: step.cardId,
            stepId: step.stepId,
            createdAt: yield* nowIso,
          })
          .pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        yield* rpc.value.gateway
          .stopSession({ commandId: yield* newCommandId, threadId: step.threadId })
          .pipe(Effect.timeout(STOP_TIMEOUT), Effect.ignore);
        stopped.push({ step, paused });
      }
      // Every step is stopped before any is waited on, so the waits run side by side.
      const ended = yield* Effect.forEach(
        stopped,
        ({ step }) => turnEnded(rpc.value.gateway, step.threadId),
        { concurrency: "unbounded" },
      );
      stopped.forEach(({ step, paused }, index) => {
        if (!paused || !ended[index]) unsettled.add(step.cardId);
      });
    }
    const classifications = Option.isSome(rpc)
      ? yield* classifyForRemoval(workerId, unsettled)
      : [];
    // The record goes after the sequence and before release: a removal the decider refuses
    // must leave the worker's session and token intact.
    yield* engine
      .dispatch({
        type: "board.worker.remove",
        commandId: yield* newCommandId,
        workerId,
        ...(classifications.length === 0 ? {} : { classifications }),
        createdAt: yield* nowIso,
      })
      .pipe(Effect.mapError((cause) => actionError("internal", cause.message)));
    // Then every session this board holds there goes back over the tunnel, before
    // its listener closes in the sync below. Unreachable is fine: the tunnel
    // credential is revoked here, and a worker coming back to a board that no longer
    // knows it revokes the board's sessions itself.
    const revoked = Option.isNone(rpc)
      ? false
      : yield* rpc.value.releaseAll.pipe(
          Effect.timeout(RELEASE_TIMEOUT),
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
    yield* joinStore.revokeCredentials({ workerId, at: yield* nowIso });
    yield* secrets.remove(workerSecretName(workerId)).pipe(Effect.ignore);
    yield* syncConnections;
    yield* forgetSignalCursor(workerId);
    yield* dropSetups(workerId);
    return { revoked };
  });

  const setDefault: BoardWorkersShape["setDefault"] = Effect.fn("BoardWorkers.setDefault")(
    function* (workerId) {
      if ((yield* defaultWorkerId) === workerId) return;
      if (workerId !== BOARD_LOCAL_WORKER_ID) {
        const current = yield* state;
        const worker = current.workers.find((candidate) => candidate.id === workerId);
        if (worker === undefined) {
          return yield* actionError("not-found", "That worker isn't on this board.");
        }
        if (worker.status.state !== "online") {
          return yield* actionError(
            "not-online",
            `${worker.label} is ${worker.status.state}. Only online, compatible, paired workers can be the default.`,
          );
        }
      }
      yield* engine
        .dispatch({
          type: "board.worker.set-default",
          commandId: yield* newCommandId,
          workerId,
          createdAt: yield* nowIso,
        })
        .pipe(Effect.mapError((cause) => actionError("internal", cause.message)));
    },
  );

  // ── Project setup ──────────────────────────────────────────────────

  const putSetup = (setup: BoardWorkerSetup) =>
    SubscriptionRef.update(setups, (map) =>
      new Map(map).set(setupKey(setup.workerId, setup.projectId), setup),
    );

  const patchSetup = (key: string, patch: Partial<BoardWorkerSetup>) =>
    SubscriptionRef.update(setups, (map) => {
      const current = map.get(key);
      return current === undefined ? map : new Map(map).set(key, { ...current, ...patch });
    });

  const dropSetups = Effect.fn("BoardWorkers.dropSetups")(function* (workerId: EnvironmentId) {
    const map = yield* SubscriptionRef.get(setups);
    for (const [key, setup] of map) {
      if (setup.workerId !== workerId) continue;
      yield* FiberMap.remove(followers, key);
    }
    yield* SubscriptionRef.set(
      setups,
      new Map([...map].filter(([, setup]) => setup.workerId !== workerId)),
    );
  });

  const failed = (
    workerLabel: string,
    text: string,
    forcedKind?: NonNullable<BoardWorkerSetup["failure"]>["kind"],
  ): NonNullable<BoardWorkerSetup["failure"]> => {
    const kind = forcedKind ?? classifyCloneFailure(text);
    return {
      kind,
      message: cloneFailureMessage(kind, workerLabel),
      log: text.slice(-BOARD_WORKER_SETUP_LOG_MAX_LENGTH),
    };
  };

  /** Follow one clone on the worker until it ends, or the worker goes. */
  const follow = Effect.fn("BoardWorkers.follow")(function* (input: {
    readonly key: string;
    readonly workerId: EnvironmentId;
    readonly workerLabel: string;
    readonly rpc: WorkerRpc;
    readonly workerProjectId: ProjectId;
  }) {
    const last = yield* Ref.make<ProjectCloneSnapshot | null>(null);
    const streamed = yield* input.rpc.projectClones.pipe(
      Stream.map((clones) => clones.find((clone) => clone.projectId === input.workerProjectId)),
      Stream.filter((clone): clone is ProjectCloneSnapshot => clone !== undefined),
      Stream.runForEachWhile((clone) =>
        Ref.set(last, clone).pipe(
          Effect.andThen(
            clone.phase === "running"
              ? patchSetup(input.key, { stage: clone.stage, percent: clone.percent })
              : Effect.void,
          ),
          Effect.as(clone.phase === "running"),
        ),
      ),
      Effect.result,
    );
    const final = yield* Ref.get(last);
    const endedAt = yield* nowIso;
    if (streamed._tag === "Failure" || final === null || final.phase === "running") {
      yield* patchSetup(input.key, {
        phase: "failed",
        endedAt,
        failure: failed(input.workerLabel, final?.error ?? "", "worker-offline"),
      });
      return;
    }
    if (final.phase === "done") {
      yield* patchSetup(input.key, { phase: "done", percent: 100, endedAt, failure: null });
      yield* connections.refresh(input.workerId);
      return;
    }
    const log = [final.detail, final.error].filter((line) => line !== null).join("\n");
    yield* patchSetup(input.key, {
      phase: "failed",
      endedAt,
      failure:
        final.phase === "cancelled"
          ? failed(input.workerLabel, log || "The clone was cancelled on the worker.", "unknown")
          : failed(input.workerLabel, log),
    });
  });

  const cloneHere: BoardWorkersShape["cloneHere"] = Effect.fn("BoardWorkers.cloneHere")(
    function* (projectId) {
      const project = yield* projects.getShell(projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (project === null) {
        return yield* actionError("not-found", "That project isn't on this board server.");
      }
      const root = project.workspaceRoot;
      const originUrl = yield* git
        .readConfigValue(root, "remote.origin.url")
        .pipe(Effect.orElseSucceed(() => null));
      const remoteUrl = originUrl ?? project.repositoryIdentity?.locator.remoteUrl ?? null;
      if (remoteUrl === null || remoteUrl.trim().length === 0) {
        return yield* actionError(
          "no-remote",
          `${project.title} has no known git remote, so it can't be cloned here.`,
        );
      }
      const entries = yield* fileSystem
        .readDirectory(root)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      if (entries.length > 0) {
        return yield* actionError(
          "folder-exists",
          `${root} already exists and isn't empty, so nothing was cloned into it.`,
        );
      }
      yield* fileSystem
        .makeDirectory(root, { recursive: true })
        .pipe(
          Effect.mapError(() => actionError("internal", `Couldn't create ${root} on this server.`)),
        );
      const cloned = yield* git
        .execute({
          operation: "board.workers.cloneHere",
          cwd: root,
          args: ["clone", "--", remoteUrl, "."],
          allowNonZeroExit: true,
          timeoutMs: null,
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (cloned === null || cloned.exitCode !== 0) {
        const detail = (cloned?.stderr ?? "").trim().split("\n").slice(-3).join(" ");
        return yield* actionError(
          "internal",
          `Cloning ${project.title} here failed${detail === "" ? "." : `: ${detail}`}`,
        );
      }
    },
  );

  const setupProject: BoardWorkersShape["setupProject"] = Effect.fn("BoardWorkers.setupProject")(
    function* (input) {
      const current = yield* state;
      const worker = current.workers.find((candidate) => candidate.id === input.workerId);
      if (worker === undefined) {
        return yield* actionError("not-found", "That worker isn't on this board.");
      }
      const project = yield* projects.getShell(input.projectId).pipe(
        Effect.map(Option.getOrNull),
        Effect.orElseSucceed(() => null),
      );
      if (project === null) {
        return yield* actionError("not-found", "That project isn't on this board server.");
      }
      // The board pushes to and pulls from `origin` (boardRepository.ts), so
      // that is the remote a worker clones.
      const originUrl = yield* git
        .readConfigValue(project.workspaceRoot, "remote.origin.url")
        .pipe(Effect.orElseSucceed(() => null));
      const remoteUrl = originUrl ?? project.repositoryIdentity?.locator.remoteUrl ?? null;
      if (remoteUrl === null || remoteUrl.trim().length === 0) {
        return yield* actionError(
          "no-remote",
          `${project.title} has no git remote, so it can't be set up on another worker.`,
        );
      }
      const rpc = yield* connections
        .get(worker.id)
        .pipe(
          Effect.mapError(() =>
            actionError("not-online", `${worker.label} is ${worker.status.state}.`),
          ),
        );
      const key = setupKey(worker.id, project.id);
      const destinationPath =
        input.folder ?? cloneDestination(worker.snapshot?.projectsFolder ?? "~", remoteUrl);
      const startedAt = yield* nowIso;
      const prior = (yield* SubscriptionRef.get(setups)).get(key);
      // The clone's id is fixed before the network call and kept through failure,
      // so a later Set up finds a clone the worker accepted after we stopped
      // waiting. Never reused for a folder that already existed: a retry would clear it.
      const reusedId =
        prior?.phase === "failed" &&
        prior.destinationPath === destinationPath &&
        prior.failure?.kind !== "folder-exists"
          ? prior.workerProjectId
          : null;
      const workerProjectId = reusedId ?? ProjectId.make(yield* newUuid);
      const setup: BoardWorkerSetup = {
        projectId: project.id,
        workerId: worker.id,
        workerProjectId,
        destinationPath,
        phase: "cloning",
        stage: null,
        percent: null,
        failure: null,
        startedAt,
        endedAt: null,
      };
      // Claimed before going over the network, so a second Set up for the
      // same project and worker joins this one instead of cloning again.
      const previous = yield* SubscriptionRef.modify(
        setups,
        (map): readonly [BoardWorkerSetup | undefined, Map<string, BoardWorkerSetup>] => {
          const existing = map.get(key);
          return [existing, existing?.phase === "cloning" ? map : new Map(map).set(key, setup)];
        },
      );
      if (previous?.phase === "cloning") return previous;

      // Whatever ends this call before the worker's answer is recorded — the
      // client going away, a defect — the claim must not outlive it as a
      // spinner nothing will ever stop.
      const abandonClaim = Effect.gen(function* () {
        const endedAt = yield* nowIso;
        const failure = failed(
          worker.label,
          "Set up stopped before the worker answered.",
          "worker-offline",
        );
        yield* SubscriptionRef.update(setups, (map) =>
          map.get(key) === setup
            ? new Map(map).set(key, { ...setup, phase: "failed", endedAt, failure })
            : map,
        );
      });

      return yield* Effect.gen(function* () {
        // A clone the worker is still running (or finished) is followed
        // again; a failed one it still tracks is retried in place; one it has
        // forgotten (a restart, say) is cloned afresh under the same id.
        const start: Effect.Effect<void, WorkerRpcError> = Effect.gen(function* () {
          if (reusedId !== null) {
            const clones = yield* rpc.projectClones.pipe(Stream.runHead);
            const clone = Option.getOrUndefined(clones)?.find(
              (candidate) => candidate.projectId === reusedId,
            );
            if (clone?.phase === "running" || clone?.phase === "done") return;
            if (yield* rpc.retryProjectClone(reusedId)) return;
          }
          yield* rpc.startProjectClone({
            projectId: workerProjectId,
            title: project.title,
            createdAt: startedAt,
            destinationPath,
            remoteUrl,
          });
        });
        const started = yield* start.pipe(
          Effect.timeoutOrElse({
            duration: SETUP_START_TIMEOUT,
            orElse: () =>
              Effect.fail(new WorkerRpcError({ message: `${worker.label} didn't answer.` })),
          }),
          Effect.result,
        );
        if (started._tag === "Failure") {
          const cause = started.failure.cause;
          const detail =
            typeof cause === "object" && cause !== null && "detail" in cause
              ? String((cause as { readonly detail: unknown }).detail)
              : started.failure.message;
          const failedSetup: BoardWorkerSetup = {
            ...setup,
            phase: "failed",
            endedAt: yield* nowIso,
            failure: failed(worker.label, detail),
          };
          yield* putSetup(failedSetup);
          return failedSetup;
        }
        // A fresh object, so the abandon guard stops matching this claim.
        const cloning: BoardWorkerSetup = { ...setup };
        yield* putSetup(cloning);
        yield* FiberMap.run(
          followers,
          key,
          follow({ key, workerId: worker.id, workerLabel: worker.label, rpc, workerProjectId }),
        );
        return cloning;
      }).pipe(Effect.onExit(() => abandonClaim));
    },
  );

  const dismissSetup: BoardWorkersShape["dismissSetup"] = Effect.fn("BoardWorkers.dismissSetup")(
    function* ({ projectId, workerId }) {
      const key = setupKey(workerId, projectId);
      yield* FiberMap.remove(followers, key);
      yield* SubscriptionRef.update(setups, (map) => {
        const next = new Map(map);
        next.delete(key);
        return next;
      });
    },
  );

  // Registry events are in the board log, and the board subscription re-sends
  // the summary when it replays one; these are the changes the log never sees.
  const states: BoardWorkersShape["states"] = Stream.mergeAll(
    [
      connections.states.pipe(Stream.as(undefined)),
      SubscriptionRef.changes(setups).pipe(Stream.as(undefined)),
      join.changes,
      // Renaming the board server is a settings write, not a log event.
      ...(Option.isNone(serverSettings)
        ? []
        : [
            serverSettings.value.streamChanges.pipe(
              Stream.map((settings) => settings.board?.workers.localLabel ?? null),
              Stream.changes,
              Stream.as(undefined),
            ),
          ]),
    ],
    { concurrency: "unbounded" },
  ).pipe(Stream.mapEffect(() => state));

  // Follow every registered worker's tunnel from boot.
  yield* syncConnections;

  if (Option.isSome(sessionStore)) {
    yield* sessionStore.value.streamChanges.pipe(
      Stream.runForEach((change) =>
        change.type === "clientRemoved" ? revokeUserSessionsFor(change.sessionId) : Effect.void,
      ),
      Effect.forkScoped,
    );
  }

  return {
    createJoinCode,
    cancelJoinCode,
    rename,
    threadAccess,
    remove,
    removePreview,
    setDefault,
    setupProject,
    cloneHere,
    dismissSetup,
    state,
    states,
    beingRemoved: Effect.sync(() => new Set(beingRemoved) as ReadonlySet<BoardWorkerId>),
  } satisfies BoardWorkersShape;
});

export const BoardWorkersLive = Layer.effect(BoardWorkers, makeBoardWorkers);

/**
 * T3o (T3O-65, D20/D21): moving a card to another worker — the way back out of
 * a placement.
 *
 * A card with no worktree just re-pins (`board.card.pin-worker`). A card with
 * one is MOVED, and the git remote is the only thing that crosses: nothing is
 * copied worker to worker. So a move is refused while a step runs, and refused
 * while the source worktree holds anything the remote lacks; otherwise the old
 * worktree is retired and a new one provisioned on the target from the pushed
 * branch. Each step lands on the card as it happens (`board.card.move-worker`),
 * which is what the card's Moving / Move failed notices and its activity rail
 * read. The branch must be on the remote before anything is retired, and the
 * source is probed for unpushed work once more right before it is. Retiring
 * runs before the move answers, and a retire that fails leaves the card on its
 * source with its worktree intact. A failed provision does not restore the
 * retired worktree — its branch is on the remote — and Retry or another worker
 * start the move again; if the branch has gone from the remote since, the
 * retry offers to start over from the base instead.
 *
 * A FORCE-move (T3O-66, D22) is the way off a worker the board can't reach —
 * offline, or removed — where nothing can be checked or retired. It continues
 * from the branch on the remote, the old worktree left where it is and
 * recorded as abandoned; a step that still reads as running there is stalled
 * by the supervisor and continues on the new worker. With no branch on the
 * remote the card can only start Build over from its base, which the human
 * confirms a second time.
 *
 * Moves are human acts (D18): only the RPCs call this.
 */
import {
  BOARD_LOCAL_WORKER_ID,
  activeBoardCardThreadId,
  boardCardEffectiveWorkerId,
  boardCardHoldsWorktree,
  boardCardStepState,
  boardRepositoryGroupingKey,
  boardStageWithRole,
  isBoardStageAtOrAfterBuild,
  CommandId,
  EMPTY_BOARD_STATE,
  type BoardAskCardAgentToPushResult,
  type BoardCard,
  type BoardCardId,
  type BoardCardMoveCheck,
  type BoardMoveCardToWorkerResult,
  type BoardWorkerId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";

import { BoardEngine } from "../BoardEngine.ts";
import type { BoardCommand } from "../decider.ts";
import { ThreadGateway } from "../ThreadGateway.ts";
import { BoardWorkspaces, type BoardCardWorkspace } from "../workspace/BoardWorkspace.ts";
import { BoardPlacement, boardPlacementGate } from "./BoardPlacement.ts";

/** Runs before each command the move dispatches — the RPC stamps the human. */
export type BoardMoveStamp = (command: BoardCommand) => Effect.Effect<void>;

/** A force-move off an unreachable worker, and its restart-from-base confirmation. */
export interface BoardMoveForce {
  readonly force?: boolean | undefined;
  readonly restartFromBase?: boolean | undefined;
}

export interface BoardCardMoverShape {
  /** Whether the card can move to `toWorkerId` now, and what it continues from. */
  readonly check: (
    cardId: BoardCardId,
    toWorkerId: BoardWorkerId,
    options?: BoardMoveForce,
  ) => Effect.Effect<BoardCardMoveCheck>;
  /** Check again, then start the move; the git work runs on after the answer.
      A null worker is the human's Follow default: the board's default worker,
      and the card lands unpinned. */
  readonly move: (
    cardId: BoardCardId,
    toWorkerId: BoardWorkerId | null,
    stamp?: BoardMoveStamp,
    options?: BoardMoveForce,
  ) => Effect.Effect<BoardMoveCardToWorkerResult>;
  /** Ask the agent in the card's latest thread to push its work. */
  readonly askAgentToPush: (cardId: BoardCardId) => Effect.Effect<BoardAskCardAgentToPushResult>;
  /** Wait for every move started so far to finish — for tests. */
  readonly drain: Effect.Effect<void>;
}

export class BoardCardMover extends Context.Service<BoardCardMover, BoardCardMoverShape>()(
  "t3/board/workers/BoardCardMove/BoardCardMover",
) {}

/** The turn Ask agent to push sends. */
export const boardPushRequestText = (branch: string) =>
  `This card is being moved to another worker, and only what is on the remote goes with it. ` +
  `Commit anything uncommitted on ${branch} and push the branch now, then stop.`;

const refused = (detail: string) => ({ outcome: "refused", detail }) as const;

export const makeBoardCardMover = Effect.gen(function* () {
  const engine = yield* BoardEngine;
  const workspaces = yield* BoardWorkspaces;
  const threads = yield* ThreadGateway;
  const placement = yield* BoardPlacement;
  const crypto = yield* Crypto.Crypto;
  const running = yield* FiberSet.make();

  const commandId = (tag: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:board-${tag}:${uuid}`)),
    );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const readBoard = engine.getReadModel.pipe(
    Effect.map((model) => model.board ?? EMPTY_BOARD_STATE),
  );

  const workerName = (workerId: BoardWorkerId) =>
    workerId === BOARD_LOCAL_WORKER_ID
      ? Effect.succeed("This server")
      : placement.workers.pipe(
          Effect.map(
            (state) =>
              state.workers.find((worker) => worker.id === workerId)?.label ?? String(workerId),
          ),
        );

  /** The target must be able to take the card: online, with a checkout. */
  const targetRefusal = Effect.fn("BoardCardMover.targetRefusal")(function* (
    card: BoardCard,
    toWorkerId: BoardWorkerId,
  ) {
    if (toWorkerId === BOARD_LOCAL_WORKER_ID) return null;
    const project = yield* threads
      .project(card.projectId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const gate = boardPlacementGate({
      workerId: toWorkerId,
      workers: yield* placement.workers,
      projectRepositoryKey: boardRepositoryGroupingKey(project?.repositoryIdentity),
      // The provider is the next step's business: a worker without it stalls
      // that step amber, which says exactly what to do.
      providerInstanceId: null,
    });
    const name = yield* workerName(toWorkerId);
    if (gate.kind === "offline") return `${name} is offline. Move the card once it reconnects.`;
    if (gate.kind === "no-checkout") {
      return `${name} has no checkout of this card's project. Set it up on ${name} first.`;
    }
    return null;
  });

  /**
   * The worker a card is stuck on, when the board can't reach it: removed (the
   * card holds `placementOrphaned`), or registered and not online. Null when the
   * card's worker is reachable, or it has none — then there is nothing to force.
   */
  const unreachableSource = Effect.fn("BoardCardMover.unreachableSource")(function* (
    card: BoardCard,
    defaultWorkerId: BoardWorkerId | undefined,
  ) {
    if (card.placementOrphaned !== null) return card.placementOrphaned.workerId;
    const workerId = boardCardEffectiveWorkerId(card, defaultWorkerId);
    if (workerId === BOARD_LOCAL_WORKER_ID) return null;
    const worker = (yield* placement.workers).workers.find(
      (candidate) => candidate.id === workerId,
    );
    return worker === undefined || worker.status.state !== "online" ? workerId : null;
  });

  /** Why a move refuses when the remote can't be asked about its branch. */
  const remoteUnreachable = Effect.fn("BoardCardMover.remoteUnreachable")(function* (
    workerId: BoardWorkerId,
    branch: string,
  ) {
    return `${yield* workerName(workerId)} couldn't reach the remote to look for ${branch}. Try again once it can.`;
  });

  /** A card whose branch isn't on the remote, with no worktree the board can
      move it from: all it can do is start over from its base, which the
      human confirms (`restartFromBase`). */
  const noRemoteBranch = Effect.fn("BoardCardMover.noRemoteBranch")(function* (
    card: BoardCard,
    worktree: NonNullable<BoardCard["worktree"]>,
    stuckOn: BoardWorkerId,
  ) {
    // A restart sends the card back to Build: a Done card has nothing to go
    // back to.
    const board = yield* readBoard;
    const done = boardStageWithRole(board, "done");
    const build = boardStageWithRole(board, "build");
    if (done !== null && card.stage === done.stageId) {
      return refused(
        `${worktree.branch} isn't on the remote, and a Done card isn't restarted from its base.`,
      );
    }
    return {
      outcome: "no-remote-branch",
      workerId: stuckOn,
      branch: worktree.branch,
      baseRefName: worktree.baseRefName,
      // Where restartFromBase leaves it: the start of Build for a card at or
      // past Build; a card not there yet keeps its stage.
      backToStage:
        build !== null && isBoardStageAtOrAfterBuild(board, card.stage) ? build.label : null,
    } as const;
  });

  /** A force-move's check (T3O-66): nothing on the source can be read, so the
      remote branch on the target is all there is to continue from. */
  const checkForced = Effect.fn("BoardCardMover.checkForced")(function* (
    card: BoardCard,
    toWorkerId: BoardWorkerId,
    defaultWorkerId: BoardWorkerId | undefined,
  ) {
    const from = yield* unreachableSource(card, defaultWorkerId);
    if (from === null) {
      return refused(
        "Force-move is only for a card whose worker is offline or removed. Move it instead.",
      );
    }
    if (from === toWorkerId) return refused(`This card is already on ${yield* workerName(from)}.`);
    const targetProblem = yield* targetRefusal(card, toWorkerId);
    if (targetProblem !== null) return refused(targetProblem);
    const worktree = card.worktree;
    if (!boardCardHoldsWorktree(card) && card.workerMove === null) {
      return { outcome: "pin" } as const;
    }
    if (worktree === null) return refused("This card has no branch to move.");
    const target = yield* workspaces.forWorker(toWorkerId, card.projectId);
    // A remote that couldn't be asked is not one without the branch: only the
    // latter offers a restart from base, which forgets pushed work.
    const read = yield* target.remoteBranchTip({ branch: worktree.branch }).pipe(
      Effect.map((tip) => ({ tip })),
      Effect.orElseSucceed(() => null),
    );
    if (read === null) return refused(yield* remoteUnreachable(toWorkerId, worktree.branch));
    const tip = read.tip;
    if (tip === null) return yield* noRemoteBranch(card, worktree, from);
    return { outcome: "ready", fromWorkerId: from, branch: worktree.branch, tip } as const;
  });

  const check: BoardCardMoverShape["check"] = (cardId, toWorkerId, options = {}) =>
    Effect.gen(function* () {
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === cardId);
      if (card === undefined || card.archivedAt !== null) {
        return refused("This card no longer exists or is archived.");
      }
      if (
        toWorkerId !== BOARD_LOCAL_WORKER_ID &&
        !(board.workers ?? []).some((worker) => worker.id === toWorkerId)
      ) {
        return refused("That worker is no longer on this board.");
      }
      if (card.workerMove?.status === "moving") return refused("This card is already moving.");
      if (options.force === true)
        return yield* checkForced(card, toWorkerId, board.defaultWorkerId);
      const holds = boardCardHoldsWorktree(card);
      if (!holds && card.workerMove === null) return { outcome: "pin" } as const;
      const from = holds ? boardCardEffectiveWorkerId(card, board.defaultWorkerId) : null;
      const live = boardCardStepState(board, card.id);
      if (live !== null && (live.status === "running" || live.status === "completing")) {
        return {
          outcome: "step-running",
          workerId: from ?? boardCardEffectiveWorkerId(card, board.defaultWorkerId),
          threadId: live.threadId,
          stepLabel: live.stepLabel ?? live.stageLabel,
        } as const;
      }
      if (from === toWorkerId) {
        return refused(`This card is already on ${yield* workerName(toWorkerId)}.`);
      }
      const worktree = card.worktree;
      if (worktree === null) return refused("This card has no branch to move.");
      if (holds && (worktree.status !== "ready" || worktree.path === null)) {
        return refused("This card's worktree is still being created. Move it once it is ready.");
      }
      const targetProblem = yield* targetRefusal(card, toWorkerId);
      if (targetProblem !== null) return refused(targetProblem);

      // The source is checked for anything the remote lacks. With no worktree
      // left (a retry), the branch on the remote is all there is.
      let tipFrom: BoardCardWorkspace;
      if (from !== null && worktree.path !== null) {
        const source = yield* workspaces.forCard(card);
        const probed = yield* source
          .probeWorktreeDurability({
            worktreePath: worktree.path,
            baseRefName: worktree.baseRefName,
            branch: worktree.branch,
            mergedPullRequestNumbers: [],
            openPullRequestNumber: null,
            baseAlreadyFetched: false,
          })
          .pipe(Effect.result);
        if (probed._tag === "Failure") {
          return probed.failure._tag === "WorkerUnavailable"
            ? ({ outcome: "source-unreachable", workerId: from } as const)
            : refused(`Couldn't check for unpushed work: ${probed.failure.detail}`);
        }
        const facts = probed.success;
        if (!facts.hasUpstream) {
          return { outcome: "no-upstream", workerId: from, branch: worktree.branch } as const;
        }
        if (facts.unpushedCount > 0 || facts.hasWorkingTreeChanges) {
          return {
            outcome: "unpushed",
            workerId: from,
            branch: worktree.branch,
            unpushedCount: facts.unpushedCount,
            commits: facts.unpushedCommits,
            changedPaths: facts.changedPaths,
          } as const;
        }
        tipFrom = source;
      } else {
        tipFrom = yield* workspaces.forWorker(toWorkerId, card.projectId);
      }
      // The new worktree is cut from the remote branch, so the branch must be
      // there before anything is retired: a source whose upstream still
      // resolves locally can have lost it on the remote (deleted after a
      // merge, say), and retiring would leave nothing to continue from.
      const read = yield* tipFrom.remoteBranchTip({ branch: worktree.branch }).pipe(
        Effect.map((tip) => ({ tip })),
        Effect.orElseSucceed(() => null),
      );
      if (read === null) {
        return refused(yield* remoteUnreachable(from ?? toWorkerId, worktree.branch));
      }
      const tip = read.tip;
      if (tip === null && from !== null) {
        return refused(
          `${worktree.branch} isn't on the remote any more. Push it again, then move the card.`,
        );
      }
      // A failed move's old worktree is already gone: with nothing on the
      // remote either, the way out is to start over from the base.
      if (tip === null) {
        return yield* noRemoteBranch(
          card,
          worktree,
          card.workerMove?.fromWorkerId ?? boardCardEffectiveWorkerId(card, board.defaultWorkerId),
        );
      }
      return { outcome: "ready", fromWorkerId: from, branch: worktree.branch, tip } as const;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("board move: check failed", { cardId, cause: Cause.pretty(cause) }).pipe(
          Effect.as(refused("The move could not be checked. See the server log for details.")),
        ),
      ),
    );

  /** Dispatch one move step; whether it landed. */
  const record = (
    cardId: BoardCardId,
    step: Extract<BoardCommand, { type: "board.card.move-worker" }>["step"],
    stamp: BoardMoveStamp,
  ) =>
    Effect.gen(function* () {
      const command: BoardCommand = {
        type: "board.card.move-worker",
        commandId: yield* commandId(`move-${step.phase}`),
        cardId,
        step,
        createdAt: yield* nowIso,
      };
      yield* stamp(command);
      return yield* engine.dispatch(command).pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("board move: step not recorded", {
            cardId,
            phase: step.phase,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
    });

  /**
   * Retire the old worktree, before the move's answer. A failure here leaves
   * the card where it is: its worktree is intact, so the decider closes the
   * move rather than marking it failed, and the answer says why.
   */
  const retire = Effect.fn("BoardCardMover.retire")(function* (
    card: BoardCard,
    fromWorkerId: BoardWorkerId,
    stamp: BoardMoveStamp,
  ) {
    const worktree = card.worktree!;
    const source = yield* workspaces.forCard(card);
    // Probed again right before: work committed since the check (a push turn
    // still finishing, say) would otherwise stay behind on the old worker.
    const recheck = yield* source
      .probeWorktreeDurability({
        worktreePath: worktree.path!,
        baseRefName: worktree.baseRefName,
        branch: worktree.branch,
        mergedPullRequestNumbers: [],
        openPullRequestNumber: null,
        baseAlreadyFetched: false,
      })
      .pipe(Effect.result);
    const changed =
      recheck._tag === "Failure"
        ? `Checking again for unpushed work failed: ${
            recheck.failure._tag === "WorkerUnavailable"
              ? recheck.failure.message
              : recheck.failure.detail
          }`
        : !recheck.success.hasUpstream ||
            recheck.success.unpushedCount > 0 ||
            recheck.success.hasWorkingTreeChanges
          ? `${worktree.branch} has work the remote lacks since the move was checked. Push it, then move again.`
          : null;
    if (changed !== null) {
      yield* record(card.id, { phase: "failed", error: changed }, stamp);
      return refused(`${changed} ${card.key} stays on ${yield* workerName(fromWorkerId)}.`);
    }
    const retired = yield* source
      .retireWorktree({ worktreePath: worktree.path!, kind: "reclaim", verifiedClean: true })
      .pipe(Effect.result);
    const problem =
      retired._tag === "Failure"
        ? `Retiring the old worktree failed: ${
            retired.failure._tag === "WorkerUnavailable"
              ? retired.failure.message
              : retired.failure.detail
          }`
        : retired.success?.outcome === "blocked"
          ? `The old worktree was kept: ${retired.success.reason}`
          : null;
    if (problem !== null) {
      yield* record(card.id, { phase: "failed", error: problem }, stamp);
      return refused(`${problem} ${card.key} stays on ${yield* workerName(fromWorkerId)}.`);
    }
    if (!(yield* record(card.id, { phase: "retired" }, stamp))) {
      return refused("The move could not be recorded. See the server log.");
    }
    return null;
  });

  /** Provision the new worktree from the remote branch, and record it. */
  const provision = Effect.fn("BoardCardMover.provision")(function* (input: {
    readonly card: BoardCard;
    readonly toWorkerId: BoardWorkerId;
    readonly followDefault: boolean;
    readonly stamp: BoardMoveStamp;
  }) {
    const { card, stamp } = input;
    const worktree = card.worktree!;
    const target = yield* workspaces.forWorker(input.toWorkerId, card.projectId);
    const provisioned = yield* target
      .provisionWorktreeFromRemoteBranch({
        branch: worktree.branch,
        baseRefName: worktree.baseRefName,
      })
      .pipe(Effect.result);
    if (provisioned._tag === "Failure") {
      const detail =
        provisioned.failure._tag === "WorkerUnavailable"
          ? `${yield* workerName(input.toWorkerId)} went offline.`
          : provisioned.failure.detail;
      return yield* record(
        card.id,
        { phase: "failed", error: `Creating the worktree failed: ${detail}` },
        stamp,
      );
    }
    const done = yield* record(
      card.id,
      { phase: "done", worktreePath: provisioned.success.path },
      stamp,
    );
    // `done` pins the card where it landed; the human's Follow default takes
    // the pin off again, so the card follows the default once its worktree goes.
    if (done && input.followDefault) {
      const unpin: BoardCommand = {
        type: "board.card.pin-worker",
        commandId: yield* commandId("move-unpin"),
        cardId: card.id,
        workerId: null,
        createdAt: yield* nowIso,
      };
      yield* stamp(unpin);
      yield* engine.dispatch(unpin).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("board move: Follow default not restored", {
            cardId: card.id,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
  });

  /** Dispatch a command the move needs besides its own steps, stamped. */
  const dispatchStamped = (command: BoardCommand, stamp: BoardMoveStamp) =>
    stamp(command).pipe(
      Effect.andThen(engine.dispatch(command)),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("board move: command not recorded", {
          type: command.type,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  /**
   * Restart a force-moved card from its base (T3O-66, prototype 5.6): there is
   * nothing on the remote to continue from. A card past Build goes back to it
   * first — while it still holds its old placement, so nothing starts on the
   * old branch — then its branch is forgotten and the move ends on the target,
   * where Build cuts a fresh one from the base. A card not yet at Build keeps
   * its stage and cuts the branch when it gets there. Whether it restarted:
   * a refused stage move fails the move instead.
   */
  const restartFromBase = Effect.fn("BoardCardMover.restartFromBase")(function* (
    cardId: BoardCardId,
    stamp: BoardMoveStamp,
  ) {
    const board = yield* readBoard;
    const card = board.cards.find((candidate) => candidate.id === cardId)!;
    const build = boardStageWithRole(board, "build");
    if (
      build !== null &&
      card.stage !== build.stageId &&
      isBoardStageAtOrAfterBuild(board, card.stage)
    ) {
      const backToBuild = yield* dispatchStamped(
        {
          type: "board.card.move",
          commandId: yield* commandId("move-restart-build"),
          cardId,
          toStage: build.stageId,
          override: true,
          createdAt: yield* nowIso,
        },
        stamp,
      );
      if (!backToBuild) {
        yield* record(
          cardId,
          {
            phase: "failed",
            error: `The card couldn't go back to ${build.label}, so it wasn't restarted.`,
          },
          stamp,
        );
        return false;
      }
    }
    return yield* record(cardId, { phase: "restarted" }, stamp);
  });

  const move: BoardCardMoverShape["move"] = (
    cardId,
    choice,
    stamp = () => Effect.void,
    options = {},
  ) =>
    Effect.gen(function* () {
      const followDefault = choice === null;
      const toWorkerId = choice ?? (yield* readBoard).defaultWorkerId ?? BOARD_LOCAL_WORKER_ID;
      const force = options.force === true;
      const checked = yield* check(cardId, toWorkerId, options);
      // A force-moved card with no worktree just re-pins; the supervisor
      // stalls a step stranded on the old worker off the pin.
      if (force && checked.outcome === "pin") {
        const pinned = yield* dispatchStamped(
          {
            type: "board.card.pin-worker",
            commandId: yield* commandId("move-force-pin"),
            cardId,
            workerId: followDefault ? null : toWorkerId,
            createdAt: yield* nowIso,
          },
          stamp,
        );
        return pinned
          ? ({ outcome: "started" } as const)
          : refused("The card could not be re-pinned. See the server log.");
      }
      // A force-move off an unreachable worker, or a failed move's retry,
      // with nothing on the remote: start over from the base, once confirmed.
      const restart = checked.outcome === "no-remote-branch";
      if (restart && options.restartFromBase !== true) return checked;
      if (checked.outcome !== "ready" && !restart) return checked;
      const started = yield* record(
        cardId,
        {
          phase: "start",
          toWorkerId,
          sha: checked.outcome === "ready" ? (checked.tip?.sha ?? null) : null,
          ...(force ? { force: true } : {}),
        },
        stamp,
      );
      if (!started) return refused("The move could not be started. See the server log.");
      if (restart) {
        const restarted = yield* restartFromBase(cardId, stamp);
        if (!restarted) return refused("The card could not be restarted. See the server log.");
        if (followDefault) {
          yield* dispatchStamped(
            {
              type: "board.card.pin-worker",
              commandId: yield* commandId("move-unpin"),
              cardId,
              workerId: null,
              createdAt: yield* nowIso,
            },
            stamp,
          );
        }
        return { outcome: "started" } as const;
      }
      const card = (yield* readBoard).cards.find((candidate) => candidate.id === cardId)!;
      if (force) {
        // Nothing on the old worker is touched: its worktree stays there, and
        // the card stops using it.
        if (card.worktree !== null && boardCardHoldsWorktree(card)) {
          const abandoned = yield* record(
            cardId,
            { phase: "abandoned", worktreePath: card.worktree.path },
            stamp,
          );
          if (!abandoned) return refused("The move could not be recorded. See the server log.");
        }
        yield* provision({ card, toWorkerId, followDefault, stamp }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("board move: failed", { cardId, cause: Cause.pretty(cause) }).pipe(
              Effect.andThen(
                record(
                  cardId,
                  { phase: "failed", error: "The move stopped unexpectedly. See the server log." },
                  stamp,
                ),
              ),
            ),
          ),
          FiberSet.run(running),
        );
        return { outcome: "started" } as const;
      }
      if (checked.outcome !== "ready") return checked;
      const stopped = (cause: Cause.Cause<unknown>) =>
        Effect.logWarning("board move: failed", { cardId, cause: Cause.pretty(cause) }).pipe(
          Effect.andThen(
            record(
              cardId,
              { phase: "failed", error: "The move stopped unexpectedly. See the server log." },
              stamp,
            ),
          ),
        );
      if (checked.fromWorkerId !== null && card.worktree !== null && card.worktree.path !== null) {
        const refusal = yield* retire(card, checked.fromWorkerId, stamp).pipe(
          Effect.catchCause((cause) =>
            stopped(cause).pipe(
              Effect.as(refused("The move stopped unexpectedly. See the server log.")),
            ),
          ),
        );
        if (refusal !== null) return refusal;
      }
      yield* provision({ card, toWorkerId, followDefault, stamp }).pipe(
        Effect.catchCause(stopped),
        FiberSet.run(running),
      );
      return { outcome: "started" } as const;
    });

  const askAgentToPush: BoardCardMoverShape["askAgentToPush"] = (cardId) =>
    Effect.gen(function* () {
      const board = yield* readBoard;
      const card = board.cards.find((candidate) => candidate.id === cardId);
      const threadId = card === undefined ? null : activeBoardCardThreadId(card.threadLinks);
      if (card === undefined || threadId === null) return { outcome: "no-thread" } as const;
      const step = boardCardStepState(board, card.id);
      return yield* threads
        .send({
          commandId: yield* commandId("ask-push"),
          threadId,
          text: boardPushRequestText(card.worktree?.branch ?? "the card's branch"),
          attachments: [],
          runtimeMode: step?.runtimeMode ?? "approval-required",
          interactionMode: "default",
        })
        .pipe(
          Effect.as({ outcome: "sent", threadId } as const),
          Effect.catch((error) =>
            Effect.succeed({ outcome: "failed", detail: error.detail } as const),
          ),
        );
    });

  // A move runs in this process's memory, so one still `moving` when the
  // mover is built was cut off by a restart and nothing will ever finish it.
  // Close it here, before any RPC can start a new one: a card still holding
  // its worktree just stays where it was, and one already retired gets Move
  // failed with Retry, its branch safe on the remote. One gap remains: a
  // restart after `retireWorktree` succeeded but before `retired` was
  // recorded leaves the card holding a path that no longer exists; nothing
  // here probes for that.
  for (const card of (yield* readBoard).cards) {
    if (card.workerMove?.status !== "moving") continue;
    yield* record(
      card.id,
      { phase: "failed", error: "The server restarted during the move. Retry it." },
      () => Effect.void,
    );
  }

  return {
    check,
    move,
    askAgentToPush,
    drain: FiberSet.awaitEmpty(running),
  } satisfies BoardCardMoverShape;
});

export const BoardCardMoverLive = Layer.effect(BoardCardMover, makeBoardCardMover);

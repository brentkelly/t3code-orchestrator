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
 * read. A failed provision does not restore the retired worktree — its branch
 * is safe on the remote — and Retry or another worker start the move again.
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

export interface BoardCardMoverShape {
  /** Whether the card can move to `toWorkerId` now, and what it continues from. */
  readonly check: (
    cardId: BoardCardId,
    toWorkerId: BoardWorkerId,
  ) => Effect.Effect<BoardCardMoveCheck>;
  /** Check again, then start the move; the git work runs on after the answer. */
  readonly move: (
    cardId: BoardCardId,
    toWorkerId: BoardWorkerId,
    stamp?: BoardMoveStamp,
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

  const check: BoardCardMoverShape["check"] = (cardId, toWorkerId) =>
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
      const tip = yield* tipFrom
        .remoteBranchTip({ branch: worktree.branch })
        .pipe(Effect.orElseSucceed(() => null));
      if (from === null && tip === null) {
        return refused(
          `${worktree.branch} isn't on the remote, so there is nothing to continue from.`,
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

  /** Retire the old worktree, provision the new one, record each. */
  const carryOut = Effect.fn("BoardCardMover.carryOut")(function* (input: {
    readonly card: BoardCard;
    readonly fromWorkerId: BoardWorkerId | null;
    readonly toWorkerId: BoardWorkerId;
    readonly stamp: BoardMoveStamp;
  }) {
    const { card, stamp } = input;
    const worktree = card.worktree!;
    const fail = (error: string) => record(card.id, { phase: "failed", error }, stamp);
    if (input.fromWorkerId !== null && worktree.path !== null) {
      const source = yield* workspaces.forCard(card);
      const retired = yield* source
        .retireWorktree({ worktreePath: worktree.path, kind: "reclaim", verifiedClean: true })
        .pipe(Effect.result);
      if (retired._tag === "Failure") {
        const detail =
          retired.failure._tag === "WorkerUnavailable"
            ? retired.failure.message
            : retired.failure.detail;
        return yield* fail(`Retiring the old worktree failed: ${detail}`);
      }
      if (retired.success?.outcome === "blocked") {
        return yield* fail(`The old worktree was kept: ${retired.success.reason}`);
      }
      if (!(yield* record(card.id, { phase: "retired" }, stamp))) return;
    }
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
      return yield* fail(`Creating the worktree failed: ${detail}`);
    }
    yield* record(card.id, { phase: "done", worktreePath: provisioned.success.path }, stamp);
  });

  const move: BoardCardMoverShape["move"] = (cardId, toWorkerId, stamp = () => Effect.void) =>
    Effect.gen(function* () {
      const checked = yield* check(cardId, toWorkerId);
      if (checked.outcome !== "ready") return checked;
      const started = yield* record(
        cardId,
        { phase: "start", toWorkerId, sha: checked.tip?.sha ?? null },
        stamp,
      );
      if (!started) return refused("The move could not be started. See the server log.");
      const card = (yield* readBoard).cards.find((candidate) => candidate.id === cardId)!;
      yield* carryOut({ card, fromWorkerId: checked.fromWorkerId, toWorkerId, stamp }).pipe(
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

  return {
    check,
    move,
    askAgentToPush,
    drain: FiberSet.awaitEmpty(running),
  } satisfies BoardCardMoverShape;
});

export const BoardCardMoverLive = Layer.effect(BoardCardMover, makeBoardCardMover);

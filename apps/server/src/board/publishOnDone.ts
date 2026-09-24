/**
 * Publish-on-done gate — the pure half of "run this project's script when a
 * card reaches Done with a merged pull request".
 *
 * The reactor is the effectful shell: pull, run the script, record the
 * attempt. This module answers *whether* to run, and *what* last succeeded,
 * so those decisions are unit-testable without a reactor, a git checkout or
 * a terminal.
 */
import {
  boardCardPublishNeedsYou,
  boardPublishConjunctionBecameTrue,
  boardPublishOnDoneEnabled,
  type BoardCard,
  type BoardCardPublish,
  type BoardLifecycleSettings,
  type BoardStageId,
  type ProjectId,
  type ProjectScript,
} from "@t3tools/contracts";
import { publishOnDoneScript } from "@t3tools/shared/projectScripts";

export { boardCardPublishNeedsYou, boardPublishConjunctionBecameTrue, boardPublishOnDoneEnabled };

export const BOARD_PUBLISH_ON_DONE_TIMEOUT_MS = 15 * 60 * 1000;

/** Round index matching Done settlement: how many PRs this card has finished. */
export function boardPublishRound(card: Pick<BoardCard, "pullRequestHistory">): number {
  return card.pullRequestHistory.length;
}

export function lastPublishedShaForProject(
  cards: ReadonlyArray<Pick<BoardCard, "projectId" | "publish">>,
  projectId: ProjectId,
): string | null {
  let sha: string | null = null;
  for (const card of cards) {
    if (card.projectId !== projectId) continue;
    if (card.publish?.status !== "succeeded") continue;
    if (card.publish.sha === null) continue;
    sha = card.publish.sha;
  }
  return sha;
}

/**
 * Whether this card should publish after a pull-request refresh or stage move.
 *
 * `previousStage` is the stage before the move, or the current stage when
 * nothing moved. `previousMerged` is the pull-request state before the
 * refresh recorded a new one. Opening an already-qualified card is not an
 * edge, so parked Done cards stay silent when the switch is later turned on.
 *
 * `force` is a human Retry: skip the edge and the per-round attempt guard.
 */
export function shouldPublishAfterRefresh(input: {
  readonly lifecycle: BoardLifecycleSettings;
  readonly card: BoardCard;
  readonly previousStage: BoardStageId;
  readonly previousMerged: boolean;
  readonly isDone: boolean;
  readonly force: boolean;
}): boolean {
  const { card, lifecycle } = input;
  if (card.archivedAt !== null) return false;
  if (!input.isDone) return false;
  if (card.pullRequest === null || card.pullRequest.state !== "merged") return false;
  if (!boardPublishOnDoneEnabled(lifecycle, card.projectId)) return false;
  if (input.force) return true;
  if (
    !boardPublishConjunctionBecameTrue({
      wasDone: input.previousStage === card.stage,
      wasMerged: input.previousMerged,
      isDone: true,
      isMerged: true,
    })
  ) {
    return false;
  }
  const round = boardPublishRound(card);
  return card.publish === null || card.publish.round !== round;
}

export function publishSkipBecauseAlreadyLive(
  sha: string,
  lastPublishedSha: string | null,
): boolean {
  return lastPublishedSha !== null && lastPublishedSha === sha;
}

export function resolvePublishScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return publishOnDoneScript(scripts);
}

export function publishAttempt(input: {
  readonly card: Pick<BoardCard, "pullRequestHistory">;
  readonly status: BoardCardPublish["status"];
  readonly sha: string | null;
  readonly detail: string | null;
}): BoardCardPublish {
  return {
    round: boardPublishRound(input.card),
    status: input.status,
    sha: input.sha,
    detail: input.detail,
  };
}

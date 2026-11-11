/**
 * The card's pull request, linked onto its threads as upstream's thread PR
 * link (T3O-75), so badges, PR search, PR sync and settle-on-merge reach them.
 * Only threads from Code review onwards in the card's current round carry it.
 */
import {
  BoardStageId,
  boardCardThreadLinkRound,
  boardStageIndex,
  boardStageWithRole,
  CommandId,
  parseBoardCiAgentStepId,
  parseBoardCiFixStepId,
  parseReviewStepId,
  type BoardCard,
  type BoardCardPullRequest,
  type BoardCardThreadLink,
  type BoardEvent,
  type BoardState,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import type { ThreadGatewayShape, ThreadPullRequestKey } from "./ThreadGateway.ts";

/** A human adopted the thread onto the card; the board leaves its links alone. */
const ADOPTED_THREAD_ROLE = "linked";

export interface CardPullRequestKey extends ThreadPullRequestKey {
  readonly url: string;
}

export type CardThreadPullRequestAction =
  | { readonly kind: "link"; readonly threadId: ThreadId; readonly pullRequest: CardPullRequestKey }
  | {
      readonly kind: "unlink";
      readonly threadId: ThreadId;
      readonly pullRequest: CardPullRequestKey;
    };

/** Upstream's key for a card PR, or null when its URL is not a recognised one. */
export function cardPullRequestKey(pullRequest: BoardCardPullRequest): CardPullRequestKey | null {
  const parsed = sourceControlDefinitions.parseChangeRequestUrl(pullRequest.url)?.link;
  if (parsed === undefined) return null;
  return {
    host: parsed.host,
    repository: parsed.repository,
    number: parsed.number,
    url: pullRequest.url,
  };
}

/** Whether a link's step runs at or after the review-role stage. Review-loop
    and CI step ids name no stage and always do; any other step id is its
    stage's id. */
function linkRoleFromReviewOnwards(board: BoardState, role: string): boolean {
  if (
    parseReviewStepId(role) !== null ||
    parseBoardCiFixStepId(role) !== null ||
    parseBoardCiAgentStepId(role) !== null
  ) {
    return true;
  }
  const review = boardStageWithRole(board, "review");
  if (review === null) return false;
  const reviewIndex = boardStageIndex(board, review.stageId);
  const index = boardStageIndex(board, BoardStageId.make(role));
  return reviewIndex >= 0 && index >= reviewIndex;
}

/** A thread link that carries the card's current pull request. Retired links
    still do; tombstoned, adopted and earlier rounds' links never. */
export function linkCarriesCardPullRequest(
  board: BoardState,
  card: Pick<BoardCard, "pullRequestHistory">,
  link: BoardCardThreadLink,
): boolean {
  return (
    link.tombstonedAt === null &&
    link.role !== ADOPTED_THREAD_ROLE &&
    boardCardThreadLinkRound(link) === card.pullRequestHistory.length &&
    linkRoleFromReviewOnwards(board, link.role)
  );
}

type SyncEvent = Extract<
  BoardEvent,
  { type: "board.card-pull-request-recorded" | "board.card-thread-linked" }
>;

/** What one board event asks of the card's threads' pull request links. */
export function cardThreadPullRequestActions(
  board: BoardState,
  event: SyncEvent,
): {
  readonly actions: ReadonlyArray<CardThreadPullRequestAction>;
  /** Card pull request URLs that did not parse, so nothing was done for them. */
  readonly unparsed: ReadonlyArray<string>;
} {
  const card = event.payload.card;
  const unparsed: Array<string> = [];
  const keyOf = (pullRequest: BoardCardPullRequest | null | undefined) => {
    if (pullRequest === null || pullRequest === undefined) return null;
    const key = cardPullRequestKey(pullRequest);
    if (key === null) unparsed.push(pullRequest.url);
    return key;
  };
  const carrying = (links: ReadonlyArray<BoardCardThreadLink>) =>
    links.filter((link) => linkCarriesCardPullRequest(board, card, link));

  if (event.type === "board.card-thread-linked") {
    const links = carrying(card.threadLinks.filter((link) => link.threadId === event.payload.threadId));
    if (links.length === 0) return { actions: [], unparsed };
    const current = keyOf(card.pullRequest);
    if (current === null) return { actions: [], unparsed };
    return {
      actions: links.map((link) => ({
        kind: "link" as const,
        threadId: link.threadId,
        pullRequest: current,
      })),
      unparsed,
    };
  }

  const { transition, previous } = event.payload;
  if (transition !== "linked" && transition !== "unlinked") return { actions: [], unparsed };
  const links = carrying(card.threadLinks);
  if (links.length === 0) return { actions: [], unparsed };
  const before = keyOf(previous);
  const after = transition === "linked" ? keyOf(card.pullRequest) : null;
  const actions: Array<CardThreadPullRequestAction> = [];
  if (before !== null && !(after !== null && sameKey(before, after))) {
    for (const link of links) {
      actions.push({ kind: "unlink", threadId: link.threadId, pullRequest: before });
    }
  }
  if (after !== null) {
    for (const link of links) {
      actions.push({ kind: "link", threadId: link.threadId, pullRequest: after });
    }
  }
  return { actions, unparsed };
}

const sameKey = (left: ThreadPullRequestKey, right: ThreadPullRequestKey) =>
  left.host.toLowerCase() === right.host.toLowerCase() &&
  left.repository.toLowerCase() === right.repository.toLowerCase() &&
  left.number === right.number;

/** Stable per thread and pull request: a repeat is the engine's no-op, so a
    link a human removed from the thread is never put back. */
export function cardThreadPullRequestLinkCommandId(
  threadId: ThreadId,
  pullRequest: ThreadPullRequestKey,
): CommandId {
  return CommandId.make(
    `server:board-pr-link:${threadId}:${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`,
  );
}

/**
 * Bring the card's threads in line with its pull request after `event`. Best
 * effort throughout: a link is cosmetic, so a failure (an older worker that
 * cannot take the call, an unreachable one, a deleted thread) is logged and the
 * rest carry on. Never fails.
 */
export const syncCardThreadPullRequests = Effect.fn("board.syncCardThreadPullRequests")(
  function* (input: {
    readonly board: BoardState;
    readonly event: SyncEvent;
    readonly threads: Pick<ThreadGatewayShape, "linkPullRequest" | "unlinkPullRequest">;
    readonly unlinkCommandId: Effect.Effect<CommandId>;
  }) {
    const { actions, unparsed } = cardThreadPullRequestActions(input.board, input.event);
    for (const url of unparsed) {
      yield* Effect.logWarning("board: card pull request URL not recognised; not linked on threads", {
        cardId: input.event.payload.cardId,
        url,
      });
    }
    for (const action of actions) {
      const { host, repository, number, url } = action.pullRequest;
      const call =
        action.kind === "link"
          ? input.threads.linkPullRequest({
              commandId: cardThreadPullRequestLinkCommandId(action.threadId, action.pullRequest),
              threadId: action.threadId,
              host,
              repository,
              number,
              url,
            })
          : Effect.flatMap(input.unlinkCommandId, (commandId) =>
              input.threads.unlinkPullRequest({
                commandId,
                threadId: action.threadId,
                host,
                repository,
                number,
              }),
            );
      yield* call.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.logWarning("board: card pull request not synced onto a thread", {
                cardId: input.event.payload.cardId,
                threadId: action.threadId,
                action: action.kind,
                pullRequest: `${host}/${repository}#${number}`,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
  },
);

/**
 * Board MCP handlers. Authorization lives here, not in capability gating: each card-scoped tool
 * resolves the calling thread to its card and rejects an unlinked caller with an actionable
 * message. Every write dispatches a board command; nothing writes a table directly.
 */
import {
  boardCardUsageSummaryFromRows,
  type BoardCardDetail,
  boardAppendOrderKey,
  boardBuildStepPayloadDefect,
  boardReviewBlockedOutcomeRefusal,
  boardReviewCompletionDefect,
  parseReviewStepId,
  boardCardPlans,
  boardCardStepCompletions,
  boardCardStepState,
  boardColumnOrderKeys,
  boardLabelCatalogue,
  boardCardLiveDescendants,
  boardStageWithRole,
  boardStepPayloadDefect,
  DEFAULT_BOARD_SETTINGS,
  isBoardMergeStageExecution,
  resolveBoardCardMergeStrategy,
  resolveBoardStageExecution,
  isBoardTerminalStepStatus,
  boardPlanId,
  BoardCardId,
  CommandId,
  EMPTY_BOARD_STATE,
  resolveBoardCardForThread,
  boardCardEffectiveWorkerId,
  boardCardPlacementTarget,
  unwrapStringifiedBoardStepPayload,
  type BoardCardArchiveCommand,
  type BoardCardCreateCommand,
  type BoardCardCompleteStepCommand,
  type BoardCardDeleteCommand,
  type BoardCardMoveCommand,
  type BoardCardMoveCardsCommand,
  type BoardCardSetGroupSettingsCommand,
  type BoardCardSetAutomationCommand,
  boardWideAutoMergeOn,
  boardAutomationTogglesTurnedOn,
  resolveBoardCardAutomationIn,
  type BoardCardCancelWorkCommand,
  type BoardCardUnarchiveCommand,
  type BoardCardUpdateCommand,
  type BoardCard,
  type BoardCardPullRequest,
  type BoardCardPullRequestTarget,
  BoardLabelId,
  type BoardLabel,
  type BoardLabelCreateCommand,
  type BoardLabelDeleteCommand,
  type BoardLabelUndeleteCommand,
  type BoardLabelUpdateCommand,
  type BoardPlansProposeCommand,
  type BoardPlanWriteCommand,
  BOARD_SEED_STAGE_IDS,
  type BoardSettings,
  type BoardState,
  unmetBoardCardDependencies,
  boardCardGroupOf,
  boardCardAncestors,
  sortBoardCardDecisions,
  type BoardCardRecordDecisionsCommand,
  boardNewPhaseBrief,
  boardNewPhasePlan,
  type BoardCommand,
  type ProjectId,
  BOARD_CARD_SIZE_LETTERS,
  BOARD_CARD_SIZE_MULTIPLIERS,
  BOARD_RESOURCE_DIMENSIONS,
  boardCardCapacityView,
  boardResourceProfile,
  boardResourceProfileValue,
  resolveBoardProjectBaseline,
  type BoardCardSize,
  type BoardResourceProfile,
  BOARD_LOCAL_WORKER_ID,
  boardProjectStageConfig,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { McpThreadInvocationScope } from "../../McpInvocationContext.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  ThreadGateway,
  UNKNOWN_THREAD_STATE,
  type BoardProject,
  type ThreadGatewayShape,
} from "../../../board/ThreadGateway.ts";
import { BoardCapacityClient } from "../../../board/capacity/BoardCapacityClient.ts";
import { BoardEngine, type BoardEngineShape } from "../../../board/BoardEngine.ts";
import { BoardQueries } from "../../../board/BoardQueries.ts";
import type { BoardDispatchError } from "../../../board/errors.ts";
import type { BoardQueriesShape } from "../../../board/projection.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ServerConfig from "../../../config.ts";
import { boardCardAttachmentManifest } from "../../../board/attachments.ts";
import { boardAgentActor, stampBoardActivityActor } from "../../../board/activityActors.ts";
import { boardBriefVersion } from "../../../board/briefEdits.ts";
import { createBoardCard, resolveBoardCardKeyPrefix } from "../../../board/createCard.ts";
import { isKeptStepThread, keptPlanningStepId } from "../../../board/planningThreadKeep.ts";
import { applyBoardPlanEdits } from "../../../board/planEdits.ts";
import {
  boardCompletionReopened,
  planReviewInstructions,
  resolveCardPlanReview,
  runningPlanReviewStep,
} from "../../../board/planReview.ts";
import { SupervisorReactor } from "../../../board/supervisorReactor.ts";
import {
  boardGroupIntoNewPlan,
  boardSharedParentPlan,
  boardIndentPlan,
  boardOutdentPlan,
} from "../../../board/groupOperations.ts";
import { BoardRelayInvocation, relayable } from "./relay.ts";
import { BoardToolError, BoardToolkit } from "./tools.ts";

/** How much of an ancestor's brief the context carries: enough to
    plan against, while a deep tree of long briefs stays bounded. */
const ANCESTOR_BRIEF_MAX_CHARS = 6_000;
/** How many decisions per card ride the context, flagged first. */
const CONTEXT_DECISIONS_MAX = 40;

const nonEmpty = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.trim().length > 0 ? value : fallback;

// Byte caps on what a completion writes into the event log / read model /
// every future detail frame (matched to the contracts file's
// bounded-payload stance — label names 64 bytes, shell titles 200).
const BOARD_STEP_PAYLOAD_MAX_BYTES = 16_384;
const BOARD_STEP_SUMMARY_MAX_BYTES = 2_048;
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Markup from a serialised tool call, found in a summary when the caller's arguments were not
 * parsed into fields. `</summary>` is deliberately not a marker: a summary quoting a `<details>`
 * block legitimately contains it, and a false positive would block a valid completion.
 */
const LEAKED_ARGUMENT_MARKERS = ["<parameter name=", "</parameter>"] as const;

const leaksSerialisedArguments = (summary: string): boolean =>
  LEAKED_ARGUMENT_MARKERS.some((marker) => summary.includes(marker));

const internalError = (cause: { readonly message?: string }): BoardToolError =>
  new BoardToolError({ code: "internal", message: nonEmpty(cause.message, "Board tool failed.") });

/** Map a dispatch failure to an agent-facing tool error: an invariant
    rejection carries the decider's own actionable detail; anything else is an
    internal failure. */
const dispatchError = (error: BoardDispatchError): BoardToolError =>
  error._tag === "BoardCommandInvariantError" ||
  error._tag === "BoardCommandPreviouslyRejectedError"
    ? new BoardToolError({ code: "rejected", message: nonEmpty(error.detail, "Command rejected.") })
    : internalError(error);

interface BoardToolDeps {
  readonly scope: McpThreadInvocationScope;
  readonly boardEngine: BoardEngineShape;
  readonly threads: ThreadGatewayShape;
  readonly board: BoardQueriesShape;
  /** For the brief-attachment manifest's absolute paths. */
  readonly stateDir: string;
  readonly path: Path.Path;
}

/** T3o: a card's size, reservation, worker and queue reason, for an agent (T3O-86). */
const boardCardCapacityFor = (board: BoardState, card: BoardCard) => {
  const state = boardCardStepState(board, card.id);
  const queued = state?.status === "queued";
  return boardCardCapacityView({
    resources: card.resources,
    projectResources: boardProjectStageConfig(board, card.projectId)?.resources ?? null,
    workerId: boardCardEffectiveWorkerId(card),
    queuedBy: queued ? (state.queuedBy ?? null) : null,
    queuedDetail: queued ? (state.queuedDetail ?? null) : null,
  });
};

const SIZE_UNITS = { cpu: "cores", ram: "GiB", disk: "GB" } as const;
const SIZE_NAMES = { cpu: "CPU", ram: "RAM", disk: "Disk" } as const;

/**
 * T3o: a planned size too big for the worker the card would run on, per dimension, naming the
 * largest size that fits (T3O-86). The size is still accepted. Empty with no capacity yet.
 */
export function boardPlanSizeWarnings(input: {
  readonly baseline: BoardResourceProfile;
  readonly declared: BoardResourceProfile;
  readonly workerLabel: string;
  readonly plans: ReadonlyArray<{
    readonly key: string;
    readonly size?: BoardCardSize | undefined;
  }>;
}): ReadonlyArray<string> {
  const warnings: Array<string> = [];
  for (const plan of input.plans) {
    if (plan.size === undefined) continue;
    const profile = boardResourceProfile(input.baseline, plan.size);
    for (const dimension of BOARD_RESOURCE_DIMENSIONS) {
      const need = boardResourceProfileValue(profile, dimension);
      const has = boardResourceProfileValue(input.declared, dimension);
      if (need <= has) continue;
      const base = boardResourceProfileValue(input.baseline, dimension);
      const fit = [...BOARD_CARD_SIZE_LETTERS]
        .reverse()
        .find((letter) => base * BOARD_CARD_SIZE_MULTIPLIERS[letter] <= has);
      warnings.push(
        `Plan '${plan.key}': ${SIZE_NAMES[dimension]} ${plan.size[dimension]} needs ${need} ${SIZE_UNITS[dimension]}; ${input.workerLabel} has ${has}. ${
          fit === undefined
            ? "No size fits: lower the project's baseline."
            : `The largest size that fits is ${fit}.`
        }`,
      );
    }
  }
  return warnings;
}

const planSizeWarnings = Effect.fn("board_propose_plans.sizeWarnings")(function* (
  board: BoardState,
  card: BoardCard,
  plans: ReadonlyArray<{ readonly key: string; readonly size?: BoardCardSize | undefined }>,
) {
  const client = yield* Effect.serviceOption(BoardCapacityClient);
  if (Option.isNone(client)) return [];
  const workerId = boardCardEffectiveWorkerId(card);
  const snapshot = yield* client.value.latest(workerId);
  if (snapshot === null) return [];
  const label =
    workerId === BOARD_LOCAL_WORKER_ID
      ? "this server"
      : ((board.workers ?? []).find((worker) => worker.id === workerId)?.label ?? workerId);
  return boardPlanSizeWarnings({
    baseline: resolveBoardProjectBaseline(
      boardProjectStageConfig(board, card.projectId)?.resources ?? null,
    ),
    declared: snapshot.declared,
    workerLabel: label,
    plans,
  });
});

/** The strategy the card's pull request would merge with now, so an
    agent reading an inherited or board-default card sees the real answer. */
const effectiveMergeStrategy = Effect.fn("board_get_card.effectiveMergeStrategy")(function* (
  board: BoardState,
  card: BoardCard,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const boardSettings = yield* settings.getSettings.pipe(
    Effect.map((current) => current.board ?? DEFAULT_BOARD_SETTINGS),
    Effect.mapError(internalError),
  );
  const mergeStage = boardStageWithRole(board, "merge");
  const exec =
    mergeStage === null ? null : resolveBoardStageExecution(boardSettings, mergeStage.stageId);
  return resolveBoardCardMergeStrategy({
    card,
    ancestors: boardCardAncestors(board, card),
    stageStrategy: exec !== null && isBoardMergeStageExecution(exec) ? exec.strategy : null,
  }).strategy;
});

/** Resolve the services every board tool needs. */
const boardToolDeps = Effect.gen(function* () {
  // Every board tool acts for the calling thread's card; `McpToolAccess`
  // has already refused a caller that is not a T3 thread.
  const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((current) => McpInvocationContext.requireThreadScope(current, "Board tools")),
    Effect.mapError(
      (failure) => new BoardToolError({ code: "rejected", message: failure.message }),
    ),
  );
  const boardEngine = yield* BoardEngine;
  const threads = yield* ThreadGateway;
  const board = yield* BoardQueries;
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  // A call relayed from a worker hands out paths on the worker.
  const relayed = yield* Effect.serviceOption(BoardRelayInvocation);
  return {
    scope,
    boardEngine,
    threads,
    board,
    stateDir: Option.isSome(relayed) ? relayed.value.stateDir : config.stateDir,
    path,
  } satisfies BoardToolDeps;
});

const readBoardState = (deps: BoardToolDeps): Effect.Effect<BoardState> =>
  deps.boardEngine.getReadModel.pipe(Effect.map((model) => model.board ?? EMPTY_BOARD_STATE));

/** The shared key-prefix resolution, as a tool error. */
const resolveCardKeyPrefix = (projectId: ProjectId, projectTitle: string) =>
  resolveBoardCardKeyPrefix(projectId, projectTitle).pipe(Effect.mapError(internalError));

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The board's settings, for resolving a card's plan review. */
const readBoardSettings = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  return (yield* settings.getSettings.pipe(Effect.mapError(internalError))).board;
});

/** The card's plan review for a command: present only when it is on, since
    the decider reads an absent one as off. */
const planReviewForCommand = (board: BoardState, card: BoardCard, settings: BoardSettings) => {
  const planReview = resolveCardPlanReview({ board, card, settings });
  return planReview.enabled ? { planReview } : {};
};

/** The instructions of a plan review this command started, or null: the
    review was not started before the call and is after it. Board
    commands are serialised, so nothing else starts one in between. */
const planReviewStartedBy = Effect.fn("BoardToolkit.planReviewStartedBy")(function* (
  deps: BoardToolDeps,
  input: {
    readonly card: BoardCard;
    readonly settings: BoardSettings;
    readonly before: BoardState;
  },
) {
  if (boardCardStepState(input.before, input.card.id)?.planReviewStartedAt !== undefined) {
    return null;
  }
  const after = yield* readBoardState(deps);
  const state = boardCardStepState(after, input.card.id);
  if (state === null || state.planReviewStartedAt === undefined) return null;
  const card = after.cards.find((candidate) => candidate.id === input.card.id) ?? input.card;
  return planReviewInstructions({ board: after, card, settings: input.settings, state });
});

/** Mint a command id (server-dispatched board command, like ws.ts). Yields
    Crypto from context, so callers need only list it as a tool dependency. */
const mintCommandId: Effect.Effect<CommandId, never, SecureRandom.SecureRandom> =
  SecureRandom.SecureRandom.pipe(
    Effect.flatMap((crypto) => crypto.uuidV4()),
    Effect.map((uuid) => CommandId.make(`mcp:board:${uuid}`)),
    Effect.orDie,
  );

const mintUuid: Effect.Effect<string, never, SecureRandom.SecureRandom> =
  SecureRandom.SecureRandom.pipe(
    Effect.flatMap((crypto) => crypto.uuidV4()),
    Effect.orDie,
  );

/** Check a pull request can be linked to a card in `projectId` —
    on the project's repository and known to the forge — or reject the call
    with the reason. Records nothing, so a create can check before it writes. */
const resolveLinkablePullRequest = Effect.fn("BoardToolkit.resolveLinkablePullRequest")(function* (
  projectId: ProjectId,
  target: BoardCardPullRequestTarget,
) {
  const supervisor = yield* SupervisorReactor;
  const resolution = yield* supervisor.resolvePullRequestLink(projectId, target);
  if (resolution.outcome === "refused") {
    return yield* new BoardToolError({ code: "invalid-input", message: resolution.detail });
  }
  return resolution.pullRequest;
});

/** Link `resolved` to the card, or clear its explicit link when null. */
const linkCardPullRequest = Effect.fn("BoardToolkit.linkCardPullRequest")(function* (
  card: Pick<BoardCard, "id" | "key">,
  resolved: BoardCardPullRequest | null,
) {
  const supervisor = yield* SupervisorReactor;
  const result = yield* supervisor.linkPullRequest(
    card.id,
    resolved === null ? null : { number: resolved.number },
    resolved === null ? undefined : { resolved },
  );
  if (result.outcome === "refused") {
    return yield* new BoardToolError({ code: "rejected", message: result.detail });
  }
  if (result.outcome === "unknown-card") {
    return yield* new BoardToolError({
      code: "card-not-found",
      message: `Card '${card.key}' no longer exists.`,
    });
  }
});

/** The card the calling thread owns, or an actionable rejection telling the
    agent how to be adopted (unlinked callers get more than a bare error). */
const requireCallerCard = (
  board: BoardState,
  scope: McpThreadInvocationScope,
): Effect.Effect<BoardCard, BoardToolError> => {
  const card = resolveBoardCardForThread(board, scope.thread.threadId);
  return card === null
    ? Effect.fail(
        new BoardToolError({
          code: "thread-not-linked",
          message:
            "This thread is not linked to a board card, so card-scoped tools cannot resolve your card. Ask a human to adopt this thread into a card (from the card's thread area), then retry.",
        }),
      )
    : Effect.succeed(card);
};

/** The card's usage total as the read tools report it (T3O-77). */
const describeUsageSummary = (
  detail: Pick<BoardCardDetail, "usage" | "usageHistoryPartial"> | null,
) => ({
  summary:
    detail === null
      ? null
      : boardCardUsageSummaryFromRows(detail.usage, detail.usageHistoryPartial),
});

/** The total with its rows, for board_get_card. */
const describeUsage = (detail: Pick<BoardCardDetail, "usage" | "usageHistoryPartial"> | null) => ({
  ...describeUsageSummary(detail),
  rows: detail?.usage ?? [],
});

/**
 * A card named by a caller acting on a card other than its own. Resolved here so the caller
 * gets `card-not-found`, and the handler still has the key to answer with after a delete.
 */
const requireTargetCard = (
  board: BoardState,
  cardId: BoardCardId,
): Effect.Effect<BoardCard, BoardToolError> => {
  const card = board.cards.find((candidate) => candidate.id === cardId);
  return card === undefined
    ? Effect.fail(
        new BoardToolError({
          code: "card-not-found",
          message: `No card '${cardId}' on this server. Call board_list_cards (with includeArchived to see the archive) for the ids that exist.`,
        }),
      )
    : Effect.succeed(card);
};

/**
 * Refuse a lifecycle write aimed at the caller's own card. Archive and delete can both reclaim
 * the worktree the calling turn runs in (unarchive does not bring it back), and delete also
 * deletes this thread, so the call could never report its own result.
 */
const refuseOwnCard = (
  board: BoardState,
  scope: McpThreadInvocationScope,
  card: BoardCard,
  consequence: string,
): Effect.Effect<void, BoardToolError> => {
  const own = resolveBoardCardForThread(board, scope.thread.threadId);
  if (own === null || own.id !== card.id) return Effect.void;
  return Effect.fail(
    new BoardToolError({
      code: "invalid-input",
      message: `'${card.key}' is the card you are working on. ${consequence}, so it cannot be done from here: ask a human to do it from the app.`,
    }),
  );
};

/**
 * Refuse a relayed write for a card that runs on another worker: an agent on one worker may
 * change its own card and the cards that run there, never another worker's. Calls from this
 * server's own threads are not relayed and pass.
 */
const refuseOtherWorkersCard = Effect.fn("BoardToolkit.refuseOtherWorkersCard")(function* (
  board: BoardState,
  scope: McpThreadInvocationScope,
  card: BoardCard,
): Effect.fn.Return<void, BoardToolError> {
  const relayed = yield* Effect.serviceOption(BoardRelayInvocation);
  if (Option.isNone(relayed)) return;
  if (resolveBoardCardForThread(board, scope.thread.threadId)?.id === card.id) return;
  // T3o: only a card placed on another worker is refused; an unplaced card and every group
  // card belong to no worker, so a build agent keeps write access to them (T3O-87).
  const target = card.group !== null ? null : boardCardPlacementTarget(card);
  if (target === null || target === relayed.value.workerId) return;
  return yield* new BoardToolError({
    code: "rejected",
    message: `'${card.key}' runs on another worker, so it cannot be changed from this one: ask a human to do it from the app.`,
  });
});

/**
 * Refuse a delete aimed at a card another agent is still working on: it force-reclaims the
 * worktree (dirty and unpushed included) and deletes busy threads. Any non-terminal step counts,
 * parked or stalled included. Archive is the way through, and the message points at it.
 */
const refuseLiveWork = (
  board: BoardState,
  card: BoardCard,
): Effect.Effect<void, BoardToolError> => {
  const state = boardCardStepState(board, card.id);
  if (state === null || isBoardTerminalStepStatus(state.status)) return Effect.void;
  return Effect.fail(
    new BoardToolError({
      code: "invalid-input",
      message: `'${card.key}' has work in flight: its ${
        state.stepLabel ?? state.stageLabel ?? state.stepId
      } step is ${state.status}. Deleting it would delete that thread mid-turn and force-remove its worktree, unpushed commits included. Archive it with board_archive_card instead (reversible, and it leaves a dirty checkout alone), or wait for the step to settle.`,
    }),
  );
};

/**
 * Which step a completion applies to: the caller's own LIVE step (the thread match stops a
 * sibling thread settling a run it did not perform; a planning thread kept after leaving Planning
 * owns its abandoned step), else the caller's own SETTLED completion so a retry stays idempotent,
 * else reject. An explicit `stepId` is refused when it names another thread's live step.
 */
const resolveCompletionStepId = (
  board: BoardState,
  card: BoardCard,
  scope: McpThreadInvocationScope,
  stepId: string | undefined,
): Effect.Effect<string, BoardToolError> => {
  const state = boardCardStepState(board, card.id);
  const live = state !== null && !isBoardTerminalStepStatus(state.status) ? state : null;
  const kept = keptPlanningStepId(board, card, scope.thread.threadId);
  const ownCompletions = boardCardStepCompletions(board, card.id).filter(
    (completion) => completion.threadId === scope.thread.threadId,
  );

  const candidate =
    stepId !== undefined
      ? stepId
      : live !== null && live.threadId === scope.thread.threadId
        ? live.stepId
        : (kept ?? ownCompletions[ownCompletions.length - 1]?.stepId);

  if (candidate === undefined) {
    return Effect.fail(
      new BoardToolError({
        code: "invalid-input",
        message: `This thread has no work in progress on card '${card.key}', so there is nothing to complete. If your prompt gave you a stepId, pass it explicitly.`,
      }),
    );
  }

  // Guard the RESOLVED id, not just an explicit one: step ids repeat across stage entries, so a
  // stale thread could resolve to a step a NEW thread is now running and overwrite its live run.
  if (
    live !== null &&
    live.stepId === candidate &&
    live.threadId !== null &&
    live.threadId !== scope.thread.threadId
  ) {
    return Effect.fail(
      new BoardToolError({
        code: "invalid-input",
        message: `Step '${candidate}' on card '${card.key}' is being run by another thread. Complete only the work you were assigned; omit stepId and the board will resolve yours.`,
      }),
    );
  }

  return Effect.succeed(candidate);
};

/** Resolve label NAMES against the live catalogue to ids; an unknown name is
    rejected with the live list: tagging never creates labels. */
const resolveLabelIds = (
  board: BoardState,
  names: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<BoardLabelId>, BoardToolError> => {
  const live = boardLabelCatalogue(board).filter((label) => label.deletedAt === null);
  const ids: BoardLabelId[] = [];
  for (const name of names) {
    const match = live.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (match === undefined) {
      const catalogue = live.map((label) => label.name).join(", ") || "(none)";
      return Effect.fail(
        new BoardToolError({
          code: "unknown-label",
          message: `No label named '${name}'. Existing labels: ${catalogue}. Create it with board_manage_labels (action 'create') first. Tagging does not create labels.`,
        }),
      );
    }
    ids.push(match.labelId);
  }
  return Effect.succeed(ids);
};

/** The non-archived cards carrying a label. */
const labelCarriers = (board: BoardState, labelId: BoardLabelId): ReadonlyArray<BoardCard> =>
  board.cards.filter((card) => card.archivedAt === null && card.labels.includes(labelId));

/** A catalogue entry as `board_manage_labels` returns it: by name, never id. */
const managedLabel = (board: BoardState, label: BoardLabel) => ({
  name: label.name,
  colour: label.colour,
  deleted: label.deletedAt !== null,
  cardCount: labelCarriers(board, label.labelId).length,
});

const sameLabelName = (label: BoardLabel, name: string): boolean =>
  label.name.toLowerCase() === name.toLowerCase();

const formatLabelNames = (labels: ReadonlyArray<BoardLabel>): string =>
  labels.map((label) => label.name).join(", ") || "(none)";

/**
 * Resolve a `board_manage_labels` target by case-insensitive name. Restore acts on the most
 * recently deleted label of that name; every other action on a live one. A live-only miss that
 * matches a deleted label says so, since the fix is restore rather than a typo.
 */
const resolveManagedLabel = (
  board: BoardState,
  name: string,
  deleted: boolean,
): Effect.Effect<BoardLabel, BoardToolError> => {
  const catalogue = boardLabelCatalogue(board);
  const live = catalogue.filter((label) => label.deletedAt === null);
  const tombstones = catalogue.filter((label) => label.deletedAt !== null);
  if (deleted) {
    // Catalogue order is creation order, so `>=` breaks a deletedAt tie
    // toward the newer label.
    const match = tombstones
      .filter((label) => sameLabelName(label, name))
      .reduce<BoardLabel | undefined>(
        (latest, label) =>
          latest === undefined || (label.deletedAt ?? "") >= (latest.deletedAt ?? "")
            ? label
            : latest,
        undefined,
      );
    if (match !== undefined) return Effect.succeed(match);
    return Effect.fail(
      new BoardToolError({
        code: "unknown-label",
        message: live.some((label) => sameLabelName(label, name))
          ? `Label '${name}' is not deleted, so there is nothing to restore.`
          : `No deleted label named '${name}'. Deleted labels: ${formatLabelNames(tombstones)}.`,
      }),
    );
  }
  const match = live.find((label) => sameLabelName(label, name));
  if (match !== undefined) return Effect.succeed(match);
  return Effect.fail(
    new BoardToolError({
      code: "unknown-label",
      message: tombstones.some((label) => sameLabelName(label, name))
        ? `Label '${name}' is deleted. Restore it with action 'restore' first.`
        : `No label named '${name}'. Existing labels: ${formatLabelNames(live)}.`,
    }),
  );
};

type BoardLabelCommand =
  | BoardLabelCreateCommand
  | BoardLabelUpdateCommand
  | BoardLabelDeleteCommand
  | BoardLabelUndeleteCommand;

/** At most this many carrying cards are named when a delete is refused. */
const LABEL_CARRIERS_NAMED_MAX = 10;

/** The non-deleted projects the caller can target. */
const listProjects = (
  deps: BoardToolDeps,
): Effect.Effect<ReadonlyArray<BoardProject>, BoardToolError> =>
  deps.threads.projects().pipe(
    Effect.map((projects) => projects.filter((project) => !project.deleted)),
    Effect.mapError(internalError),
  );

/** The trailing path segment, so `~/projects/t3o-test` and
    `/home/ai1/projects/t3o-test` both compare as `t3o-test`. */
const workspaceBasename = (value: string): string => {
  const trimmed = value.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] ?? trimmed;
};

/** Available projects as `id — title`, the same "rejected with the live list"
    shape unknown labels use, so an agent that guessed wrong is handed the exact
    ids to retry with. */
const formatProjectList = (projects: ReadonlyArray<BoardProject>): string =>
  projects.map((project) => `${project.id} (${project.title})`).join("; ") || "(none)";

/**
 * The project a card is created in. With no `projectId`, the calling thread's own project. A
 * given one matches as an id, then leniently by title or workspace-root folder name, since agents
 * guess names. Anything unresolvable is rejected with the live project list.
 */
const resolveProjectId = Effect.fn("BoardToolkit.resolveProjectId")(function* (
  deps: BoardToolDeps,
  projects: ReadonlyArray<BoardProject>,
  input: string | undefined,
): Effect.fn.Return<ProjectId, BoardToolError> {
  if (input === undefined) {
    const thread = yield* deps.threads
      .threadState(deps.scope.thread.threadId)
      .pipe(Effect.mapError(internalError));
    const owned =
      thread !== null && thread !== UNKNOWN_THREAD_STATE
        ? projects.find((project) => project.id === thread.projectId)
        : undefined;
    if (owned !== undefined) {
      return owned.id;
    }
    // Either the thread has no project row, or its project was deleted — both
    // leave nothing to default to, so name the projects that CAN be targeted.
    return yield* new BoardToolError({
      code: "invalid-input",
      message: `No project given, and this thread has no active project to default to. Pass projectId (call board_list_projects for the ids). Available projects: ${formatProjectList(projects)}.`,
    });
  }
  const byId = projects.find((project) => project.id === input);
  if (byId !== undefined) {
    return byId.id;
  }
  const lowered = input.toLowerCase();
  const byTitle = projects.filter((project) => project.title.toLowerCase() === lowered);
  if (byTitle.length === 1) {
    return byTitle[0]!.id;
  }
  if (byTitle.length > 1) {
    return yield* new BoardToolError({
      code: "invalid-input",
      message: `'${input}' matches more than one project by title. Pass an id instead. Matching projects: ${formatProjectList(byTitle)}.`,
    });
  }
  // Case-insensitive like the title match above — friendly to a guessed
  // folder name and correct on case-insensitive filesystems (macOS). Two
  // folders differing only in case fall through to the ambiguity branch
  // rather than silently mismatching.
  const inputBasename = workspaceBasename(input).toLowerCase();
  const byPath = projects.filter(
    (project) => workspaceBasename(project.workspaceRoot).toLowerCase() === inputBasename,
  );
  if (byPath.length === 1) {
    return byPath[0]!.id;
  }
  if (byPath.length > 1) {
    return yield* new BoardToolError({
      code: "invalid-input",
      message: `'${input}' matches more than one project by workspace folder. Pass an id instead. Matching projects: ${formatProjectList(byPath)}.`,
    });
  }
  return yield* new BoardToolError({
    code: "invalid-input",
    message: `No project matches '${input}' by id, title, or workspace folder. Available projects: ${formatProjectList(projects)}.`,
  });
});

/**
 * A card named by key or id. An id match wins; otherwise the key is
 * matched case-insensitively, because agents copy keys out of prose. Keys are
 * unique per project prefix, so two projects sharing a prefix could collide —
 * that is reported with both ids rather than guessed between.
 */
const findCardByKeyOrId = (
  board: BoardState,
  value: string,
): Effect.Effect<BoardCard, BoardToolError> => {
  const byId = board.cards.find((card) => card.id === value);
  if (byId !== undefined) return Effect.succeed(byId);
  const lowered = value.toLowerCase();
  const byKey = board.cards.filter((card) => card.key.toLowerCase() === lowered);
  if (byKey.length === 1) return Effect.succeed(byKey[0]!);
  return Effect.fail(
    new BoardToolError(
      byKey.length === 0
        ? {
            code: "card-not-found",
            message: `No card with key or id '${value}'. Call board_list_cards (with includeArchived to see the archive) for the cards that exist.`,
          }
        : {
            code: "invalid-input",
            message: `'${value}' matches more than one card by key; pass an id instead: ${byKey.map((card) => `${card.id} (project ${card.projectId})`).join(", ")}.`,
          },
    ),
  );
};

/** A card's dependencies with keys, titles and whether each is met, by the board's one shared
    gating rule (`unmetBoardCardDependencies`): an archived dependency no longer gates. */
const describeDependencies = (board: BoardState, card: BoardCard) => {
  const unmet = new Set(
    unmetBoardCardDependencies({ board, dependsOn: card.dependsOn, cards: board.cards }),
  );
  return card.dependsOn.map((dependencyId) => {
    const dependency = board.cards.find((candidate) => candidate.id === dependencyId);
    return {
      cardId: dependencyId,
      key: dependency?.key ?? dependencyId,
      title: dependency?.title ?? dependencyId,
      stage: dependency?.stage ?? BOARD_SEED_STAGE_IDS.backlog,
      met: !unmet.has(dependencyId),
    };
  });
};

/**
 * Dispatch a board command stamped with the AGENT actor, which the projector reads back for
 * Activity. The provider instance and thread come from the invocation scope, never tool input,
 * so an agent cannot misreport itself.
 */
const dispatch = (
  deps: BoardToolDeps,
  command: BoardCommand,
): Effect.Effect<{ readonly sequence: number }, BoardToolError> => {
  stampBoardActivityActor(
    command.commandId,
    boardAgentActor({
      providerInstanceId: deps.scope.thread.providerInstanceId,
      threadId: deps.scope.thread.threadId,
    }),
  );
  return deps.boardEngine.dispatch(command).pipe(Effect.mapError(dispatchError));
};

/** `approved` is the agent's own word; a run with no human in the loop has
    nobody who could have given it, and a delegated child never spoke to one. */
const refuseUnattendedApproval = Effect.fn("BoardToolkit.refuseUnattendedApproval")(function* (
  deps: BoardToolDeps,
  message: string,
) {
  if (deps.scope.thread.subagent === true) {
    return yield* new BoardToolError({
      code: "invalid-input",
      message:
        "A delegated task cannot pass approved: true, because it never spoke to the human. Report the change back to the thread that delegated you instead.",
    });
  }
  const board = yield* readBoardState(deps);
  const own = resolveBoardCardForThread(board, deps.scope.thread.threadId);
  const state = own === null ? null : boardCardStepState(board, own.id);
  if (
    state !== null &&
    !state.humanInLoop &&
    !isBoardTerminalStepStatus(state.status) &&
    state.threadId === deps.scope.thread.threadId
  ) {
    return yield* new BoardToolError({ code: "invalid-input", message });
  }
});

/**
 * Regrouping is direct but needs a human's say-so: the agent must
 * describe the change, get explicit confirmation, and pass `approved: true`.
 */
const requireRegroupApproval = Effect.fn("BoardToolkit.requireRegroupApproval")(function* (
  deps: BoardToolDeps,
  approved: boolean | undefined,
): Effect.fn.Return<void, BoardToolError> {
  if (approved !== true) {
    return yield* new BoardToolError({
      code: "invalid-input",
      message:
        "Regrouping changes how cards build and where they merge, so it needs a human. Describe the regrouping to the user, ask them to confirm it, and once they have, call again with approved: true.",
    });
  }
  yield* refuseUnattendedApproval(
    deps,
    "This run is unattended, so nobody can confirm a regrouping. Leave the board's grouping as it is and mention the suggestion in your summary for a human to apply.",
  );
});

/** A destructive group flow needs a human's explicit say-so. */
const requireDestructiveApproval = (
  deps: BoardToolDeps,
  approved: boolean | undefined,
  what: string,
) =>
  approved === true
    ? refuseUnattendedApproval(
        deps,
        `This run is unattended, so nobody can confirm this. ${what} cannot be undone; leave it alone and mention it in your summary for a human to do.`,
      )
    : Effect.fail(
        new BoardToolError({
          code: "invalid-input",
          message: `${what} cannot be undone. Describe exactly what will be lost to the user, ask them to confirm it, and once they have, call again with approved: true.`,
        }),
      );

const resolveCardRefs = (board: BoardState, refs: ReadonlyArray<string>) =>
  Effect.forEach(refs, (ref) => findCardByKeyOrId(board, ref));

const regroupRefused = (reason: string) =>
  new BoardToolError({ code: "invalid-input", message: reason });

/** Dispatch one move-cards command and answer with where the cards landed. */
const dispatchMoveCards = Effect.fn("BoardToolkit.dispatchMoveCards")(function* (
  deps: BoardToolDeps,
  input: {
    readonly cardIds: ReadonlyArray<BoardCardId>;
    readonly parentCardId: BoardCardId | null;
    readonly afterCardId?: BoardCardId | undefined;
    readonly beforeCardId?: BoardCardId | undefined;
  },
) {
  const command: BoardCardMoveCardsCommand = {
    type: "board.card.move-cards",
    commandId: yield* mintCommandId,
    cardId: input.cardIds[0]!,
    cardIds: input.cardIds,
    parentCardId: input.parentCardId,
    ...(input.afterCardId === undefined ? {} : { afterCardId: input.afterCardId }),
    ...(input.beforeCardId === undefined ? {} : { beforeCardId: input.beforeCardId }),
    createdAt: yield* nowIso,
  };
  yield* dispatch(deps, command);
  const after = yield* readBoardState(deps);
  const parentKey =
    input.parentCardId === null
      ? null
      : (after.cards.find((card) => card.id === input.parentCardId)?.key ?? input.parentCardId);
  return { cardIds: input.cardIds, parentKey };
});

/** The groups a card sits in, nearest first. */
const describeAncestors = (deps: BoardToolDeps, board: BoardState, card: BoardCard) =>
  Effect.forEach(boardCardAncestors(board, card), (ancestor) =>
    Effect.gen(function* () {
      const brief = yield* deps.board.boardCardBrief(ancestor.id);
      const decisions = yield* deps.board.boardCardDecisions(ancestor.id);
      const truncated = brief !== null && brief.length > ANCESTOR_BRIEF_MAX_CHARS;
      return {
        cardId: ancestor.id,
        key: ancestor.key,
        title: ancestor.title,
        brief: truncated ? `${brief.slice(0, ANCESTOR_BRIEF_MAX_CHARS)}…` : brief,
        briefTruncated: truncated,
        plans: boardCardPlans(board, ancestor.id),
        decisions: sortBoardCardDecisions(decisions).slice(0, CONTEXT_DECISIONS_MAX),
      };
    }).pipe(Effect.mapError(internalError)),
  );

/** The plan a card was cut from, its body omitted when it is the brief. */
const describeSourcePlan = Effect.fn("BoardToolkit.describeSourcePlan")(function* (
  deps: BoardToolDeps,
  board: BoardState,
  card: BoardCard,
  brief: string | null,
) {
  if (card.sourcePlanId === null) return null;
  const planId = card.sourcePlanId;
  const plan = (board.plans ?? []).find((candidate) => candidate.planId === planId);
  if (plan === undefined) return null;
  const body = yield* deps.board.boardPlanBody(planId).pipe(Effect.mapError(internalError));
  return { plan, body: body === null || body.trim() === brief?.trim() ? null : body };
});

export const boardHandlers = {
  board_get_card_context: Effect.fn("BoardToolkit.board_get_card_context")(function* () {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireCallerCard(board, deps.scope);
    const detail = yield* deps.board.boardCardDetail(card.id).pipe(Effect.mapError(internalError));
    const activity = yield* deps.board
      .boardCardActivity(card.id)
      .pipe(Effect.mapError(internalError));
    // Per-thread todo summaries: what a restarted agent — or a
    // second thread on the same card — actually wanted from the progress notes
    // this replaces.
    const threads = yield* deps.board
      .boardCardThreads(card.id)
      .pipe(Effect.mapError(internalError));
    const dependencies = describeDependencies(board, card);
    // A reviewer reads with fresh eyes: when the caller is the
    // card's live `review@N` step, earlier review-loop steps and their
    // threads are left out. A caller the board cannot place gets it all.
    const liveStep = boardCardStepState(board, card.id);
    const reviewCaller =
      liveStep !== null &&
      !isBoardTerminalStepStatus(liveStep.status) &&
      liveStep.threadId === deps.scope.thread.threadId &&
      parseReviewStepId(liveStep.stepId)?.phase === "review";
    // Link roles name every review-loop thread, including attempts that
    // never recorded a completion; completions cover links since dropped.
    const reviewLoopThreadIds = new Set<string>(
      [
        ...card.threadLinks
          .filter((link) => parseReviewStepId(link.role) !== null)
          .map((link) => link.threadId),
        ...boardCardStepCompletions(board, card.id)
          .filter((completion) => parseReviewStepId(completion.stepId) !== null)
          .map((completion) => completion.threadId),
      ].filter(
        (threadId): threadId is NonNullable<typeof threadId> =>
          threadId !== null && threadId !== deps.scope.thread.threadId,
      ),
    );
    // A running plan review's instructions, so a re-orienting agent
    // picks the review up where it was.
    const settings = yield* readBoardSettings;
    const reviewStep = runningPlanReviewStep({ board, card, settings });
    const planReview =
      reviewStep === null
        ? null
        : planReviewInstructions({ board, card, settings, state: reviewStep });
    // A relayed call hands out paths on the worker, so the
    // card's files go there first — staging at spawn misses later ones.
    const relayed = yield* Effect.serviceOption(BoardRelayInvocation);
    if (Option.isSome(relayed) && card.attachments.length > 0) {
      const config = yield* ServerConfig.ServerConfig;
      const files = boardCardAttachmentManifest({
        path: deps.path,
        stateDir: config.stateDir,
        card,
      }).map((entry) => ({ name: entry.name, path: entry.path }));
      yield* relayed.value.stageCardFiles({ cardId: String(card.id), files }).pipe(
        Effect.mapError(
          () =>
            new BoardToolError({
              code: "board-unreachable",
              message:
                "Couldn't copy the card's files to the machine this thread runs on. This is temporary: retry the call.",
            }),
        ),
      );
    }
    return {
      capacity: boardCardCapacityFor(board, card),
      card: reviewCaller
        ? {
            ...card,
            threadLinks: card.threadLinks.filter((link) => !reviewLoopThreadIds.has(link.threadId)),
          }
        : card,
      brief: detail?.brief ?? null,
      briefVersion: boardBriefVersion(detail?.brief ?? null),
      // Pull, not push (K3): every linked thread lists the brief's files
      // with a path it can read; added-later files show on the next call.
      attachments: boardCardAttachmentManifest({
        path: deps.path,
        stateDir: deps.stateDir,
        card,
      }),
      dependencies,
      steps: reviewCaller
        ? boardCardStepCompletions(board, card.id).filter(
            (completion) => parseReviewStepId(completion.stepId) === null,
          )
        : boardCardStepCompletions(board, card.id),
      currentStep: (() => {
        // The live step, the half of the orientation contract `steps` never
        // carried. A settled row is not "current": once the work is
        // terminal there is nothing assigned, and reporting it would invite
        // an agent to complete an id the decider will reject.
        const state = boardCardStepState(board, card.id);
        if (state === null || isBoardTerminalStepStatus(state.status)) return null;
        return {
          stepId: state.stepId,
          stepLabel: state.stepLabel,
          stageLabel: state.stageLabel,
          status: state.status,
          attempt: state.attempt,
        };
      })(),
      plans: boardCardPlans(board, card.id),
      activity,
      threads: reviewCaller
        ? threads.filter((entry) => !reviewLoopThreadIds.has(entry.threadId))
        : threads,
      ancestors: yield* describeAncestors(deps, board, card),
      sourcePlan: yield* describeSourcePlan(deps, board, card, detail?.brief ?? null),
      decisions: sortBoardCardDecisions(detail?.decisions ?? []).slice(0, CONTEXT_DECISIONS_MAX),
      ...(planReview === null ? {} : { planReview }),
      usage: describeUsageSummary(detail),
    };
  }),

  board_complete_step: Effect.fn("BoardToolkit.board_complete_step")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireCallerCard(board, deps.scope);
    // Scoped to the CALLING THREAD, not just the card: once the card has moved on, a late retry
    // is rejected instead of completing the next stage's step.
    const stepId = yield* resolveCompletionStepId(board, card, deps.scope, input.stepId);
    const settings = yield* readBoardSettings;
    // Idempotency is decided in the decider (re-emit the first outcome); the
    // pre-read here is only to tell the agent its retry was a no-op.
    const existing = boardCardStepCompletions(board, card.id).find(
      (completion) => completion.stepId === stepId,
    );
    // ...except on the recovery-retry path: the decider supersedes a non-succeeded completion
    // while the same step is live again, so mirror it to avoid replying "already completed".
    const liveState = boardCardStepState(board, card.id);
    const liveMatch =
      liveState !== null &&
      liveState.stepId === stepId &&
      !isBoardTerminalStepStatus(liveState.status);
    // The decider's matching rule for a planning thread kept past its stage: it may still
    // record its own abandoned step.
    const keptMatch = isKeptStepThread(board, card, stepId, deps.scope.thread.threadId);
    const supersedes =
      (existing !== undefined && existing.outcome !== "succeeded" && (liveMatch || keptMatch)) ||
      (input.outcome === "succeeded" && liveMatch && boardCompletionReopened(existing, liveState));
    // A `succeeded` record with an unreadable payload is repaired, not re-emitted. Mirrors the
    // decider so the reply is right; only a valid completion may repair (checked below).
    const repairs =
      existing !== undefined &&
      existing.outcome === "succeeded" &&
      boardStepPayloadDefect({ stepId, payload: existing.payload }) !== null;
    // The decider's rule for "this call may record something". Every other call is an
    // idempotent no-op, so the checks below are scoped to it, which also orders the errors.
    const recordable = liveMatch || keptMatch || repairs;
    // Stored verbatim as opaque JSON. An agent that stringified the payload itself would be
    // wrapped twice, so one level comes off first and storage stays canonical.
    const structured =
      input.payload === undefined ? undefined : unwrapStringifiedBoardStepPayload(input.payload);
    // @effect-diagnostics-next-line globalJsonInEffect:off
    const payload = structured === undefined ? null : JSON.stringify(structured);
    // Checked BEFORE the caps: a summary carrying the whole payload is over the summary cap,
    // and "shorten your prose" cannot fix bytes that are in the wrong field.
    if (recordable && payload === null && leaksSerialisedArguments(input.summary)) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message:
          "The summary contains serialised tool-call markup and no payload argument arrived, so the payload was folded into the summary rather than passed as its own field. Send the prose as `summary` and the structured result as the separate `payload` argument, then complete the step again.",
      });
    }
    // The completion lives in the event log and every card detail frame for the card's
    // lifetime, so both sizes are capped with an actionable reject naming the field.
    if (payload !== null && utf8ByteLength(payload) > BOARD_STEP_PAYLOAD_MAX_BYTES) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message: `The payload serialises to ${utf8ByteLength(payload)} bytes, over the ${BOARD_STEP_PAYLOAD_MAX_BYTES}-byte cap. Keep the structured payload small (ids, verdicts, findings) and put prose in the summary.`,
      });
    }
    if (utf8ByteLength(input.summary) > BOARD_STEP_SUMMARY_MAX_BYTES) {
      return yield* new BoardToolError({
        code: "invalid-input",
        // An oversized summary with no payload beside it is the leak's other
        // shape — the markers may be gone, but a summary this big on a call
        // that reported no structured result usually swallowed one.
        message: `The summary is ${utf8ByteLength(input.summary)} bytes, over the ${BOARD_STEP_SUMMARY_MAX_BYTES}-byte cap. Summarise in a few sentences; details belong in the payload.${payload === null ? " No payload argument arrived with it: if this summary contains one, resend it as the separate `payload` argument rather than shortening it away." : ""}`,
      });
    }
    // Triage and adjudication never park for a human: triage fixes
    // or rejects, and only the adjudicator escalates, per finding.
    if (recordable && input.outcome === "blocked") {
      const refusal = boardReviewBlockedOutcomeRefusal(stepId);
      if (refusal !== null) {
        return yield* new BoardToolError({ code: "invalid-input", message: refusal });
      }
    }
    // Refused HERE, not in the decider: a recorded unreadable success would halt the review
    // loop `unreadable` for good. The step stays live for the agent's retry.
    if (recordable && input.outcome === "succeeded") {
      const defect = boardStepPayloadDefect({ stepId, payload });
      if (defect !== null) {
        return yield* new BoardToolError({ code: "invalid-input", message: defect });
      }
      // The round's own rules on a new review-loop write: every
      // listed finding answered, a human's must-fix never rejected, and the
      // adjudicator's `anotherRound` stated. Never in the decider, which
      // also judges records written before these rules.
      const roundDefect = boardReviewCompletionDefect({
        stepId,
        payload,
        completions: boardCardStepCompletions(board, card.id),
        carriedFindings: card.reviewOverrides?.carriedFindings ?? {},
        roundModes: card.reviewOverrides?.roundModes ?? {},
      });
      if (roundDefect !== null) {
        return yield* new BoardToolError({ code: "invalid-input", message: roundDefect });
      }
      // The build-role stage's step (its id is the stage id) owes the
      // structured summary the Summary pane renders. Checked here
      // only — never in the decider — so builds recorded before the
      // contract keep their null payloads without reading as repairable.
      if (boardStageWithRole(board, "build")?.stageId === stepId) {
        const buildDefect = boardBuildStepPayloadDefect(payload);
        if (buildDefect !== null) {
          return yield* new BoardToolError({ code: "invalid-input", message: buildDefect });
        }
      }
    }
    const command: BoardCardCompleteStepCommand = {
      type: "board.card.complete-step",
      commandId: yield* mintCommandId,
      cardId: card.id,
      stepId,
      outcome: input.outcome,
      summary: input.summary,
      payload,
      threadId: deps.scope.thread.threadId,
      ...planReviewForCommand(board, card, settings),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    // Plan review held the completion back: nothing was recorded.
    // A plain reply, not an error, so the agent runs the review rather than
    // reaching for a blocked or failed outcome.
    const planReview = yield* planReviewStartedBy(deps, {
      card,
      settings,
      before: board,
    });
    if (planReview !== null) {
      return {
        stepId,
        outcome: input.outcome,
        alreadyCompleted: false,
        completed: false,
        planReview,
        message:
          "Not recorded yet: plan review is on for this card. Run it as the instructions in planReview say, then call board_complete_step again.",
      };
    }
    const replaced = supersedes || repairs;
    return {
      stepId,
      outcome: replaced ? input.outcome : (existing?.outcome ?? input.outcome),
      alreadyCompleted: existing !== undefined && !replaced,
    };
  }),

  board_get_card: Effect.fn("BoardToolkit.board_get_card")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* findCardByKeyOrId(board, input.card);
    const detail = yield* deps.board.boardCardDetail(card.id).pipe(Effect.mapError(internalError));
    const brief = detail?.brief ?? null;
    const catalogue = boardLabelCatalogue(board);
    const parent =
      card.parentCardId === null
        ? undefined
        : board.cards.find((candidate) => candidate.id === card.parentCardId);
    return {
      cardId: card.id,
      key: card.key,
      projectId: card.projectId,
      title: card.title,
      stage: card.stage,
      capacity: boardCardCapacityFor(board, card),
      labels: card.labels.flatMap((labelId) => {
        const label = catalogue.find((candidate) => candidate.labelId === labelId);
        return label === undefined ? [] : [label.name];
      }),
      blocked: card.blocked,
      archived: card.archivedAt !== null,
      parent:
        parent === undefined ? null : { cardId: parent.id, key: parent.key, title: parent.title },
      baseBranch: card.baseBranch,
      mergeStrategy: card.mergeStrategy,
      effectiveMergeStrategy: yield* effectiveMergeStrategy(board, card),
      brief,
      briefVersion: boardBriefVersion(brief),
      dependencies: describeDependencies(board, card),
      plans: detail?.plans ?? [],
      pullRequest:
        card.pullRequest === null
          ? null
          : {
              number: card.pullRequest.number,
              url: card.pullRequest.url,
              state: card.pullRequest.state,
              title: card.pullRequest.title,
              isDraft: card.pullRequest.isDraft === true,
              linked: card.pullRequest.linked === true,
            },
      pullRequestHistory: card.pullRequestHistory.map((entry) => ({
        number: entry.number,
        state: entry.state,
      })),
      usage: describeUsage(detail),
    };
  }),

  board_list_projects: Effect.fn("BoardToolkit.board_list_projects")(function* () {
    const deps = yield* boardToolDeps;
    const projects = yield* listProjects(deps);
    return {
      projects: projects.map((project) => ({
        projectId: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      })),
    };
  }),

  board_list_cards: Effect.fn("BoardToolkit.board_list_cards")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const text = input.text?.toLowerCase();
    const cards = board.cards
      // Archived cards are off the board, so they stay out by default — but
      // an agent that may unarchive or delete one needs a way to see it
      //, and `board_get_card_context` only ever resolves its own.
      .filter((card) => input.includeArchived === true || card.archivedAt === null)
      .filter((card) => input.projectId === undefined || card.projectId === input.projectId)
      .filter((card) => input.stage === undefined || card.stage === input.stage)
      .filter((card) => input.key === undefined || card.key === input.key)
      .filter((card) => text === undefined || card.title.toLowerCase().includes(text))
      .map((card) => ({
        cardId: card.id,
        key: card.key,
        projectId: card.projectId,
        title: card.title,
        stage: card.stage,
        blocked: card.blocked,
        archived: card.archivedAt !== null,
        dependsOn: card.dependsOn.map((dependencyId) => ({
          cardId: dependencyId,
          key: board.cards.find((candidate) => candidate.id === dependencyId)?.key ?? dependencyId,
        })),
      }));
    return { cards };
  }),

  board_create_card: Effect.fn("BoardToolkit.board_create_card")(function* (input) {
    const deps = yield* boardToolDeps;
    // One project read for the whole create: project resolution and the
    // key-prefix title both read from it.
    const projects = yield* listProjects(deps);
    // Resolve the target project first (t3o: omitted → this thread's project;
    // a title or workspace folder → its id), so a card never dispatches
    // against a phantom project and an unresolvable target is rejected up
    // front with the live project list.
    const projectId = yield* resolveProjectId(deps, projects, input.projectId);
    const projectTitle = projects.find((project) => project.id === projectId)?.title ?? "";
    const board = yield* readBoardState(deps);
    const labels = yield* resolveLabelIds(board, input.labels ?? []);
    // Pre-validate dependencies for the friendlier tool-shaped message; the
    // decider re-checks existence inside the one atomic create below.
    const dependsOn = input.dependsOn ?? [];
    for (const dependencyId of dependsOn) {
      if (!board.cards.some((card) => card.id === dependencyId)) {
        return yield* new BoardToolError({
          code: "invalid-input",
          message: `Dependency '${dependencyId}' does not exist; create it (or drop it) before adding it as a dependency.`,
        });
      }
    }
    // Checked before the card exists, so a pull request that is
    // missing or on another repository rejects the call with no card left
    // behind to clean up.
    const pullRequest =
      input.pullRequest === undefined
        ? null
        : yield* resolveLinkablePullRequest(projectId, input.pullRequest);
    const parent =
      input.parentCardId === undefined
        ? undefined
        : yield* findCardByKeyOrId(board, input.parentCardId);
    // Creating under a leaf converts it to a group: the same regrouping
    // board_indent_cards gates behind a human.
    if (parent !== undefined && boardCardGroupOf(board, parent) === null) {
      yield* requireRegroupApproval(deps, input.approved);
    }
    const cardId = BoardCardId.make(yield* mintUuid);
    // ONE atomic command: the create command carries `brief` and `dependsOn`
    // natively, so the card lands whole — no follow-up update whose
    // rejection or a mid-write crash could strand a half-built card while
    // the tool reports an error (inviting a retry that mints a duplicate).
    yield* createBoardCard({
      engine: deps.boardEngine,
      actor: boardAgentActor({
        providerInstanceId: deps.scope.thread.providerInstanceId,
        threadId: deps.scope.thread.threadId,
      }),
      projectTitle,
      create: {
        commandId: yield* mintCommandId,
        cardId,
        projectId,
        title: input.title,
        ...(input.brief === undefined ? {} : { brief: input.brief }),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
        labels,
        // No default here: the decider picks it, and it alone sees whether
        // the parent group has started.
        ...(input.stage === undefined ? {} : { stage: input.stage }),
        ...(parent === undefined ? {} : { parentCardId: parent.id }),
        // No `orderKey`: the decider places the card at the bottom of the
        // stage's column, which is the only place that can see the
        // whole board — this tool's read model is filtered to one project.
        ...(input.mergeStrategy === undefined ? {} : { mergeStrategy: input.mergeStrategy }),
        createdAt: yield* nowIso,
      },
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "ServerSettingsError" ? internalError(error) : dispatchError(error),
      ),
    );
    // Read back the allocated key.
    const after = yield* readBoardState(deps);
    const created = after.cards.find((card) => card.id === cardId);
    const key = created?.key ?? cardId;
    if (pullRequest !== null) {
      // The card exists now, so a failure here must say so: a retried
      // create would make a second card.
      yield* linkCardPullRequest({ id: cardId, key }, pullRequest).pipe(
        Effect.mapError(
          (error) =>
            new BoardToolError({
              code: error.code,
              message: `Card ${key} was created, but linking pull request #${pullRequest.number} failed: ${error.message} Retry the link with board_update_card on ${key}; do not create the card again.`,
            }),
        ),
      );
    }
    return { cardId, key };
  }),

  board_move_card: Effect.fn("BoardToolkit.board_move_card")(function* (input) {
    const deps = yield* boardToolDeps;
    let board = yield* readBoardState(deps);
    let card = board.cards.find((candidate) => candidate.id === input.cardId);
    if (card !== undefined) yield* refuseOtherWorkersCard(board, deps.scope, card);
    if (input.toStage === undefined && input.parentCardId === undefined) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message: "Pass toStage, parentCardId, or both.",
      });
    }
    // Regrouping first, so a stage move lands in the new group.
    if (input.parentCardId !== undefined) {
      yield* requireRegroupApproval(deps, input.approved);
      const target = yield* requireTargetCard(board, input.cardId);
      const parent =
        input.parentCardId === null ? null : yield* findCardByKeyOrId(board, input.parentCardId);
      const after =
        input.afterCardId === undefined
          ? undefined
          : yield* findCardByKeyOrId(board, input.afterCardId);
      const before =
        input.beforeCardId === undefined
          ? undefined
          : yield* findCardByKeyOrId(board, input.beforeCardId);
      yield* dispatchMoveCards(deps, {
        cardIds: [target.id],
        parentCardId: parent?.id ?? null,
        afterCardId: after?.id,
        beforeCardId: before?.id,
      });
      if (input.toStage === undefined) {
        const moved = (yield* readBoardState(deps)).cards.find((c) => c.id === target.id);
        return { cardId: target.id, stage: moved?.stage ?? target.stage };
      }
      board = yield* readBoardState(deps);
      // The order key below must come from the new group's column.
      card = board.cards.find((candidate) => candidate.id === target.id);
    }
    const toStage = input.toStage!;
    // A bottom key in the target column, so a cross-stage move lands last. No key for a missing
    // card (the decider rejects it) or for the done-role stage (the decider places it on top).
    const doneStageId = boardStageWithRole(board, "done")?.stageId ?? null;
    const orderKey =
      card === undefined || toStage === doneStageId
        ? undefined
        : boardAppendOrderKey(
            // One key space per stage within the card's board (root or parent's sub-board),
            // archived cards excluded, as every other placement uses.
            boardColumnOrderKeys({
              cards: board.cards,
              stage: toStage,
              parentCardId: card.parentCardId,
            }),
          );
    const command: BoardCardMoveCommand = {
      type: "board.card.move",
      commandId: yield* mintCommandId,
      cardId: input.cardId,
      toStage: toStage,
      orderKey,
      override: input.override,
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { cardId: input.cardId, stage: toStage };
  }),

  board_update_card: Effect.fn("BoardToolkit.board_update_card")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    // The target takes a key as readily as its dependency fields do.
    const target = yield* findCardByKeyOrId(board, input.cardId);
    yield* refuseOtherWorkersCard(board, deps.scope, target);
    const cardId = target.id;
    const labels =
      input.labels === undefined ? undefined : yield* resolveLabelIds(board, input.labels);
    // An added label must be live. A removed one must name a catalogue label (deleted ones
    // included) so a typo is reported, and resolves against the target's own labels.
    const overlap = input.addLabels?.find((name) =>
      input.removeLabels?.some((other) => other.toLowerCase() === name.toLowerCase()),
    );
    if (overlap !== undefined) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message: `Label '${overlap}' is in both addLabels and removeLabels; pass it to only one of them.`,
      });
    }
    const addLabels =
      input.addLabels === undefined ? undefined : yield* resolveLabelIds(board, input.addLabels);
    const catalogue = boardLabelCatalogue(board);
    const unknownRemoval = input.removeLabels?.find(
      (name) => !catalogue.some((label) => sameLabelName(label, name)),
    );
    if (unknownRemoval !== undefined) {
      return yield* new BoardToolError({
        code: "unknown-label",
        message: `No label named '${unknownRemoval}' to remove. Labels: ${formatLabelNames(catalogue)}.`,
      });
    }
    const removeLabels = input.removeLabels?.flatMap((name) =>
      target.labels.filter((id) => {
        const label = catalogue.find((candidate) => candidate.labelId === id);
        return label !== undefined && sameLabelName(label, name);
      }),
    );
    // An added card must exist. A removed one resolves against the target's own dependencies,
    // so a key shared across projects finds the right edge.
    const addDependsOn =
      input.addDependsOn === undefined
        ? undefined
        : yield* Effect.forEach(input.addDependsOn, (value) =>
            findCardByKeyOrId(board, value).pipe(Effect.map((card) => card.id)),
          );
    const removeDependsOn = input.removeDependsOn?.map(
      (value) =>
        target.dependsOn.find(
          (id) =>
            id === value ||
            board.cards.find((card) => card.id === id)?.key.toLowerCase() === value.toLowerCase(),
        ) ?? BoardCardId.make(value),
    );
    // Checked before anything is written, so a bad pull request
    // rejects the whole update rather than half of it.
    const pullRequest =
      input.pullRequest === undefined || input.pullRequest === null
        ? input.pullRequest
        : yield* resolveLinkablePullRequest(target.projectId, input.pullRequest);
    // A call that only links a pull request has no card fields to update,
    // and the decider refuses an update that changes nothing.
    const updatesFields = [
      input.title,
      input.brief,
      input.briefAppend,
      input.briefSection,
      input.labels,
      input.dependsOn,
      input.addDependsOn,
      input.removeDependsOn,
      input.addLabels,
      input.removeLabels,
      input.externalRef,
      input.mergeStrategy,
      input.planReview,
      input.size,
    ].some((value) => value !== undefined);
    if (updatesFields || input.pullRequest === undefined) {
      const command: BoardCardUpdateCommand = {
        type: "board.card.update",
        commandId: yield* mintCommandId,
        cardId,
        title: input.title,
        brief: input.brief,
        briefAppend: input.briefAppend,
        briefSection: input.briefSection,
        expectedBriefVersion: input.expectedBriefVersion,
        labels,
        dependsOn: input.dependsOn,
        addDependsOn,
        removeDependsOn,
        addLabels,
        removeLabels,
        externalRef: input.externalRef,
        mergeStrategy: input.mergeStrategy,
        planReview: input.planReview,
        // T3o: an agent's size edit is the agent's, never a human override (T3O-86).
        ...(input.size === undefined ? {} : { size: input.size, sizeEditor: "agent" as const }),
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps, command);
    }
    if (pullRequest !== undefined) {
      // When the field changes have already landed, a failure here must say
      // so: a retried whole call would apply them twice (briefAppend).
      yield* linkCardPullRequest(target, pullRequest).pipe(
        Effect.mapError((error) =>
          updatesFields
            ? new BoardToolError({
                code: error.code,
                message: `The other changes to card ${target.key} were saved, but ${
                  pullRequest === null
                    ? "clearing its pull request"
                    : `linking pull request #${pullRequest.number}`
                } failed: ${error.message} Retry with pullRequest alone; do not repeat the other changes.`,
              })
            : error,
        ),
      );
    }
    return { cardId };
  }),

  board_indent_cards: Effect.fn("BoardToolkit.board_indent_cards")(function* (input) {
    const deps = yield* boardToolDeps;
    yield* requireRegroupApproval(deps, input.approved);
    const board = yield* readBoardState(deps);
    const cards = yield* resolveCardRefs(board, input.cardIds);
    for (const card of cards) yield* refuseOtherWorkersCard(board, deps.scope, card);
    const plan = boardIndentPlan(
      board,
      cards.map((card) => card.id),
    );
    if (plan.kind === "refused") return yield* regroupRefused(plan.reason);
    return yield* dispatchMoveCards(deps, plan);
  }),

  board_outdent_cards: Effect.fn("BoardToolkit.board_outdent_cards")(function* (input) {
    const deps = yield* boardToolDeps;
    yield* requireRegroupApproval(deps, input.approved);
    const board = yield* readBoardState(deps);
    const cards = yield* resolveCardRefs(board, input.cardIds);
    for (const card of cards) yield* refuseOtherWorkersCard(board, deps.scope, card);
    const plan = boardOutdentPlan(
      board,
      cards.map((card) => card.id),
    );
    if (plan.kind === "refused") return yield* regroupRefused(plan.reason);
    return yield* dispatchMoveCards(deps, plan);
  }),

  board_group_cards: Effect.fn("BoardToolkit.board_group_cards")(function* (input) {
    const deps = yield* boardToolDeps;
    yield* requireRegroupApproval(deps, input.approved);
    const board = yield* readBoardState(deps);
    const cards = yield* resolveCardRefs(board, input.cardIds);
    for (const card of cards) yield* refuseOtherWorkersCard(board, deps.scope, card);
    const plan = boardGroupIntoNewPlan(
      board,
      cards.map((card) => card.id),
    );
    if (plan.kind === "refused") return yield* regroupRefused(plan.reason);
    const first = plan.cards[0]!;
    const projects = yield* listProjects(deps);
    const projectTitle = projects.find((project) => project.id === first.projectId)?.title ?? "";
    const groupCardId = BoardCardId.make(yield* mintUuid);
    const create: BoardCardCreateCommand = {
      type: "board.card.create",
      commandId: yield* mintCommandId,
      cardId: groupCardId,
      projectId: first.projectId,
      title: input.title,
      heading: true,
      ...(plan.parent === null ? {} : { parentCardId: plan.parent.id }),
      // One decision: a refused move creates no heading.
      adoptCardIds: plan.cards.map((card) => card.id),
      keyPrefix: yield* resolveCardKeyPrefix(first.projectId, projectTitle),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, create);
    const after = yield* readBoardState(deps);
    const groupKey = after.cards.find((card) => card.id === groupCardId)?.key ?? groupCardId;
    return { groupCardId, groupKey, cardIds: create.adoptCardIds ?? [] };
  }),

  board_share_parent: Effect.fn("BoardToolkit.board_share_parent")(function* (input) {
    const deps = yield* boardToolDeps;
    yield* requireRegroupApproval(deps, input.approved);
    const board = yield* readBoardState(deps);
    const started = yield* findCardByKeyOrId(board, input.cardId);
    const cards = yield* resolveCardRefs(board, input.cardIds);
    for (const card of [started, ...cards]) {
      yield* refuseOtherWorkersCard(board, deps.scope, card);
    }
    const plan = boardSharedParentPlan(
      board,
      started.id,
      cards.map((card) => card.id),
    );
    if (plan.kind === "refused") return yield* regroupRefused(plan.reason);
    const projects = yield* listProjects(deps);
    const projectTitle =
      projects.find((project) => project.id === plan.started.projectId)?.title ?? "";
    const groupCardId = BoardCardId.make(yield* mintUuid);
    const create: BoardCardCreateCommand = {
      type: "board.card.create",
      commandId: yield* mintCommandId,
      cardId: groupCardId,
      projectId: plan.started.projectId,
      title: input.title,
      heading: true,
      ...(plan.parentCardId === null ? {} : { parentCardId: plan.parentCardId }),
      adoptCardIds: plan.cardIds,
      keyPrefix: yield* resolveCardKeyPrefix(plan.started.projectId, projectTitle),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, create);
    const after = yield* readBoardState(deps);
    const groupKey = after.cards.find((card) => card.id === groupCardId)?.key ?? groupCardId;
    return { groupCardId, groupKey, cardIds: plan.cardIds };
  }),

  board_new_phase: Effect.fn("BoardToolkit.board_new_phase")(function* (input) {
    const deps = yield* boardToolDeps;
    yield* requireRegroupApproval(deps, input.approved);
    const board = yield* readBoardState(deps);
    const group = yield* findCardByKeyOrId(board, input.groupCardId);
    const cards = yield* resolveCardRefs(board, input.cardIds);
    for (const card of [group, ...cards]) {
      yield* refuseOtherWorkersCard(board, deps.scope, card);
    }
    const plan = boardNewPhasePlan(
      board,
      group.id,
      cards.map((card) => card.id),
    );
    if (plan.kind === "refused") return yield* regroupRefused(plan.reason);
    const projects = yield* listProjects(deps);
    const projectTitle =
      projects.find((project) => project.id === plan.group.projectId)?.title ?? "";
    const groupCardId = BoardCardId.make(yield* mintUuid);
    const create: BoardCardCreateCommand = {
      type: "board.card.create",
      commandId: yield* mintCommandId,
      cardId: groupCardId,
      projectId: plan.group.projectId,
      title: input.title,
      brief: boardNewPhaseBrief(plan.group),
      heading: true,
      stage: plan.headingStage,
      ...(plan.parentCardId === null ? {} : { parentCardId: plan.parentCardId }),
      adoptCardIds: plan.cardIds,
      adoptStage: plan.cardStage,
      keyPrefix: yield* resolveCardKeyPrefix(plan.group.projectId, projectTitle),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, create);
    const after = yield* readBoardState(deps);
    const groupKey = after.cards.find((card) => card.id === groupCardId)?.key ?? groupCardId;
    return { groupCardId, groupKey, cardIds: plan.cardIds };
  }),

  board_cancel_card_work: Effect.fn("BoardToolkit.board_cancel_card_work")(function* (input) {
    const deps = yield* boardToolDeps;
    yield* requireDestructiveApproval(
      deps,
      input.approved,
      "Cancelling a card's work stops its threads, closes its pull request and deletes its branch, which",
    );
    const board = yield* readBoardState(deps);
    const card = yield* findCardByKeyOrId(board, input.cardId);
    yield* refuseOtherWorkersCard(board, deps.scope, card);
    yield* refuseOwnCard(
      board,
      deps.scope,
      card,
      "Cancelling its work stops this thread and reclaims the worktree you are running in",
    );
    const cards = yield* resolveCardRefs(board, input.cardIds ?? []);
    for (const moving of cards) yield* refuseOtherWorkersCard(board, deps.scope, moving);
    const command: BoardCardCancelWorkCommand = {
      type: "board.card.cancel-work",
      commandId: yield* mintCommandId,
      cardId: card.id,
      confirmCardKey: input.confirmCardKey,
      // One decision: a refused move cancels nothing.
      ...(cards.length === 0 ? {} : { adoptCardIds: cards.map((moving) => moving.id) }),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { cardId: card.id, key: card.key, cardIds: cards.map((moving) => moving.id) };
  }),

  board_set_group_settings: Effect.fn("BoardToolkit.board_set_group_settings")(function* (input) {
    const deps = yield* boardToolDeps;
    yield* requireRegroupApproval(deps, input.approved);
    const board = yield* readBoardState(deps);
    const card = yield* findCardByKeyOrId(board, input.cardId);
    yield* refuseOtherWorkersCard(board, deps.scope, card);
    const command: BoardCardSetGroupSettingsCommand = {
      type: "board.card.set-group-settings",
      commandId: yield* mintCommandId,
      cardId: card.id,
      ...(input.target === undefined ? {} : { target: input.target }),
      ...(input.autoBuild === undefined ? {} : { autoBuild: input.autoBuild }),
      ...(input.autoMerge === undefined ? {} : { autoMerge: input.autoMerge }),
      ...(input.autoPlan === undefined ? {} : { autoPlan: input.autoPlan }),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { cardId: card.id, key: card.key };
  }),

  board_archive_card: Effect.fn("BoardToolkit.board_archive_card")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireTargetCard(board, input.cardId);
    yield* refuseOtherWorkersCard(board, deps.scope, card);
    yield* refuseOwnCard(
      board,
      deps.scope,
      card,
      "Archiving it reclaims the worktree this turn is running in, and unarchiving does not bring it back",
    );
    if (input.confirmCardKey !== undefined) {
      yield* requireDestructiveApproval(
        deps,
        input.approved,
        "Archiving a whole group stops its threads, closes its pull requests and deletes its branches, which",
      );
      for (const descendant of boardCardLiveDescendants(board, card.id)) {
        yield* refuseOtherWorkersCard(board, deps.scope, descendant);
        yield* refuseOwnCard(
          board,
          deps.scope,
          descendant,
          `It is inside '${card.key}', and archiving the group deletes the worktree you are running in`,
        );
      }
    }
    const command: BoardCardArchiveCommand = {
      type: "board.card.archive",
      commandId: yield* mintCommandId,
      cardId: card.id,
      ...(input.confirmCardKey === undefined ? {} : { confirmCardKey: input.confirmCardKey }),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { cardId: card.id, key: card.key };
  }),

  board_unarchive_card: Effect.fn("BoardToolkit.board_unarchive_card")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireTargetCard(board, input.cardId);
    yield* refuseOtherWorkersCard(board, deps.scope, card);
    const command: BoardCardUnarchiveCommand = {
      type: "board.card.unarchive",
      commandId: yield* mintCommandId,
      cardId: card.id,
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { cardId: card.id, key: card.key };
  }),

  board_delete_card: Effect.fn("BoardToolkit.board_delete_card")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    // Resolved before the dispatch for the key: after the purge there is no
    // card left to read one off, and "deleted card-4f3a…" is not an answer a
    // human can check.
    const card = yield* requireTargetCard(board, input.cardId);
    yield* refuseOtherWorkersCard(board, deps.scope, card);
    yield* refuseOwnCard(
      board,
      deps.scope,
      card,
      "Deleting it would delete this thread and force-reclaim the worktree this turn is running in",
    );
    yield* refuseLiveWork(board, card);
    const command: BoardCardDeleteCommand = {
      type: "board.card.delete",
      commandId: yield* mintCommandId,
      cardId: card.id,
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { cardId: card.id, key: card.key };
  }),

  board_manage_labels: Effect.fn("BoardToolkit.board_manage_labels")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    // Flags are checked against the action, so a misplaced one is reported
    // rather than silently ignored (an agent passing force to create would
    // otherwise believe it did something).
    const allowed: Record<typeof input.action, ReadonlyArray<string>> = {
      list: ["includeDeleted"],
      create: ["name", "colour"],
      update: ["name", "newName", "colour"],
      delete: ["name", "force"],
      restore: ["name"],
    };
    const misplaced = (["name", "newName", "colour", "force", "includeDeleted"] as const).filter(
      (field) => input[field] !== undefined && !allowed[input.action].includes(field),
    );
    if (misplaced.length > 0) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message: `action '${input.action}' does not take ${misplaced.join(", ")}.`,
      });
    }
    if (input.action === "list") {
      const labels = boardLabelCatalogue(board).filter(
        (label) => input.includeDeleted === true || label.deletedAt === null,
      );
      return { labels: labels.map((label) => managedLabel(board, label)) };
    }
    const name = input.name;
    if (name === undefined) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message: `action '${input.action}' needs name: the label to ${input.action}.`,
      });
    }

    let command: BoardLabelCommand;
    const commandId = yield* mintCommandId;
    const createdAt = yield* nowIso;
    switch (input.action) {
      case "create": {
        command = {
          type: "board.label.create",
          commandId,
          labelId: BoardLabelId.make(yield* mintUuid),
          name,
          ...(input.colour === undefined ? {} : { colour: input.colour }),
          createdAt,
        };
        break;
      }
      case "update": {
        if (input.newName === undefined && input.colour === undefined) {
          return yield* new BoardToolError({
            code: "invalid-input",
            message: "action 'update' needs newName, colour, or both.",
          });
        }
        const label = yield* resolveManagedLabel(board, name, false);
        command = {
          type: "board.label.update",
          commandId,
          labelId: label.labelId,
          ...(input.newName === undefined ? {} : { name: input.newName }),
          ...(input.colour === undefined ? {} : { colour: input.colour }),
          createdAt,
        };
        break;
      }
      case "delete": {
        const label = yield* resolveManagedLabel(board, name, false);
        // MCP-only guard: the board UI deletes freely, but an agent tidying
        // the catalogue must not silently retire a label people are using.
        const carriers = labelCarriers(board, label.labelId);
        if (input.force !== true && carriers.length > 0) {
          const named = carriers.slice(0, LABEL_CARRIERS_NAMED_MAX).map((card) => card.key);
          const more = carriers.length - named.length;
          return yield* new BoardToolError({
            code: "rejected",
            message: `Label '${label.name}' is on ${carriers.length} non-archived card${carriers.length === 1 ? "" : "s"}: ${named.join(", ")}${more > 0 ? ` and ${more} more` : ""}. Remove it from them with board_update_card removeLabels, or pass force: true to delete it anyway (the cards keep it, shown muted).`,
          });
        }
        command = { type: "board.label.delete", commandId, labelId: label.labelId, createdAt };
        break;
      }
      case "restore": {
        const label = yield* resolveManagedLabel(board, name, true);
        command = { type: "board.label.undelete", commandId, labelId: label.labelId, createdAt };
        break;
      }
    }
    yield* dispatch(deps, command);
    // Re-read so an auto-picked colour (create) is what the agent sees.
    const after = yield* readBoardState(deps);
    const written = boardLabelCatalogue(after).find((label) => label.labelId === command.labelId);
    if (written === undefined) {
      return yield* internalError({ message: `Label '${name}' was not found after writing it.` });
    }
    return { labels: [managedLabel(after, written)] };
  }),

  board_propose_plans: Effect.fn("BoardToolkit.board_propose_plans")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireCallerCard(board, deps.scope);
    const settings = yield* readBoardSettings;
    const command: BoardPlansProposeCommand = {
      type: "board.plans.propose",
      commandId: yield* mintCommandId,
      cardId: card.id,
      plans: input.plans,
      // Optional on the tool, explicit on the command: the
      // decider is the one place that decides whether a split needs one.
      splitRationale: input.splitRationale ?? null,
      ...(input.recommendedAutoBuild === undefined
        ? {}
        : { recommendedAutoBuild: input.recommendedAutoBuild }),
      ...(input.recommendedMergeTarget === undefined
        ? {}
        : { recommendedMergeTarget: input.recommendedMergeTarget }),
      ...planReviewForCommand(board, card, settings),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    const planReview = yield* planReviewStartedBy(deps, {
      card,
      settings,
      before: board,
    });
    const sizeWarnings = yield* planSizeWarnings(board, card, input.plans);
    return {
      planIds: input.plans.map((plan) => boardPlanId(card.id, plan.key)),
      ...(planReview === null ? {} : { planReview }),
      ...(sizeWarnings.length === 0 ? {} : { sizeWarnings }),
    };
  }),

  board_get_plan: Effect.fn("BoardToolkit.board_get_plan")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireCallerCard(board, deps.scope);
    // The caller's card or a group it sits in: child planning reads
    // its ancestors' plans.
    const readable = new Set([card.id, ...boardCardAncestors(board, card).map((a) => a.id)]);
    const plan = (board.plans ?? []).find(
      (candidate) => candidate.planId === input.planId && readable.has(candidate.cardId),
    );
    if (plan === undefined) {
      return yield* new BoardToolError({
        code: "plan-not-found",
        message: `No plan '${input.planId}' on your card or the groups it sits in.`,
      });
    }
    const body = yield* deps.board.boardPlanBody(input.planId).pipe(Effect.mapError(internalError));
    return { plan, body: body ?? "" };
  }),

  board_write_plan: Effect.fn("BoardToolkit.board_write_plan")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireCallerCard(board, deps.scope);
    const plan = boardCardPlans(board, card.id).find(
      (candidate) => candidate.planId === input.planId,
    );
    if (plan === undefined) {
      return yield* new BoardToolError({
        code: "plan-not-found",
        message: `No plan '${input.planId}' on your card.`,
      });
    }
    const command: BoardPlanWriteCommand = {
      type: "board.plan.write",
      commandId: yield* mintCommandId,
      cardId: card.id,
      planId: input.planId,
      body: input.body,
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { planId: input.planId };
  }),

  board_edit_plan: Effect.fn("BoardToolkit.board_edit_plan")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireCallerCard(board, deps.scope);
    const plan = boardCardPlans(board, card.id).find(
      (candidate) => candidate.planId === input.planId,
    );
    if (plan === undefined) {
      return yield* new BoardToolError({
        code: "plan-not-found",
        message: `No plan '${input.planId}' on your card.`,
      });
    }
    // Before matching: a locked plan's stored body can lag its file, which
    // would surface as a misleading "old_text not found".
    if (plan.locked) {
      return yield* new BoardToolError({
        code: "rejected",
        message: `Plan '${input.planId}' is locked (materialised to .plans/); edit the file instead.`,
      });
    }
    const current = yield* deps.board
      .boardPlanBody(input.planId)
      .pipe(Effect.mapError(internalError));
    const edited = applyBoardPlanEdits(current ?? "", input.edits);
    if (!edited.ok) {
      return yield* new BoardToolError({ code: "invalid-input", message: edited.message });
    }
    const command: BoardPlanWriteCommand = {
      type: "board.plan.write",
      commandId: yield* mintCommandId,
      cardId: card.id,
      planId: input.planId,
      body: edited.body,
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { planId: input.planId, length: edited.body.length };
  }),

  board_record_decisions: Effect.fn("BoardToolkit.board_record_decisions")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* requireCallerCard(board, deps.scope);
    // The caller's live step names the session, when it is the caller's.
    const state = boardCardStepState(board, card.id);
    const ownStep =
      state !== null &&
      !isBoardTerminalStepStatus(state.status) &&
      state.threadId === deps.scope.thread.threadId
        ? state.stepId
        : null;
    const command: BoardCardRecordDecisionsCommand = {
      type: "board.card.record-decisions",
      commandId: yield* mintCommandId,
      cardId: card.id,
      decisions: input.decisions,
      stepId: ownStep,
      threadId: deps.scope.thread.threadId,
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    return { recorded: input.decisions.length };
  }),

  board_set_automation: Effect.fn("BoardToolkit.board_set_automation")(function* (input) {
    const deps = yield* boardToolDeps;
    const board = yield* readBoardState(deps);
    const card = yield* findCardByKeyOrId(board, input.cardId);
    const settings = yield* ServerSettings.ServerSettingsService;
    const boardWideAutoMerge = boardWideAutoMergeOn(
      board,
      (yield* settings.getSettings.pipe(Effect.mapError(internalError))).board,
    );
    // Judged on resolved values, so an inherit (null) that picks up a
    // group's "on" needs the same approval as a true.
    const turningOn =
      boardAutomationTogglesTurnedOn({ board, card, change: input, boardWideAutoMerge }).length > 0;
    if (turningOn && input.approved !== true) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message:
          "Turning an Automation toggle on stands in for a human approving and starting work, so it needs a human. Ask the user to confirm they want it for this card, and once they have, call again with approved: true.",
      });
    }
    if (turningOn) {
      yield* refuseUnattendedApproval(
        deps,
        "This run is unattended, so nobody can confirm turning automation on. Leave the card as it is and mention the suggestion in your summary for a human to apply.",
      );
      // Auto-plan steers the card's planning thread by interrupting it, and
      // an agent never authorises its own card's work.
      yield* refuseOwnCard(
        board,
        deps.scope,
        card,
        "Turning its automation on would authorise your own work and can interrupt this very turn",
      );
    }
    yield* refuseOtherWorkersCard(board, deps.scope, card);
    const command: BoardCardSetAutomationCommand = {
      type: "board.card.set-automation",
      commandId: yield* mintCommandId,
      cardId: card.id,
      ...(input.autoPlan === undefined ? {} : { autoPlan: input.autoPlan }),
      ...(input.autoBuild === undefined ? {} : { autoBuild: input.autoBuild }),
      ...(input.autoMerge === undefined ? {} : { autoMerge: input.autoMerge }),
      createdAt: yield* nowIso,
    };
    yield* dispatch(deps, command);
    const after = yield* readBoardState(deps);
    const updated = after.cards.find((candidate) => candidate.id === card.id) ?? card;
    const resolved = resolveBoardCardAutomationIn({
      board: after,
      card: updated,
      boardWideAutoMerge,
    });
    const view = (toggle: (typeof resolved)["autoPlan"]) => ({
      value: toggle.value,
      source: toggle.source,
      locked: toggle.locked,
      lockReason: toggle.lockReason,
    });
    return {
      cardId: card.id,
      key: card.key,
      autoPlan: view(resolved.autoPlan),
      autoBuild: view(resolved.autoBuild),
      autoMerge: view(resolved.autoMerge),
    };
  }),
} satisfies Parameters<typeof BoardToolkit.toLayer>[0];

/**
 * Every board tool needs a T3 thread caller; writes also need that thread's run to be live.
 * Whether the thread is linked to a card is the handler's question. A thread a central board
 * placed here relays its call to that board (`relayable`) after the access check.
 */
export const BoardToolkitHandlersLive = McpToolAccess.toLayer(BoardToolkit, {
  board_get_card_context: McpToolAccess.readsAsCaller(
    relayable("board_get_card_context", boardHandlers.board_get_card_context),
  ),
  board_get_card: McpToolAccess.readsAsCaller(
    relayable("board_get_card", boardHandlers.board_get_card),
  ),
  board_list_projects: McpToolAccess.readsAsCaller(
    relayable("board_list_projects", boardHandlers.board_list_projects),
  ),
  board_list_cards: McpToolAccess.readsAsCaller(
    relayable("board_list_cards", boardHandlers.board_list_cards),
  ),
  board_get_plan: McpToolAccess.readsAsCaller(
    relayable("board_get_plan", boardHandlers.board_get_plan),
  ),
  board_complete_step: McpToolAccess.writesWithCapability(
    relayable("board_complete_step", boardHandlers.board_complete_step),
  ),
  board_create_card: McpToolAccess.writesWithCapability(
    relayable("board_create_card", boardHandlers.board_create_card),
  ),
  board_move_card: McpToolAccess.writesWithCapability(
    relayable("board_move_card", boardHandlers.board_move_card),
  ),
  board_update_card: McpToolAccess.writesWithCapability(
    relayable("board_update_card", boardHandlers.board_update_card),
  ),
  board_archive_card: McpToolAccess.writesWithCapability(
    relayable("board_archive_card", boardHandlers.board_archive_card),
  ),
  board_unarchive_card: McpToolAccess.writesWithCapability(
    relayable("board_unarchive_card", boardHandlers.board_unarchive_card),
  ),
  board_delete_card: McpToolAccess.writesWithCapability(
    relayable("board_delete_card", boardHandlers.board_delete_card),
  ),
  board_indent_cards: McpToolAccess.writesWithCapability(
    relayable("board_indent_cards", boardHandlers.board_indent_cards),
  ),
  board_outdent_cards: McpToolAccess.writesWithCapability(
    relayable("board_outdent_cards", boardHandlers.board_outdent_cards),
  ),
  board_group_cards: McpToolAccess.writesWithCapability(
    relayable("board_group_cards", boardHandlers.board_group_cards),
  ),
  board_share_parent: McpToolAccess.writesWithCapability(
    relayable("board_share_parent", boardHandlers.board_share_parent),
  ),
  board_new_phase: McpToolAccess.writesWithCapability(
    relayable("board_new_phase", boardHandlers.board_new_phase),
  ),
  board_cancel_card_work: McpToolAccess.writesWithCapability(
    relayable("board_cancel_card_work", boardHandlers.board_cancel_card_work),
  ),
  board_set_group_settings: McpToolAccess.writesWithCapability(
    relayable("board_set_group_settings", boardHandlers.board_set_group_settings),
  ),
  board_manage_labels: McpToolAccess.writesWithCapability(
    relayable("board_manage_labels", boardHandlers.board_manage_labels),
  ),
  board_propose_plans: McpToolAccess.writesWithCapability(
    relayable("board_propose_plans", boardHandlers.board_propose_plans),
  ),
  board_write_plan: McpToolAccess.writesWithCapability(
    relayable("board_write_plan", boardHandlers.board_write_plan),
  ),
  board_edit_plan: McpToolAccess.writesWithCapability(
    relayable("board_edit_plan", boardHandlers.board_edit_plan),
  ),
  board_record_decisions: McpToolAccess.writesWithCapability(
    relayable("board_record_decisions", boardHandlers.board_record_decisions),
  ),
  board_set_automation: McpToolAccess.writesWithCapability(
    relayable("board_set_automation", boardHandlers.board_set_automation),
  ),
});

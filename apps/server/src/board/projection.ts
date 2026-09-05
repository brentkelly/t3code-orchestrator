/**
 * T3o board persisted projection and snapshot enrichment.
 *
 * `makeBoardProjectors` returns the `board_cards` projector definition that
 * the upstream ProjectionPipeline spreads into its projector list — same
 * transaction, same cursor bookkeeping as the stock projectors. It owns all
 * three board tables (`board_cards`, `board_card_bodies`,
 * `board_card_thread_links`) so a card and its side rows always commit
 * together. `BOARD_PROJECTOR_NAMES` is spread into the pipeline's name
 * registry the same way; new board projectors register in both, never at the
 * seam.
 *
 * `boardSnapshotQueryMethods` wraps the upstream snapshot queries at their
 * assembly point (spread after the base methods so the board-wrapped
 * versions override), so every consumer (engine bootstrap, subscribeShell,
 * HTTP snapshot) sees board state without further seams. The card read runs
 * just after the wrapped query's transaction; a card committed in that
 * window also arrives as a live `card-upserted` delta with a higher
 * sequence, and the client upsert is idempotent, so nothing is lost.
 */
import {
  BoardCardStepAwaitingReason,
  activeBoardCardThreadId,
  BOARD_CARD_BRIEF_BODY_KIND,
  BoardCard,
  BoardActivityActor,
  BoardActivityId,
  BoardCardActivityEntry,
  BoardCardActivityPayload,
  BoardCardExternalRef,
  BoardCardId,
  BoardCardThreadLink,
  BoardCardThreadShell,
  boardThreadTodoSummary,
  boardRunLabel,
  BoardLabel,
  BoardLabelId,
  boardLabelsAreSeedOnly,
  BoardPlan,
  BoardPlanId,
  BoardStageDefinition,
  BoardStageId,
  BoardStageRole,
  boardStagesAreSeedOnly,
  BoardStepCompletion,
  BoardCardStepState,
  BoardStageMode,
  compareBoardLabels,
  compareBoardStages,
  BoardCardWorktree,
  BoardCardPullRequest,
  BoardCardModelOverrides,
  BoardCardReviewOverrides,
  BoardCardReviewSummary,
  deriveBoardCardReviewSummary,
  parseReviewStepId,
  isBoardEvent,
  isEmptyBoardCardModelOverrides,
  isBoardTerminalStepStatus,
  makeBoardCardShell,
  ProviderInstanceId,
  BoardCardAttachment,
  sortBoardCardAttachments,
  sortBoardCardThreadLinks,
  type BoardCardDetail,
  type BoardPlanWithBody,
  type BoardState,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  IsoDateTime,
  ProjectId,
  ThreadId,
  RuntimeMode,
  type ProviderOptionSelections,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";
import { boardActivityActorFor } from "./activityActors.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  boardCardFromCreatedPayload,
  compareBoardCards,
  compareBoardPlans,
  compareBoardStepCompletions,
  compareBoardStepStates,
} from "./projector.ts";

/**
 * The plan steps carried by a `turn.plan.updated` thread activity, or null when
 * the payload is not a plan. The activity payload is `Schema.Unknown` upstream
 * (deliberately — activities are provider-shaped), so it is read leniently here
 * exactly as the in-chat plan chip reads it: an entry without a string `step` is
 * skipped, and any unrecognised status is `pending`. A malformed payload must
 * never fail a projection transaction.
 */
function readTurnPlanSteps(
  payload: unknown,
): ReadonlyArray<{ readonly step: string; readonly status: string }> | null {
  const record =
    payload !== null && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  const rawPlan = record?.plan;
  if (!Array.isArray(rawPlan)) return null;
  const steps: Array<{ readonly step: string; readonly status: string }> = [];
  for (const entry of rawPlan) {
    if (entry === null || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.step !== "string" || item.step.trim().length === 0) continue;
    steps.push({
      step: item.step,
      status: typeof item.status === "string" ? item.status : "pending",
    });
  }
  return steps;
}

export const BOARD_CARDS_PROJECTOR_NAME = "projection.board-cards" as const;

/** How many trailing activity entries a context read returns (t3o-08 hygiene);
    outstanding `input-requested` entries are always included on top. */
export const BOARD_CARD_ACTIVITY_TAIL_LIMIT = 50;

/**
 * Spread into upstream's `ORCHESTRATION_PROJECTOR_NAMES`. Keeping board
 * projectors inside that record (rather than only widening the name type)
 * keeps `Object.keys(ORCHESTRATION_PROJECTOR_NAMES)` equal to the set of
 * projection_state rows the pipeline writes, which upstream tests assert on.
 */
export const BOARD_PROJECTOR_NAMES = {
  boardCards: BOARD_CARDS_PROJECTOR_NAME,
} as const;

// `blocked` travels as 0/1 (SQLite has no boolean); the JSON-shaped columns
// encode/decode through fromJsonString so the row schema's Type side stays
// the domain shape.
const BoardCardDbRow = Schema.Struct({
  cardId: BoardCard.fields.id,
  key: BoardCard.fields.key,
  cardNumber: BoardCard.fields.cardNumber,
  projectId: BoardCard.fields.projectId,
  stage: BoardCard.fields.stage,
  orderKey: BoardCard.fields.orderKey,
  title: BoardCard.fields.title,
  briefRef: BoardCard.fields.briefRef,
  dependsOn: Schema.fromJsonString(Schema.Array(BoardCardId)),
  parentCardId: BoardCard.fields.parentCardId,
  /** NULL for every row written before migration 027 and for every top-level
      card — indistinguishable on purpose (replay equals rehydration). */
  sourcePlanId: Schema.NullOr(BoardPlanId),
  externalRef: Schema.NullOr(Schema.fromJsonString(BoardCardExternalRef)),
  // Per-card human-in-the-loop override (D6): 0/1/NULL (SQLite has no boolean;
  // NULL means untouched).
  humanInLoop: Schema.NullOr(Schema.Int),
  worktree: Schema.NullOr(Schema.fromJsonString(BoardCardWorktree)),
  pullRequest: Schema.NullOr(Schema.fromJsonString(BoardCardPullRequest)),
  /** NULL for every row written before migration 024, which is why the read
      side below turns a null history into the empty array rather than letting
      it through — `BoardCard.pullRequestHistory` has no null inhabitant. */
  pullRequestHistory: Schema.NullOr(Schema.fromJsonString(Schema.Array(BoardCardPullRequest))),
  pullRequestFloor: BoardCard.fields.pullRequestFloor,
  /** NULL for every row written before migration 025, and for every card that
      has never touched its review-loop settings — the two are deliberately
      indistinguishable, which is what makes replay equal rehydration (t3o-22,
      D2). */
  reviewOverrides: Schema.NullOr(Schema.fromJsonString(BoardCardReviewOverrides)),
  /** NULL for every row written before migration 029, and for every card that
      has never set a per-stage model override — indistinguishable on purpose,
      exactly as `reviewOverrides` is, so replay equals rehydration (t3o-29). */
  modelOverrides: Schema.NullOr(Schema.fromJsonString(BoardCardModelOverrides)),
  blocked: Schema.Int,
  archivedAt: BoardCard.fields.archivedAt,
  createdAt: BoardCard.fields.createdAt,
  updatedAt: BoardCard.fields.updatedAt,
});
type BoardCardDbRow = typeof BoardCardDbRow.Type;

const BoardCardThreadLinkDbRow = Schema.Struct({
  threadId: BoardCardThreadLink.fields.threadId,
  cardId: BoardCardId,
  role: BoardCardThreadLink.fields.role,
  linkedAt: BoardCardThreadLink.fields.linkedAt,
  tombstonedAt: BoardCardThreadLink.fields.tombstonedAt,
});
type BoardCardThreadLinkDbRow = typeof BoardCardThreadLinkDbRow.Type;

// Brief attachment row (032_BoardCardAttachments, t3o-32): the mirror of
// `BoardCard.attachments`, rewritten wholesale like the thread links.
const BoardCardAttachmentDbRow = Schema.Struct({
  attachmentId: BoardCardAttachment.fields.id,
  cardId: BoardCardId,
  name: BoardCardAttachment.fields.name,
  type: BoardCardAttachment.fields.type,
  mimeType: BoardCardAttachment.fields.mimeType,
  sizeBytes: BoardCardAttachment.fields.sizeBytes,
  addedAt: BoardCardAttachment.fields.addedAt,
});
type BoardCardAttachmentDbRow = typeof BoardCardAttachmentDbRow.Type;

// Label catalogue row (904_BoardLabels). `deletedAt` NULL means live.
const BoardLabelDbRow = Schema.Struct({
  labelId: BoardLabel.fields.labelId,
  name: BoardLabel.fields.name,
  colour: BoardLabel.fields.colour,
  deletedAt: BoardLabel.fields.deletedAt,
  createdAt: BoardLabel.fields.createdAt,
  updatedAt: BoardLabel.fields.updatedAt,
});
type BoardLabelDbRow = typeof BoardLabelDbRow.Type;

// Stage definitions (014_BoardStages). `role` is 'build' | 'review' | 'done' |
// NULL (an ordinary stage). One row per stage; rehydrates `BoardState.stages`.
const BoardStageDbRow = Schema.Struct({
  stageId: BoardStageDefinition.fields.stageId,
  label: BoardStageDefinition.fields.label,
  role: BoardStageDefinition.fields.role,
  orderKey: BoardStageDefinition.fields.orderKey,
  createdAt: BoardStageDefinition.fields.createdAt,
  updatedAt: BoardStageDefinition.fields.updatedAt,
});
type BoardStageDbRow = typeof BoardStageDbRow.Type;

// Card↔label join row (905_BoardCardLabels). `ordinal` preserves the card's
// label order so rehydration reproduces the array the decider computed.
const BoardCardLabelDbRow = Schema.Struct({
  cardId: BoardCardId,
  labelId: BoardLabelId,
  ordinal: Schema.Int,
});
type BoardCardLabelDbRow = typeof BoardCardLabelDbRow.Type;

const NextCardNumberDbRow = Schema.Struct({
  projectId: ProjectId,
  maxCardNumber: Schema.Int,
});

// Agent write-path rows (t3o-08). Activity is table-only (D8); step and plan
// rows rehydrate the read-model slices `BoardState.stepCompletions` / `plans`.
// Activity rows are structured (t3o-18, D10): kind + typed payload + actor. The
// payload rides as a JSON string, the same "carried verbatim" discipline
// `BoardStepCompletion.payload` uses, so a round-trip cannot re-serialise into a
// different string. `actor_kind` is NOT NULL — an unstamped command resolves to
// the system actor at write time, never to a null column.
const BoardCardActivityDbRow = Schema.Struct({
  activityId: BoardCardActivityEntry.fields.activityId,
  cardId: BoardCardId,
  kind: BoardCardActivityEntry.fields.kind,
  payload: Schema.fromJsonString(BoardCardActivityPayload),
  actorKind: BoardActivityActor.fields.kind,
  actorName: BoardActivityActor.fields.name,
  actorProviderInstanceId: BoardActivityActor.fields.providerInstanceId,
  actorThreadId: BoardActivityActor.fields.threadId,
  threadId: BoardCardActivityEntry.fields.threadId,
  createdAt: BoardCardActivityEntry.fields.createdAt,
});
type BoardCardActivityDbRow = typeof BoardCardActivityDbRow.Type;

/** The board's cached copy of one thread's todo list (t3o-18, D1). `statuses`
    is one char per stored item; `done_count` / `total_count` are the TRUE
    counts, before capping, so `2/47` stays honest with 30 pips stored. */
const BoardThreadTodoDbRow = Schema.Struct({
  threadId: ThreadId,
  cardId: BoardCardId,
  statuses: Schema.String,
  currentText: Schema.NullOr(Schema.String),
  doneCount: Schema.Int,
  totalCount: Schema.Int,
  currentStartedAt: Schema.NullOr(IsoDateTime),
  /** When the list last ADVANCED (t3o-18, D16): `done_count` rose or the
      in-progress item changed. The stall-reset signal reads this, so
      `recoveryDecision` stays pure with no git and no SQL. */
  advancedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
type BoardThreadTodoDbRow = typeof BoardThreadTodoDbRow.Type;

/** The shell-snapshot row: one live link on a non-archived card, LEFT JOINed to
    its todo cache, so a linked thread with no list still rides (D3). */
const BoardCardThreadShellDbRow = Schema.Struct({
  cardId: BoardCardId,
  threadId: ThreadId,
  statuses: Schema.NullOr(Schema.String),
  currentText: Schema.NullOr(Schema.String),
  doneCount: Schema.NullOr(Schema.Int),
  totalCount: Schema.NullOr(Schema.Int),
  currentStartedAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
});
type BoardCardThreadShellDbRow = typeof BoardCardThreadShellDbRow.Type;

/** Map an activity row to the wire entry (t3o-18, D10). The actor's four
    columns rebuild the discriminated actor; `payload` decoded from its JSON
    string by the row schema. */
function toBoardCardActivityEntry(row: BoardCardActivityDbRow): BoardCardActivityEntry {
  return {
    activityId: row.activityId,
    cardId: row.cardId,
    kind: row.kind,
    payload: row.payload,
    actor: {
      kind: row.actorKind,
      name: row.actorName,
      providerInstanceId: row.actorProviderInstanceId,
      threadId: row.actorThreadId,
    },
    threadId: row.threadId,
    createdAt: row.createdAt,
  };
}

/** Map a joined row to the wire shell (t3o-18, D3): the todo fields are
    key-optional, so a thread with no list serialises as a bare link entry. */
function toBoardCardThreadShell(row: BoardCardThreadShellDbRow): BoardCardThreadShell {
  const hasTodos = row.statuses !== null && row.statuses.length > 0;
  return {
    cardId: row.cardId,
    threadId: row.threadId,
    ...(hasTodos ? { todoStatuses: row.statuses as string } : {}),
    ...(row.currentText !== null && row.currentText.length > 0
      ? { todoCurrent: row.currentText }
      : {}),
    ...(hasTodos ? { todoDone: Math.max(0, row.doneCount ?? 0) } : {}),
    ...(hasTodos ? { todoTotal: Math.max(0, row.totalCount ?? 0) } : {}),
    ...(row.currentStartedAt !== null ? { todoStartedAt: row.currentStartedAt } : {}),
    ...(row.updatedAt !== null ? { todoUpdatedAt: row.updatedAt } : {}),
  };
}

const BoardCardStepDbRow = Schema.Struct({
  cardId: BoardCardId,
  stepId: BoardStepCompletion.fields.stepId,
  outcome: BoardStepCompletion.fields.outcome,
  summary: BoardStepCompletion.fields.summary,
  payload: BoardStepCompletion.fields.payload,
  threadId: BoardStepCompletion.fields.threadId,
  completedAt: BoardStepCompletion.fields.completedAt,
});
type BoardCardStepDbRow = typeof BoardCardStepDbRow.Type;

/** The rail's name for a step-scoped activity row. `stepLabel` is `optionalKey`
    on the payload, so an unnameable run omits the key rather than setting it to
    undefined. */
const boardActivityStepLabel = (
  state: Pick<BoardCardStepState, "stepLabel" | "stageLabel">,
): { readonly stepLabel?: string } => {
  const label = boardRunLabel(state);
  return label === null ? {} : { stepLabel: label };
};

// Live per-card step state (t3o-10). One row per card. `slotHeld` travels as
// 0/1 (SQLite has no boolean), like `locked` below. Rehydrates the read-model
// slice `BoardState.stepStates`.
/** Decode a stored `model_options` JSON string back to the partial object the
    step-state map spreads (t3o-21). Carried verbatim like the completion
    payload: we wrote it with `JSON.stringify` of a valid selection, so a
    successful parse of an array is trusted; anything else yields no options
    rather than a decode failure that would break rehydration. */
/** Resolve the authority posture for a rehydrated step-state row (t3o-21). A
    non-null column is honoured verbatim. A NULL column is a row persisted before
    migration 021: it resolves to the PRE-t3o-21 behaviour — `full-access` for a
    build-mode run, `approval-required` otherwise — so a card mid-stage at deploy
    keeps the authority it was actually running under. This is deliberately NOT
    `effectiveBoardRuntimeMode` (whose unset build default is the safer `auto`):
    that governs a NEW resolution, this preserves an IN-FLIGHT one. */
export function resolveStoredStepRuntimeMode(
  stored: RuntimeMode | null,
  mode: BoardStageMode,
): RuntimeMode {
  return stored ?? (mode === "build" ? "full-access" : "approval-required");
}

function stepModelOptionsPatch(raw: string | null): { modelOptions?: ProviderOptionSelections } {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? { modelOptions: parsed as ProviderOptionSelections } : {};
  } catch {
    return {};
  }
}

const BoardCardStepStateDbRow = Schema.Struct({
  cardId: BoardCardStepState.fields.cardId,
  stepId: BoardCardStepState.fields.stepId,
  stepLabel: BoardCardStepState.fields.stepLabel,
  stageLabel: BoardCardStepState.fields.stageLabel,
  attempt: BoardCardStepState.fields.attempt,
  // Stall detection counters (t3o-17, D1/D2).
  stallCount: BoardCardStepState.fields.stallCount,
  lastNudgeAt: BoardCardStepState.fields.lastNudgeAt,
  // Frozen execution config (D12).
  prompt: BoardCardStepState.fields.prompt,
  providerInstanceId: BoardCardStepState.fields.providerInstanceId,
  model: BoardCardStepState.fields.model,
  mode: BoardCardStepState.fields.mode,
  // NULLABLE in the DB: rows written before migration 021 have no value. The
  // projection resolves a null to the pre-t3o-21 behaviour (t3o-21).
  runtimeMode: Schema.NullOr(RuntimeMode),
  // JSON-encoded ProviderOptionSelections, or null. Carried verbatim like the
  // completion `payload` (t3o-21).
  modelOptions: Schema.NullOr(Schema.String),
  // NULLABLE in the DB: rows written before migration 028 have no value, and a
  // null already MEANS "no tip recorded" (t3o-24, D1), so no resolution shim.
  baseTipAtRoundStart: BoardCardStepState.fields.baseTipAtRoundStart,
  // NULLABLE in the DB: rows written before migration 030 have no value, and a
  // null already MEANS "stopped for no recorded reason" (t3o-30, D2).
  lastError: BoardCardStepState.fields.lastError,
  // NULLABLE in the DB: rows written before migration 033 have no value, and
  // every step that reached `awaiting-input` before t3o-34 did so through the
  // structured-question path — which is `question` (t3o-34, D3).
  awaitingReason: Schema.NullOr(BoardCardStepAwaitingReason),
  humanInLoop: Schema.Int,
  maxAttempts: BoardCardStepState.fields.maxAttempts,
  timeoutMs: BoardCardStepState.fields.timeoutMs,
  threadId: BoardCardStepState.fields.threadId,
  status: BoardCardStepState.fields.status,
  slotHeld: Schema.Int,
  // 0/1 like `slotHeld`. Rows written before migration 033 read 0 through the
  // column default, which already means "no override asked for" (t3o-33).
  forceStart: Schema.Int,
  startedAt: BoardCardStepState.fields.startedAt,
  updatedAt: BoardCardStepState.fields.updatedAt,
});
type BoardCardStepStateDbRow = typeof BoardCardStepStateDbRow.Type;

// `dependsOn` JSON-encodes; `locked` travels as 0/1 (SQLite has no boolean).
const BoardPlanDbRow = Schema.Struct({
  planId: BoardPlan.fields.planId,
  cardId: BoardCardId,
  title: BoardPlan.fields.title,
  summary: BoardPlan.fields.summary,
  dependsOn: Schema.fromJsonString(Schema.Array(BoardPlanId)),
  ordinal: Schema.Int,
  locked: Schema.Int,
  body: Schema.String,
  createdAt: BoardPlan.fields.createdAt,
  updatedAt: BoardPlan.fields.updatedAt,
});
type BoardPlanDbRow = typeof BoardPlanDbRow.Type;

// Row → plan mapping, spelled once: the read-model builder wants the metadata,
// the detail loader wants it plus the markdown body. Coercing `locked` (0/1)
// and adding a field lands in exactly one place.
function rowToBoardPlan(row: BoardPlanDbRow): BoardPlan {
  return {
    planId: row.planId,
    cardId: row.cardId,
    title: row.title,
    summary: row.summary,
    dependsOn: row.dependsOn,
    ordinal: row.ordinal,
    locked: row.locked !== 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToBoardPlanWithBody(row: BoardPlanDbRow): BoardPlanWithBody {
  return { ...rowToBoardPlan(row), body: row.body };
}

/**
 * The narrow row behind `BoardCardShell` (t3o-04): exactly the columns the
 * shell needs, computed in SQL — never `SELECT *` mapped down. `dependsOn`,
 * `externalRef`, `recipeSnapshot` and the other heavy columns are not read
 * at all; the point of the shell split is to stop moving those bytes, not
 * to move them and discard them. `createdAt` is fetched for canonical
 * ordering only and never enters the shell.
 */
const BoardCardShellDbRow = Schema.Struct({
  cardId: BoardCard.fields.id,
  key: BoardCard.fields.key,
  projectId: BoardCard.fields.projectId,
  stage: BoardCard.fields.stage,
  orderKey: BoardCard.fields.orderKey,
  title: BoardCard.fields.title,
  blocked: Schema.Int,
  dependencyCount: Schema.Int,
  hasBrief: Schema.Int,
  /** `boardBriefHasImage` spelled in SQL — see `BOARD_BRIEF_IMAGE_SQL`. */
  briefHasImage: Schema.Int,
  /** The card's `board_plans` rows, counted in SQL so a thousand-card shell
      never loads a plan body. */
  planCount: Schema.Int,
  /** `board_card_attachments` rows, counted in SQL (t3o-32) — the shell's
      `attachmentCount`; the delta path derives it from `card.attachments`. */
  attachmentCount: Schema.Int,
  /** The card's PR number, read straight out of the `pull_request` JSON. Only
      the NUMBER, not the whole struct: it is all the shell carries, and
      pulling the URL and state onto every card would spend wire bytes the
      column view has nothing to do with. */
  prNumber: Schema.NullOr(Schema.Int),
  /** The card's sub-board parent (t3o-23), NULL for a top-level card. Like
      `prNumber` this is a plain column on the aggregate, and like it the SQL
      snapshot is its SECOND producer — the delta path derives it in JS. Both
      must carry it or a reload flattens every sub-board onto the root board. */
  parentCardId: BoardCard.fields.parentCardId,
  /** The review-summary CACHE (t3o-22, D7); NULL for a card with no review
      history. Its `outcome` is provisional — `resolveBoardCardReviewOutcome`
      settles it against the card's live step at assembly. */
  reviewSummary: Schema.NullOr(Schema.fromJsonString(BoardCardReviewSummary)),
  archivedAt: BoardCard.fields.archivedAt,
  createdAt: BoardCard.fields.createdAt,
});

/** The four columns a resolved dependency edge shows (t3o-13, D4) — enough
    to render a chip or name a card in the archive confirmation, and nothing
    more. */
const BoardCardDependencyRefDbRow = Schema.Struct({
  cardId: BoardCard.fields.id,
  key: BoardCard.fields.key,
  title: BoardCard.fields.title,
  stage: BoardCard.fields.stage,
  archivedAt: BoardCard.fields.archivedAt,
});

/** The dependency-ref shape plus the plan a child was cut from (t3o-23). */
const BoardCardChildRefDbRow = Schema.Struct({
  ...BoardCardDependencyRefDbRow.fields,
  sourcePlanId: Schema.NullOr(BoardPlanId),
});

function boardCardToRow(card: BoardCard): BoardCardDbRow {
  return {
    cardId: card.id,
    key: card.key,
    cardNumber: card.cardNumber,
    projectId: card.projectId,
    stage: card.stage,
    orderKey: card.orderKey,
    title: card.title,
    briefRef: card.briefRef,
    dependsOn: card.dependsOn,
    parentCardId: card.parentCardId,
    sourcePlanId: card.sourcePlanId,
    externalRef: card.externalRef,
    humanInLoop: card.humanInLoop === null ? null : card.humanInLoop ? 1 : 0,
    worktree: card.worktree,
    pullRequest: card.pullRequest,
    // An empty history is stored as NULL, not `[]`: it keeps a pre-024 row and
    // a card that has simply never finished a round indistinguishable, so
    // rehydration cannot depend on which of the two it is looking at.
    pullRequestHistory: card.pullRequestHistory.length === 0 ? null : card.pullRequestHistory,
    pullRequestFloor: card.pullRequestFloor,
    reviewOverrides: card.reviewOverrides,
    // An empty map is stored as NULL, never `{}`: a card that set an override
    // and then cleared it must be indistinguishable from one that never had
    // one, or rehydration would depend on which of the two it is looking at.
    modelOverrides: isEmptyBoardCardModelOverrides(card.modelOverrides)
      ? null
      : card.modelOverrides,
    blocked: card.blocked ? 1 : 0,
    archivedAt: card.archivedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function rowToBoardCardAttachment(row: BoardCardAttachmentDbRow): BoardCardAttachment {
  return {
    id: row.attachmentId,
    name: row.name,
    type: row.type,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    addedAt: row.addedAt,
  };
}

function rowToBoardCard(
  row: BoardCardDbRow,
  threadLinks: ReadonlyArray<BoardCardThreadLink>,
  labels: ReadonlyArray<BoardLabelId>,
  attachments: ReadonlyArray<BoardCardAttachment>,
): BoardCard {
  return {
    id: row.cardId,
    key: row.key,
    cardNumber: row.cardNumber,
    projectId: row.projectId,
    labels,
    stage: row.stage,
    orderKey: row.orderKey,
    title: row.title,
    briefRef: row.briefRef,
    dependsOn: row.dependsOn,
    parentCardId: row.parentCardId,
    sourcePlanId: row.sourcePlanId,
    externalRef: row.externalRef,
    humanInLoop: row.humanInLoop === null ? null : row.humanInLoop !== 0,
    worktree: row.worktree,
    pullRequest: row.pullRequest,
    pullRequestHistory: row.pullRequestHistory ?? [],
    pullRequestFloor: row.pullRequestFloor,
    reviewOverrides: row.reviewOverrides,
    modelOverrides: row.modelOverrides,
    blocked: row.blocked !== 0,
    threadLinks,
    attachments,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Card ids in `ordinal` order from raw join rows, grouped per card — the
    shared shape both the shell path and rehydration read the join into. */
function groupCardLabels(
  rows: ReadonlyArray<BoardCardLabelDbRow>,
): Map<BoardCardId, BoardLabelId[]> {
  const byCard = new Map<
    BoardCardId,
    Array<{ readonly labelId: BoardLabelId; readonly ordinal: number }>
  >();
  for (const row of rows) {
    const list = byCard.get(row.cardId) ?? [];
    list.push({ labelId: row.labelId, ordinal: row.ordinal });
    byCard.set(row.cardId, list);
  }
  const ordered = new Map<BoardCardId, BoardLabelId[]>();
  for (const [cardId, list] of byCard) {
    ordered.set(
      cardId,
      [...list].sort((left, right) => left.ordinal - right.ordinal).map((entry) => entry.labelId),
    );
  }
  return ordered;
}

function makeBoardCardQueries(sql: SqlClient.SqlClient) {
  const upsertBoardCardRow = SqlSchema.void({
    Request: BoardCardDbRow,
    execute: (row) => sql`
      INSERT INTO board_cards (
        card_id,
        key,
        card_number,
        project_id,
        stage,
        order_key,
        title,
        brief_ref,
        depends_on,
        parent_card_id,
        source_plan_id,
        external_ref,
        human_in_loop,
        worktree,
        pull_request,
        pull_request_history,
        pull_request_floor,
        review_overrides,
        model_overrides,
        blocked,
        archived_at,
        created_at,
        updated_at
      )
      VALUES (
        ${row.cardId},
        ${row.key},
        ${row.cardNumber},
        ${row.projectId},
        ${row.stage},
        ${row.orderKey},
        ${row.title},
        ${row.briefRef},
        ${row.dependsOn},
        ${row.parentCardId},
        ${row.sourcePlanId},
        ${row.externalRef},
        ${row.humanInLoop},
        ${row.worktree},
        ${row.pullRequest},
        ${row.pullRequestHistory},
        ${row.pullRequestFloor},
        ${row.reviewOverrides},
        ${row.modelOverrides},
        ${row.blocked},
        ${row.archivedAt},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (card_id)
      DO UPDATE SET
        key = excluded.key,
        card_number = excluded.card_number,
        project_id = excluded.project_id,
        stage = excluded.stage,
        order_key = excluded.order_key,
        title = excluded.title,
        brief_ref = excluded.brief_ref,
        depends_on = excluded.depends_on,
        parent_card_id = excluded.parent_card_id,
        source_plan_id = excluded.source_plan_id,
        external_ref = excluded.external_ref,
        human_in_loop = excluded.human_in_loop,
        worktree = excluded.worktree,
        pull_request = excluded.pull_request,
        pull_request_history = excluded.pull_request_history,
        pull_request_floor = excluded.pull_request_floor,
        review_overrides = excluded.review_overrides,
        model_overrides = excluded.model_overrides,
        blocked = excluded.blocked,
        archived_at = excluded.archived_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  // Read order is advisory only: `loadBoardState` re-sorts with the same
  // JS comparators the replay path uses (`compareBoardCards`,
  // `sortBoardCardThreadLinks`), so SQL collation can never make
  // rehydration order diverge from replay order.
  const listBoardCardRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        key,
        card_number AS "cardNumber",
        project_id AS "projectId",
        stage,
        order_key AS "orderKey",
        title,
        brief_ref AS "briefRef",
        depends_on AS "dependsOn",
        parent_card_id AS "parentCardId",
        source_plan_id AS "sourcePlanId",
        external_ref AS "externalRef",
        human_in_loop AS "humanInLoop",
        worktree,
        pull_request AS "pullRequest",
        pull_request_history AS "pullRequestHistory",
        pull_request_floor AS "pullRequestFloor",
        review_overrides AS "reviewOverrides",
        model_overrides AS "modelOverrides",
        blocked,
        archived_at AS "archivedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_cards
      ORDER BY created_at ASC, card_id ASC
    `,
  });

  const listBoardCardThreadLinkRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardThreadLinkDbRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        card_id AS "cardId",
        role,
        linked_at AS "linkedAt",
        tombstoned_at AS "tombstonedAt"
      FROM board_card_thread_links
      ORDER BY linked_at ASC, thread_id ASC
    `,
  });

  // Live links only, for the shell path: tombstoned links and links whose
  // card is archived can never contribute an activeThreadId, so they should
  // never leave the table — the reconnect read must scale with the current
  // board, not with link history.
  const listLiveBoardCardThreadLinkRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardThreadLinkDbRow,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        card_id AS "cardId",
        role,
        linked_at AS "linkedAt",
        tombstoned_at AS "tombstonedAt"
      FROM board_card_thread_links
      WHERE tombstoned_at IS NULL
        AND card_id IN (SELECT card_id FROM board_cards WHERE archived_at IS NULL)
    `,
  });

  // Shell rows exclude archived cards at the source (D15): they never reach
  // the wire, so they should never leave the table either.
  const listBoardCardShellRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardShellDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        key,
        project_id AS "projectId",
        stage,
        order_key AS "orderKey",
        title,
        blocked,
        json_array_length(depends_on) AS "dependencyCount",
        CASE WHEN brief_ref IS NULL THEN 0 ELSE 1 END AS "hasBrief",
        CASE
          WHEN EXISTS (
            SELECT 1 FROM board_card_bodies
            WHERE board_card_bodies.card_id = board_cards.card_id
              AND board_card_bodies.kind = ${BOARD_CARD_BRIEF_BODY_KIND}
              AND (board_card_bodies.body LIKE '%<img%' OR board_card_bodies.body LIKE '%![%](%')
          ) THEN 1 ELSE 0
        END AS "briefHasImage",
        (SELECT COUNT(*) FROM board_plans WHERE board_plans.card_id = board_cards.card_id)
          AS "planCount",
        (SELECT COUNT(*) FROM board_card_attachments
          WHERE board_card_attachments.card_id = board_cards.card_id)
          AS "attachmentCount",
        -- The SECOND producer of prNumber. The delta path derives it in JS
        -- from the card aggregate; this derives it in SQL from the same
        -- column, and the two must agree - a badge that appears after an edit
        -- but vanishes on reconnect is exactly the stale label this codebase
        -- refuses to ship (cardMetaShellFields.test.ts asserts the pair).
        --
        -- The COALESCE mirrors boardCardDisplayPullRequest: a card on a SECOND
        -- round of work has no current pull request until that round opens one,
        -- and falling back to the newest retired round keeps the badge from
        -- blinking out in between. SQLite's last-element path is used, and the
        -- history is stored oldest-first, so the last element is the newest.
        COALESCE(
          json_extract(pull_request, '$.number'),
          json_extract(pull_request_history, '$[#-1].number')
        ) AS "prNumber",
        parent_card_id AS "parentCardId",
        review_summary AS "reviewSummary",
        archived_at AS "archivedAt",
        created_at AS "createdAt"
      FROM board_cards
      WHERE archived_at IS NULL
    `,
  });

  // The archive page's mirror of the shell query (t3o-13, D7): same bounded
  // columns, opposite filter. Archived cards are read on demand by whoever
  // opens the archive, never streamed to every client.
  const listArchivedBoardCardShellRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardShellDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        key,
        project_id AS "projectId",
        stage,
        order_key AS "orderKey",
        title,
        blocked,
        json_array_length(depends_on) AS "dependencyCount",
        CASE WHEN brief_ref IS NULL THEN 0 ELSE 1 END AS "hasBrief",
        -- The archive list renders neither indicator, so neither is worth a
        -- correlated subquery per archived card; the columns exist only because
        -- both queries decode through one row schema.
        0 AS "briefHasImage",
        0 AS "planCount",
        (SELECT COUNT(*) FROM board_card_attachments
          WHERE board_card_attachments.card_id = board_cards.card_id)
          AS "attachmentCount",
        -- Unlike the two indicators above this is a plain column read, not a
        -- correlated subquery, so the archive list carries it for free — and
        -- an archived card's PR is exactly what you look for when working out
        -- what happened to abandoned work. Same retired-round fallback as the
        -- live query, and for the same reason.
        COALESCE(
          json_extract(pull_request, '$.number'),
          json_extract(pull_request_history, '$[#-1].number')
        ) AS "prNumber",
        parent_card_id AS "parentCardId",
        review_summary AS "reviewSummary",
        archived_at AS "archivedAt",
        created_at AS "createdAt"
      FROM board_cards
      WHERE archived_at IS NOT NULL
    `,
  });

  // Both ends of this card's dependency edges (t3o-13, D4). Archived rows are
  // deliberately included: an archived dependency must read as the card it is,
  // and an archived dependent is still worth showing on the card it points at.
  const listBoardCardDependencyRefRows = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardDependencyRefDbRow,
    execute: (cardId) => sql`
      SELECT
        card_id AS "cardId",
        key,
        title,
        stage,
        archived_at AS "archivedAt"
      FROM board_cards
      WHERE card_id IN (
        SELECT value FROM json_each((SELECT depends_on FROM board_cards WHERE card_id = ${cardId}))
      )
    `,
  });

  const listBoardCardDependentRefRows = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardDependencyRefDbRow,
    execute: (cardId) => sql`
      SELECT
        card_id AS "cardId",
        key,
        title,
        stage,
        archived_at AS "archivedAt"
      FROM board_cards
      WHERE EXISTS (
        SELECT 1 FROM json_each(board_cards.depends_on) WHERE value = ${cardId}
      )
      ORDER BY card_number
    `,
  });

  // A split parent's children (t3o-23), in materialisation order — card_number
  // is allocated in plan `ordinal` order at approval, so it IS that order.
  const listBoardCardChildRefRows = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardChildRefDbRow,
    execute: (cardId) => sql`
      SELECT
        card_id AS "cardId",
        key,
        title,
        stage,
        archived_at AS "archivedAt",
        source_plan_id AS "sourcePlanId"
      FROM board_cards
      WHERE parent_card_id = ${cardId}
      ORDER BY card_number
    `,
  });

  const findBoardCardRow = SqlSchema.findOneOption({
    Request: BoardCardId,
    Result: BoardCardDbRow,
    execute: (cardId) => sql`
      SELECT
        card_id AS "cardId",
        key,
        card_number AS "cardNumber",
        project_id AS "projectId",
        stage,
        order_key AS "orderKey",
        title,
        brief_ref AS "briefRef",
        depends_on AS "dependsOn",
        parent_card_id AS "parentCardId",
        source_plan_id AS "sourcePlanId",
        external_ref AS "externalRef",
        human_in_loop AS "humanInLoop",
        worktree,
        pull_request AS "pullRequest",
        pull_request_history AS "pullRequestHistory",
        pull_request_floor AS "pullRequestFloor",
        review_overrides AS "reviewOverrides",
        model_overrides AS "modelOverrides",
        blocked,
        archived_at AS "archivedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_cards
      WHERE card_id = ${cardId}
    `,
  });

  const listBoardCardThreadLinkRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardThreadLinkDbRow,
    execute: (cardId) => sql`
      SELECT
        thread_id AS "threadId",
        card_id AS "cardId",
        role,
        linked_at AS "linkedAt",
        tombstoned_at AS "tombstonedAt"
      FROM board_card_thread_links
      WHERE card_id = ${cardId}
    `,
  });

  const listBoardCardAttachmentRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardAttachmentDbRow,
    execute: (cardId) => sql`
      SELECT
        attachment_id AS "attachmentId",
        card_id AS "cardId",
        name,
        type,
        mime_type AS "mimeType",
        size_bytes AS "sizeBytes",
        added_at AS "addedAt"
      FROM board_card_attachments
      WHERE card_id = ${cardId}
    `,
  });

  // Every card's attachment rows, for rehydration — read once and grouped per
  // card, exactly like the thread links.
  const listBoardCardAttachmentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardAttachmentDbRow,
    execute: () => sql`
      SELECT
        attachment_id AS "attachmentId",
        card_id AS "cardId",
        name,
        type,
        mime_type AS "mimeType",
        size_bytes AS "sizeBytes",
        added_at AS "addedAt"
      FROM board_card_attachments
    `,
  });

  const findBoardCardBodyRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ cardId: BoardCardId, kind: Schema.String }),
    Result: Schema.Struct({ body: Schema.String }),
    execute: (request) => sql`
      SELECT body
      FROM board_card_bodies
      WHERE card_id = ${request.cardId} AND kind = ${request.kind}
    `,
  });

  // MAX over ALL rows — archived cards keep their numbers reserved, so the
  // archive can never cause a key to be re-issued.
  //
  // UNIONed with `board_card_number_floor` (migration 026) because DELETED
  // cards have no row to reserve their number: the floor table is the only
  // remaining record that a deleted card's number was ever issued, and without
  // it deleting the newest card in a project would hand its key to the next
  // card created there.
  const listNextCardNumberRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: NextCardNumberDbRow,
    execute: () => sql`
      SELECT
        project_id AS "projectId",
        MAX(card_number) AS "maxCardNumber"
      FROM (
        SELECT project_id, card_number FROM board_cards
        UNION ALL
        SELECT project_id, max_card_number AS card_number FROM board_card_number_floor
      )
      GROUP BY project_id
    `,
  });

  // ── Purge (card delete) ──────────────────────────────────────────────
  // One statement per table keyed on the card. There are no foreign keys
  // between the `board_*` tables, so nothing cascades and every table a card
  // writes to has to be named here — a table added later without a line here
  // leaks a row per deleted card.

  const deleteBoardCardRow = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_cards
      WHERE card_id = ${cardId}
    `,
  });

  const deleteBoardCardBodiesForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_bodies
      WHERE card_id = ${cardId}
    `,
  });

  const deleteBoardCardActivityForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_activity
      WHERE card_id = ${cardId}
    `,
  });

  const deleteBoardCardStepsForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_steps
      WHERE card_id = ${cardId}
    `,
  });

  const deleteBoardCardStepStateForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_step_state
      WHERE card_id = ${cardId}
    `,
  });

  /** Record a deleted card's number as permanently spent (migration 026), so
      the key it held can never be handed to another card. Monotonic: deleting
      an OLD card must not lower a floor a newer delete already raised. */
  const raiseBoardCardNumberFloor = SqlSchema.void({
    Request: Schema.Struct({ projectId: ProjectId, cardNumber: BoardCard.fields.cardNumber }),
    execute: (row) => sql`
      INSERT INTO board_card_number_floor (project_id, max_card_number)
      VALUES (${row.projectId}, ${row.cardNumber})
      ON CONFLICT (project_id)
      DO UPDATE SET max_card_number = MAX(max_card_number, excluded.max_card_number)
    `,
  });

  const deleteBoardCardThreadLinksForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_thread_links
      WHERE card_id = ${cardId}
    `,
  });

  const insertBoardCardThreadLinkRow = SqlSchema.void({
    Request: BoardCardThreadLinkDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_thread_links (
        thread_id,
        card_id,
        role,
        linked_at,
        tombstoned_at
      )
      VALUES (
        ${row.threadId},
        ${row.cardId},
        ${row.role},
        ${row.linkedAt},
        ${row.tombstonedAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        card_id = excluded.card_id,
        role = excluded.role,
        linked_at = excluded.linked_at,
        tombstoned_at = excluded.tombstoned_at
    `,
  });

  const deleteBoardCardAttachmentsForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_attachments
      WHERE card_id = ${cardId}
    `,
  });

  const insertBoardCardAttachmentRow = SqlSchema.void({
    Request: BoardCardAttachmentDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_attachments (
        attachment_id,
        card_id,
        name,
        type,
        mime_type,
        size_bytes,
        added_at
      )
      VALUES (
        ${row.attachmentId},
        ${row.cardId},
        ${row.name},
        ${row.type},
        ${row.mimeType},
        ${row.sizeBytes},
        ${row.addedAt}
      )
      ON CONFLICT (card_id, attachment_id)
      DO UPDATE SET
        name = excluded.name,
        type = excluded.type,
        mime_type = excluded.mime_type,
        size_bytes = excluded.size_bytes,
        added_at = excluded.added_at
    `,
  });

  const BoardCardBodyDbRow = Schema.Struct({
    cardId: BoardCardId,
    kind: Schema.String,
    body: Schema.String,
    updatedAt: BoardCard.fields.updatedAt,
  });

  const upsertBoardCardBodyRow = SqlSchema.void({
    Request: BoardCardBodyDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_bodies (card_id, kind, body, updated_at)
      VALUES (${row.cardId}, ${row.kind}, ${row.body}, ${row.updatedAt})
      ON CONFLICT (card_id, kind)
      DO UPDATE SET
        body = excluded.body,
        updated_at = excluded.updated_at
    `,
  });

  const DeleteBodyRequest = Schema.Struct({ cardId: BoardCardId, kind: Schema.String });
  const deleteBoardCardBodyRow = SqlSchema.void({
    Request: DeleteBodyRequest,
    execute: (request) => sql`
      DELETE FROM board_card_bodies
      WHERE card_id = ${request.cardId} AND kind = ${request.kind}
    `,
  });

  // ── Labels (t3o-06a) ─────────────────────────────────────────────────

  const upsertBoardLabelRow = SqlSchema.void({
    Request: BoardLabelDbRow,
    execute: (row) => sql`
      INSERT INTO board_labels (label_id, name, colour, deleted_at, created_at, updated_at)
      VALUES (${row.labelId}, ${row.name}, ${row.colour}, ${row.deletedAt}, ${row.createdAt}, ${row.updatedAt})
      ON CONFLICT (label_id)
      DO UPDATE SET
        name = excluded.name,
        colour = excluded.colour,
        deleted_at = excluded.deleted_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  // Read order is advisory only: `loadBoardState` re-sorts with
  // `compareBoardLabels`, so SQL collation can never make rehydration order
  // diverge from replay order.
  const listBoardLabelRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardLabelDbRow,
    execute: () => sql`
      SELECT
        label_id AS "labelId",
        name,
        colour,
        deleted_at AS "deletedAt",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_labels
    `,
  });

  // ── Stages (t3o-15) ──────────────────────────────────────────────────

  const upsertBoardStageRow = SqlSchema.void({
    Request: BoardStageDbRow,
    execute: (row) => sql`
      INSERT INTO board_stages (stage_id, label, role, order_key, created_at, updated_at)
      VALUES (${row.stageId}, ${row.label}, ${row.role}, ${row.orderKey}, ${row.createdAt}, ${row.updatedAt})
      ON CONFLICT (stage_id)
      DO UPDATE SET
        label = excluded.label,
        role = excluded.role,
        order_key = excluded.order_key,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const deleteBoardStageRow = SqlSchema.void({
    Request: BoardStageId,
    execute: (stageId) => sql`
      DELETE FROM board_stages
      WHERE stage_id = ${stageId}
    `,
  });

  // Read order is advisory only: `loadBoardState` re-sorts with
  // `compareBoardStages`.
  const listBoardStageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardStageDbRow,
    execute: () => sql`
      SELECT
        stage_id AS "stageId",
        label,
        role,
        order_key AS "orderKey",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_stages
    `,
  });

  // Wholesale rewrite of a card's label rows from the card's authoritative
  // ordered label list: idempotent, and structurally incapable of drifting
  // from the read model (mirrors the thread-link sync).
  const deleteBoardCardLabelsForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_labels
      WHERE card_id = ${cardId}
    `,
  });

  const insertBoardCardLabelRow = SqlSchema.void({
    Request: BoardCardLabelDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_labels (card_id, label_id, ordinal)
      VALUES (${row.cardId}, ${row.labelId}, ${row.ordinal})
      ON CONFLICT (card_id, label_id)
      DO UPDATE SET ordinal = excluded.ordinal
    `,
  });

  const listBoardCardLabelRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardLabelDbRow,
    execute: () => sql`
      SELECT card_id AS "cardId", label_id AS "labelId", ordinal
      FROM board_card_labels
    `,
  });

  const listBoardCardLabelRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardLabelDbRow,
    execute: (cardId) => sql`
      SELECT card_id AS "cardId", label_id AS "labelId", ordinal
      FROM board_card_labels
      WHERE card_id = ${cardId}
      ORDER BY ordinal ASC
    `,
  });

  // ── Agent write path (t3o-08) ────────────────────────────────────────

  // Append-only; `ON CONFLICT DO NOTHING` makes re-applying the same event
  // (replay) a no-op, since `activity_id` is derived from the event's own id.
  const insertBoardCardActivityRow = SqlSchema.void({
    Request: BoardCardActivityDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_activity (
        activity_id, card_id, kind, payload,
        actor_kind, actor_name, actor_provider_instance_id, actor_thread_id,
        thread_id, created_at
      )
      VALUES (
        ${row.activityId}, ${row.cardId}, ${row.kind}, ${row.payload},
        ${row.actorKind}, ${row.actorName}, ${row.actorProviderInstanceId}, ${row.actorThreadId},
        ${row.threadId}, ${row.createdAt}
      )
      ON CONFLICT (activity_id) DO NOTHING
    `,
  });

  // Bounded read (t3o-08 hygiene, kept through t3o-18's restructure): the log is
  // append-only and can outgrow a useful context window, so a read returns a TAIL
  // — the most recent entries — plus EVERY `card-input-requested` entry, since an
  // outstanding human gate must never age out of view. The UNION dedupes rows
  // that qualify both ways; the outer ORDER restores log order. The columns are
  // t3o-18's structured shape (kind + typed payload + actor), not the old prose
  // `body`, so `SELECT *` inside the subqueries stays column-aligned across both.
  const listBoardCardActivityRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardActivityDbRow,
    execute: (cardId) => sql`
      SELECT * FROM (
        SELECT
          activity_id AS "activityId",
          card_id AS "cardId",
          kind,
          payload,
          actor_kind AS "actorKind",
          actor_name AS "actorName",
          actor_provider_instance_id AS "actorProviderInstanceId",
          actor_thread_id AS "actorThreadId",
          thread_id AS "threadId",
          created_at AS "createdAt"
        FROM board_card_activity
        WHERE card_id = ${cardId} AND kind = 'card-input-requested'
        UNION
        SELECT * FROM (
          SELECT
            activity_id AS "activityId",
            card_id AS "cardId",
            kind,
            payload,
            actor_kind AS "actorKind",
            actor_name AS "actorName",
            actor_provider_instance_id AS "actorProviderInstanceId",
            actor_thread_id AS "actorThreadId",
            thread_id AS "threadId",
            created_at AS "createdAt"
          FROM board_card_activity
          WHERE card_id = ${cardId}
          ORDER BY created_at DESC, activity_id DESC
          LIMIT ${BOARD_CARD_ACTIVITY_TAIL_LIMIT}
        )
      )
      ORDER BY "createdAt" ASC, "activityId" ASC
    `,
  });

  // ── Thread todo cache (t3o-18, D1) ───────────────────────────────────

  const upsertBoardThreadTodoRow = SqlSchema.void({
    Request: BoardThreadTodoDbRow,
    execute: (row) => sql`
      INSERT INTO board_thread_todos (
        thread_id, card_id, statuses, current_text, done_count, total_count,
        current_started_at, advanced_at, updated_at
      )
      VALUES (
        ${row.threadId}, ${row.cardId}, ${row.statuses}, ${row.currentText},
        ${row.doneCount}, ${row.totalCount}, ${row.currentStartedAt}, ${row.advancedAt},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        card_id = excluded.card_id,
        statuses = excluded.statuses,
        current_text = excluded.current_text,
        done_count = excluded.done_count,
        total_count = excluded.total_count,
        current_started_at = excluded.current_started_at,
        advanced_at = excluded.advanced_at,
        updated_at = excluded.updated_at
    `,
  });

  const findBoardThreadTodoRow = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: BoardThreadTodoDbRow,
    execute: (threadId) => sql`
      SELECT
        thread_id AS "threadId",
        card_id AS "cardId",
        statuses,
        current_text AS "currentText",
        done_count AS "doneCount",
        total_count AS "totalCount",
        current_started_at AS "currentStartedAt",
        advanced_at AS "advancedAt",
        updated_at AS "updatedAt"
      FROM board_thread_todos
      WHERE thread_id = ${threadId}
    `,
  });

  const deleteBoardThreadTodoRow = SqlSchema.void({
    Request: ThreadId,
    execute: (threadId) => sql`DELETE FROM board_thread_todos WHERE thread_id = ${threadId}`,
  });

  const deleteBoardThreadTodoRowsForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`DELETE FROM board_thread_todos WHERE card_id = ${cardId}`,
  });

  /**
   * Boot reconciliation sweep (t3o-18, AC 20): drop every cached row whose
   * thread or link no longer exists — an unlinked or tombstoned link, an
   * archived card, a deleted thread, or a card that is simply gone. The cache is
   * a projection, so a leaked row is invisible until it resurfaces on a reused
   * id; sweeping at boot is the cheap, total answer.
   */
  const sweepOrphanBoardThreadTodoRows = SqlSchema.void({
    Request: Schema.Void,
    execute: () => sql`
      DELETE FROM board_thread_todos
      WHERE thread_id NOT IN (
              SELECT thread_id FROM board_card_thread_links WHERE tombstoned_at IS NULL
            )
         OR card_id NOT IN (SELECT card_id FROM board_cards WHERE archived_at IS NULL)
         OR thread_id NOT IN (
              SELECT thread_id FROM main.projection_threads WHERE deleted_at IS NULL
            )
    `,
  });

  /** Every live link on a non-archived card, LEFT JOINed to its todo cache
      (t3o-18, D3) — one entry per link, todos when the thread has a list. */
  const listBoardCardThreadShellRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardThreadShellDbRow,
    execute: () => sql`
      SELECT
        links.card_id AS "cardId",
        links.thread_id AS "threadId",
        todos.statuses AS "statuses",
        todos.current_text AS "currentText",
        todos.done_count AS "doneCount",
        todos.total_count AS "totalCount",
        todos.current_started_at AS "currentStartedAt",
        todos.updated_at AS "updatedAt"
      FROM board_card_thread_links links
      INNER JOIN board_cards cards ON cards.card_id = links.card_id
      LEFT JOIN board_thread_todos todos ON todos.thread_id = links.thread_id
      WHERE links.tombstoned_at IS NULL AND cards.archived_at IS NULL
      ORDER BY links.card_id ASC, links.linked_at ASC, links.thread_id ASC
    `,
  });

  const listBoardCardThreadShellRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardThreadShellDbRow,
    execute: (cardId) => sql`
      SELECT
        links.card_id AS "cardId",
        links.thread_id AS "threadId",
        todos.statuses AS "statuses",
        todos.current_text AS "currentText",
        todos.done_count AS "doneCount",
        todos.total_count AS "totalCount",
        todos.current_started_at AS "currentStartedAt",
        todos.updated_at AS "updatedAt"
      FROM board_card_thread_links links
      INNER JOIN board_cards cards ON cards.card_id = links.card_id
      LEFT JOIN board_thread_todos todos ON todos.thread_id = links.thread_id
      WHERE links.card_id = ${cardId}
        AND links.tombstoned_at IS NULL
        AND cards.archived_at IS NULL
      ORDER BY links.linked_at ASC, links.thread_id ASC
    `,
  });

  /** The card a live-linked thread belongs to — the "which card does this
      thread's todo update belong to" lookup (t3o-18, D2). `thread_id` is the
      link table's primary key, so this is a point read. */
  const findBoardCardIdForLiveThread = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ cardId: BoardCardId }),
    execute: (threadId) => sql`
      SELECT card_id AS "cardId"
      FROM board_card_thread_links
      WHERE thread_id = ${threadId} AND tombstoned_at IS NULL
    `,
  });

  const upsertBoardCardStepRow = SqlSchema.void({
    Request: BoardCardStepDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_steps (card_id, step_id, outcome, summary, payload, thread_id, completed_at)
      VALUES (${row.cardId}, ${row.stepId}, ${row.outcome}, ${row.summary}, ${row.payload}, ${row.threadId}, ${row.completedAt})
      ON CONFLICT (card_id, step_id)
      DO UPDATE SET
        outcome = excluded.outcome,
        summary = excluded.summary,
        payload = excluded.payload,
        thread_id = excluded.thread_id,
        completed_at = excluded.completed_at
    `,
  });

  const listBoardCardStepRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardStepDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        step_id AS "stepId",
        outcome,
        summary,
        payload,
        thread_id AS "threadId",
        completed_at AS "completedAt"
      FROM board_card_steps
    `,
  });

  // One card's step completions (t3o-16, D9): the card-detail loader reads these
  // to render the review loop's findings, so it filters in SQL rather than
  // scanning the whole table per modal open.
  /** Write a card's review-summary CACHE (t3o-22, D7). Its own statement, not
      part of the card upsert: the summary is a fold over the step-completion
      ledger, which no card-carrying event holds, so it is refreshed on the
      events that can change it rather than on every card write. */
  const updateBoardCardReviewSummaryRow = SqlSchema.void({
    Request: Schema.Struct({
      cardId: BoardCardId,
      reviewSummary: Schema.NullOr(Schema.fromJsonString(BoardCardReviewSummary)),
    }),
    execute: (row) => sql`
      UPDATE board_cards
      SET review_summary = ${row.reviewSummary}
      WHERE card_id = ${row.cardId}
    `,
  });

  const listBoardCardStepRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardStepDbRow,
    execute: (cardId) => sql`
      SELECT
        card_id AS "cardId",
        step_id AS "stepId",
        outcome,
        summary,
        payload,
        thread_id AS "threadId",
        completed_at AS "completedAt"
      FROM board_card_steps
      WHERE card_id = ${cardId}
      ORDER BY completed_at ASC, step_id ASC
    `,
  });

  // One row per card (t3o-10): the card's live step state. Upsert on card_id
  // so a step transition or the next step of a recipe replaces the prior row.
  const upsertBoardCardStepStateRow = SqlSchema.void({
    Request: BoardCardStepStateDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_step_state (
        card_id, step_id, step_label, stage_label, attempt, stall_count, last_nudge_at, prompt,
        provider_instance_id, model, mode, runtime_mode, model_options, base_tip_at_round_start,
        last_error, awaiting_reason,
        human_in_loop, max_attempts, timeout_ms, thread_id, status, slot_held, force_start,
        started_at, updated_at
      )
      VALUES (
        ${row.cardId}, ${row.stepId}, ${row.stepLabel}, ${row.stageLabel}, ${row.attempt}, ${row.stallCount},
        ${row.lastNudgeAt}, ${row.prompt},
        ${row.providerInstanceId}, ${row.model}, ${row.mode}, ${row.runtimeMode}, ${row.modelOptions},
        ${row.baseTipAtRoundStart},
        ${row.lastError}, ${row.awaitingReason},
        ${row.humanInLoop}, ${row.maxAttempts},
        ${row.timeoutMs}, ${row.threadId}, ${row.status}, ${row.slotHeld}, ${row.forceStart},
        ${row.startedAt}, ${row.updatedAt}
      )
      ON CONFLICT (card_id)
      DO UPDATE SET
        step_id = excluded.step_id,
        step_label = excluded.step_label,
        stage_label = excluded.stage_label,
        attempt = excluded.attempt,
        stall_count = excluded.stall_count,
        last_nudge_at = excluded.last_nudge_at,
        prompt = excluded.prompt,
        provider_instance_id = excluded.provider_instance_id,
        model = excluded.model,
        mode = excluded.mode,
        runtime_mode = excluded.runtime_mode,
        model_options = excluded.model_options,
        base_tip_at_round_start = excluded.base_tip_at_round_start,
        last_error = excluded.last_error,
        awaiting_reason = excluded.awaiting_reason,
        human_in_loop = excluded.human_in_loop,
        max_attempts = excluded.max_attempts,
        timeout_ms = excluded.timeout_ms,
        thread_id = excluded.thread_id,
        status = excluded.status,
        slot_held = excluded.slot_held,
        force_start = excluded.force_start,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `,
  });

  const listBoardCardStepStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardCardStepStateDbRow,
    execute: () => sql`
      SELECT
        card_id AS "cardId",
        step_id AS "stepId",
        step_label AS "stepLabel",
        stage_label AS "stageLabel",
        attempt,
        stall_count AS "stallCount",
        last_nudge_at AS "lastNudgeAt",
        prompt,
        provider_instance_id AS "providerInstanceId",
        model,
        mode,
        runtime_mode AS "runtimeMode",
        model_options AS "modelOptions",
        base_tip_at_round_start AS "baseTipAtRoundStart",
        last_error AS "lastError",
        awaiting_reason AS "awaitingReason",
        human_in_loop AS "humanInLoop",
        max_attempts AS "maxAttempts",
        timeout_ms AS "timeoutMs",
        thread_id AS "threadId",
        status,
        slot_held AS "slotHeld",
        force_start AS "forceStart",
        started_at AS "startedAt",
        updated_at AS "updatedAt"
      FROM board_card_step_state
    `,
  });

  /** The most recent ASSISTANT message on a thread (t3o-34, D2), or none.
   *
      The supervisor reads it once per step turn-end to decide whether the agent
      stopped with something for the human to answer. Upstream's
      `projection_thread_messages` lives in `main` and the board database is
      ATTACHED to the same connection (`boardDatabase.ts`), so this is one query
      on one connection with no new plumbing — and upstream migration 029's
      `(thread_id, created_at, message_id)` index serves it directly.

      A dedicated two-column, one-row read rather than
      `ProjectionThreadMessageRepository.listByThreadId`, which returns the
      WHOLE thread: the supervisor wants the last message, and a planning
      interview's transcript is exactly the case where "the whole thread" is
      expensive.

      `createdAt` rides along so the caller can tell the newest message from a
      RECENT one. A turn that ends having said nothing — interrupted, errored,
      tool-only — leaves the previous turn's text newest, and reading that back
      would re-park the card on a question the human has already answered. */
  const findLatestAssistantMessage = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ text: Schema.String, createdAt: IsoDateTime }),
    execute: (threadId) => sql`
      SELECT text, created_at AS "createdAt"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId}
        AND role = 'assistant'
      ORDER BY created_at DESC, message_id DESC
      LIMIT 1
    `,
  });

  /** ONE card's live-step stop reason (t3o-30, D2) — the card detail's failure
      banner and nothing else. A one-column read rather than a second use of
      `listBoardCardStepStateRows`: the banner needs the text, never the frozen
      run config, and the detail already runs a bundle of per-card queries. */
  const findBoardCardStepErrorRow = SqlSchema.findOneOption({
    Request: BoardCardId,
    Result: Schema.Struct({ lastError: BoardCardStepState.fields.lastError }),
    execute: (cardId) => sql`
      SELECT last_error AS "lastError"
      FROM board_card_step_state
      WHERE card_id = ${cardId}
    `,
  });

  // Wholesale rewrite of a card's plan rows from the proposal: idempotent, and
  // structurally incapable of drifting from the read model.
  const deleteBoardPlansForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_plans
      WHERE card_id = ${cardId}
    `,
  });

  const insertBoardPlanRow = SqlSchema.void({
    Request: BoardPlanDbRow,
    execute: (row) => sql`
      INSERT INTO board_plans (
        plan_id, card_id, title, summary, depends_on, ordinal, locked, body, created_at, updated_at
      )
      VALUES (
        ${row.planId}, ${row.cardId}, ${row.title}, ${row.summary}, ${row.dependsOn},
        ${row.ordinal}, ${row.locked}, ${row.body}, ${row.createdAt}, ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        card_id = excluded.card_id,
        title = excluded.title,
        summary = excluded.summary,
        depends_on = excluded.depends_on,
        ordinal = excluded.ordinal,
        locked = excluded.locked,
        body = excluded.body,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const UpdatePlanBodyRequest = Schema.Struct({
    planId: BoardPlanId,
    body: Schema.String,
    updatedAt: BoardPlan.fields.updatedAt,
  });
  const updateBoardPlanBodyRow = SqlSchema.void({
    Request: UpdatePlanBodyRequest,
    execute: (request) => sql`
      UPDATE board_plans
      SET body = ${request.body}, updated_at = ${request.updatedAt}
      WHERE plan_id = ${request.planId}
    `,
  });

  const listBoardPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardPlanDbRow,
    execute: () => sql`
      SELECT
        plan_id AS "planId",
        card_id AS "cardId",
        title,
        summary,
        depends_on AS "dependsOn",
        ordinal,
        locked,
        body,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_plans
    `,
  });

  // A card's proposed plans with their bodies (t3o-08) — the detail loader's
  // source for both the Plan pane's markdown and the Build stage's
  // human-in-the-loop default (D6), so one query serves the count and the text.
  const listBoardPlanRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardPlanDbRow,
    execute: (cardId) => sql`
      SELECT
        plan_id AS "planId",
        card_id AS "cardId",
        title,
        summary,
        depends_on AS "dependsOn",
        ordinal,
        locked,
        body,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_plans
      WHERE card_id = ${cardId}
    `,
  });

  const findBoardPlanRow = SqlSchema.findOneOption({
    Request: BoardPlanId,
    Result: BoardPlanDbRow,
    execute: (planId) => sql`
      SELECT
        plan_id AS "planId",
        card_id AS "cardId",
        title,
        summary,
        depends_on AS "dependsOn",
        ordinal,
        locked,
        body,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_plans
      WHERE plan_id = ${planId}
    `,
  });

  return {
    upsertBoardCardRow,
    listBoardCardRows,
    listBoardCardThreadLinkRows,
    listLiveBoardCardThreadLinkRows,
    listBoardCardShellRows,
    listArchivedBoardCardShellRows,
    listBoardCardDependencyRefRows,
    listBoardCardDependentRefRows,
    listBoardCardChildRefRows,
    findBoardCardRow,
    listBoardCardThreadLinkRowsForCard,
    findBoardCardBodyRow,
    listNextCardNumberRows,
    deleteBoardCardRow,
    deleteBoardCardBodiesForCard,
    deleteBoardCardActivityForCard,
    deleteBoardCardStepsForCard,
    deleteBoardCardStepStateForCard,
    raiseBoardCardNumberFloor,
    deleteBoardCardThreadLinksForCard,
    insertBoardCardThreadLinkRow,
    listBoardCardAttachmentRowsForCard,
    listBoardCardAttachmentRows,
    deleteBoardCardAttachmentsForCard,
    insertBoardCardAttachmentRow,
    upsertBoardCardBodyRow,
    deleteBoardCardBodyRow,
    upsertBoardLabelRow,
    listBoardLabelRows,
    upsertBoardStageRow,
    deleteBoardStageRow,
    listBoardStageRows,
    deleteBoardCardLabelsForCard,
    insertBoardCardLabelRow,
    listBoardCardLabelRows,
    listBoardCardLabelRowsForCard,
    insertBoardCardActivityRow,
    listBoardCardActivityRowsForCard,
    upsertBoardThreadTodoRow,
    findBoardThreadTodoRow,
    deleteBoardThreadTodoRow,
    deleteBoardThreadTodoRowsForCard,
    sweepOrphanBoardThreadTodoRows,
    listBoardCardThreadShellRows,
    listBoardCardThreadShellRowsForCard,
    findBoardCardIdForLiveThread,
    listBoardCardStepRowsForCard,
    updateBoardCardReviewSummaryRow,
    upsertBoardCardStepRow,
    listBoardCardStepRows,
    upsertBoardCardStepStateRow,
    listBoardCardStepStateRows,
    findBoardCardStepErrorRow,
    findLatestAssistantMessage,
    deleteBoardPlansForCard,
    insertBoardPlanRow,
    updateBoardPlanBodyRow,
    listBoardPlanRows,
    listBoardPlanRowsForCard,
    findBoardPlanRow,
  };
}

export function makeBoardProjectors(sql: SqlClient.SqlClient): ReadonlyArray<{
  readonly name: typeof BOARD_CARDS_PROJECTOR_NAME;
  readonly apply: (event: OrchestrationEvent) => Effect.Effect<void, ProjectionRepositoryError>;
}> {
  const queries = makeBoardCardQueries(sql);

  const upsertCard = (card: BoardCard) =>
    queries
      .upsertBoardCardRow(boardCardToRow(card))
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.upsert:query")));

  /**
   * Erase a card from every board table (card delete).
   *
   * Sequenced so that a failure part-way through can only ever leave MORE
   * data than intended, never a re-issuable key: the number floor goes in
   * first, then the card row, then the satellites. A leftover satellite row is
   * invisible (nothing joins to a card that is gone, and the boot sweep
   * collects orphaned todo rows); a re-issued key is a permanent collision.
   */
  const purgeCard = (card: BoardCard) =>
    Effect.gen(function* () {
      yield* queries.raiseBoardCardNumberFloor({
        projectId: card.projectId,
        cardNumber: card.cardNumber,
      });
      yield* queries.deleteBoardCardRow(card.id);
      yield* queries.deleteBoardCardBodiesForCard(card.id);
      yield* queries.deleteBoardCardThreadLinksForCard(card.id);
      yield* queries.deleteBoardCardAttachmentsForCard(card.id);
      yield* queries.deleteBoardCardLabelsForCard(card.id);
      yield* queries.deleteBoardCardActivityForCard(card.id);
      yield* queries.deleteBoardCardStepsForCard(card.id);
      yield* queries.deleteBoardCardStepStateForCard(card.id);
      yield* queries.deleteBoardThreadTodoRowsForCard(card.id);
      yield* queries.deleteBoardPlansForCard(card.id);
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.purge:query")));

  // Wholesale rewrite of a card's link rows from the event's card state:
  // idempotent, and structurally incapable of drifting from the read model.
  const syncThreadLinks = (card: BoardCard) =>
    Effect.gen(function* () {
      yield* queries.deleteBoardCardThreadLinksForCard(card.id);
      for (const link of card.threadLinks) {
        yield* queries.insertBoardCardThreadLinkRow({
          threadId: link.threadId,
          cardId: card.id,
          role: link.role,
          linkedAt: link.linkedAt,
          tombstonedAt: link.tombstonedAt,
        });
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadLinks:query")));

  // The brief's attachments (t3o-32): the same wholesale rewrite from the
  // event's card state as the thread links, synced where they can change.
  const syncAttachments = (card: BoardCard) =>
    Effect.gen(function* () {
      yield* queries.deleteBoardCardAttachmentsForCard(card.id);
      for (const attachment of card.attachments) {
        yield* queries.insertBoardCardAttachmentRow({
          attachmentId: attachment.id,
          cardId: card.id,
          name: attachment.name,
          type: attachment.type,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          addedAt: attachment.addedAt,
        });
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.attachments:query")));

  // Same wholesale-rewrite discipline for the card↔label join (t3o-06a): the
  // card's ordered label list is authoritative, and `ordinal` preserves its
  // order for rehydration. Synced only where labels can change (create /
  // update), mirroring the thread-link sync's link/unlink scope.
  const syncCardLabels = (card: BoardCard) =>
    Effect.gen(function* () {
      yield* queries.deleteBoardCardLabelsForCard(card.id);
      for (let ordinal = 0; ordinal < card.labels.length; ordinal += 1) {
        yield* queries.insertBoardCardLabelRow({
          cardId: card.id,
          labelId: card.labels[ordinal]!,
          ordinal,
        });
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.cardLabels:query")));

  const upsertLabel = (label: BoardLabel) =>
    queries
      .upsertBoardLabelRow({
        labelId: label.labelId,
        name: label.name,
        colour: label.colour,
        deletedAt: label.deletedAt,
        createdAt: label.createdAt,
        updatedAt: label.updatedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.label:query")));

  // ── Agent write path (t3o-08) ────────────────────────────────────────

  /**
   * Write one curated Activity row (t3o-18, D10/D12). The row id is the EVENT's
   * own id, so re-applying the same event (replay) is a no-op via
   * `ON CONFLICT DO NOTHING` — the rail can never double-count. The actor comes
   * from the dispatch-boundary stamp keyed on the event's `commandId`, falling
   * back to the system actor.
   */
  const recordActivity = (input: {
    readonly event: OrchestrationEvent;
    readonly cardId: BoardCardId;
    readonly kind: BoardCardActivityEntry["kind"];
    readonly payload: BoardCardActivityPayload;
    readonly threadId: ThreadId | null;
  }) => {
    const actor = boardActivityActorFor(input.event.commandId);
    return queries
      .insertBoardCardActivityRow({
        activityId: BoardActivityId.make(String(input.event.eventId)),
        cardId: input.cardId,
        kind: input.kind,
        payload: input.payload,
        actorKind: actor.kind,
        actorName: actor.name,
        actorProviderInstanceId: actor.providerInstanceId,
        actorThreadId: actor.threadId,
        threadId: input.threadId ?? actor.threadId,
        createdAt: input.event.occurredAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.activity:query")));
  };

  // ── Thread todo cache (t3o-18, D1/D2/D6) ─────────────────────────────

  /**
   * Capture a thread's `turn.plan.updated` into the board's cache.
   *
   * **Sourced from the DOMAIN event, not the runtime stream.** The spec's D2
   * hangs this off the supervisor reactor's existing `providerService`
   * subscription; it is captured here instead, from the `thread.activity-appended`
   * event that same runtime event is already ingested into. Three reasons, all
   * of which preserve every locked outcome (D1's projection-only table, D2's
   * "unlinked thread writes nothing", D14's forward-only fill):
   *
   * 1. **Ordering.** The card strip has to update live, and shell deltas are
   *    driven by the domain event stream with the causing event's `sequence`. A
   *    reactor writing the row on a separate stream races that delta, so the
   *    client would render the previous revision.
   * 2. **Transactionality.** Written here, the row commits with the event, so a
   *    reader that sees the event always sees the row.
   * 3. **Rebuild.** D1 justifies a non-event-sourced board table by pointing at
   *    the durable thread activity behind it; projecting from that activity makes
   *    the rebuild path real rather than theoretical (D14's stated worry).
   *
   * An event from a thread with no LIVE card link is ignored, not stored.
   *
   * `current_started_at` is reset ONLY when the in-progress item's TEXT changes
   * (D6): it survives reordering and insertion, needs nothing new from any
   * provider, and costs one column. `advanced_at` moves when `done_count` rises
   * or the in-progress item changes — the stall-reset signal (D16), recorded here
   * so `recoveryDecision` stays pure.
   */
  const captureThreadTodos = (input: {
    readonly threadId: ThreadId;
    readonly plan: ReadonlyArray<{ readonly step: string; readonly status: string }>;
    readonly occurredAt: string;
  }) =>
    Effect.gen(function* () {
      const cardRow = yield* queries.findBoardCardIdForLiveThread(input.threadId);
      if (Option.isNone(cardRow)) return;
      const summary = boardThreadTodoSummary(
        input.plan.map((item) => ({
          step: item.step,
          status:
            item.status === "completed"
              ? ("completed" as const)
              : item.status === "inProgress"
                ? ("inProgress" as const)
                : ("pending" as const),
        })),
      );
      const priorRow = yield* queries.findBoardThreadTodoRow(input.threadId);
      const prior = Option.getOrUndefined(priorRow);
      const currentChanged = (prior?.currentText ?? null) !== summary.currentText;
      const advanced = currentChanged || summary.doneCount > (prior?.doneCount ?? 0);
      yield* queries.upsertBoardThreadTodoRow({
        threadId: input.threadId,
        cardId: cardRow.value.cardId,
        statuses: summary.statuses,
        currentText: summary.currentText,
        doneCount: summary.doneCount,
        totalCount: summary.totalCount,
        currentStartedAt:
          summary.currentText === null
            ? null
            : currentChanged
              ? input.occurredAt
              : (prior?.currentStartedAt ?? input.occurredAt),
        advancedAt: advanced ? input.occurredAt : (prior?.advancedAt ?? null),
        updatedAt: input.occurredAt,
      });
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodos:query")));

  /** Drop one thread's cached list — an unlink, whether it removed the link or
      tombstoned it, ends the same way (t3o-18, AC 19). Also the `thread.deleted`
      path, which reaches here before any board event does. */
  const dropThreadTodos = (threadId: ThreadId) =>
    queries
      .deleteBoardThreadTodoRow(threadId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodosDrop:query")));

  /** Drop every cached list on a card — archiving it (AC 19). Unarchiving does
      NOT restore them: the cache fills forward from the next `turn.plan.updated`
      (D14), which is the same rule a fresh upgrade follows. */
  const dropCardThreadTodos = (cardId: BoardCardId) =>
    queries
      .deleteBoardThreadTodoRowsForCard(cardId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodosSweep:query")));

  /**
   * Recompute and store a card's review-summary cache (t3o-22, D7).
   *
   * Called on the two events that can change it: a review step completing (new
   * findings, a new round) and a card update (a new round budget or a stop).
   * Reads the whole ledger back rather than folding incrementally — the fold is
   * cheap, the ledger is one card's worth of rows, and a from-scratch
   * recomputation is what makes the cache rebuildable and impossible to drift.
   *
   * `maxRounds` is DISPLAY only — the walk itself runs to the ceiling, so a
   * budget this layer cannot see (the projection has no access to the board's
   * review settings) can never invert the verdict. The worst it can do is
   * under-report a still-running loop's pip count until the pane, which does
   * have the settings, renders the real budget.
   */
  const refreshReviewSummary = (card: BoardCard) =>
    Effect.gen(function* () {
      const rows = yield* queries.listBoardCardStepRowsForCard(card.id);
      const completions: ReadonlyArray<BoardStepCompletion> = rows;
      const summary = deriveBoardCardReviewSummary({
        completions,
        maxRounds: card.reviewOverrides?.rounds ?? null,
        stopAfterRound: card.reviewOverrides?.stopAfterRound ?? null,
      });
      yield* queries.updateBoardCardReviewSummaryRow({ cardId: card.id, reviewSummary: summary });
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.reviewSummary:query")));

  const upsertStep = (completion: BoardStepCompletion) =>
    queries
      .upsertBoardCardStepRow({
        cardId: completion.cardId,
        stepId: completion.stepId,
        outcome: completion.outcome,
        summary: completion.summary,
        payload: completion.payload,
        threadId: completion.threadId,
        completedAt: completion.completedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.step:query")));

  const upsertStepState = (state: BoardCardStepState) =>
    queries
      .upsertBoardCardStepStateRow({
        cardId: state.cardId,
        stepId: state.stepId,
        stepLabel: state.stepLabel,
        stageLabel: state.stageLabel,
        attempt: state.attempt,
        stallCount: state.stallCount,
        lastNudgeAt: state.lastNudgeAt,
        prompt: state.prompt,
        providerInstanceId: state.providerInstanceId,
        model: state.model,
        mode: state.mode,
        runtimeMode: state.runtimeMode,
        modelOptions: state.modelOptions === undefined ? null : JSON.stringify(state.modelOptions),
        baseTipAtRoundStart: state.baseTipAtRoundStart,
        lastError: state.lastError,
        awaitingReason: state.awaitingReason,
        humanInLoop: state.humanInLoop ? 1 : 0,
        maxAttempts: state.maxAttempts,
        timeoutMs: state.timeoutMs,
        threadId: state.threadId,
        status: state.status,
        slotHeld: state.slotHeld ? 1 : 0,
        forceStart: state.forceStart ? 1 : 0,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stepState:query")));

  const upsertStage = (stage: BoardStageDefinition) =>
    queries
      .upsertBoardStageRow({
        stageId: stage.stageId,
        label: stage.label,
        role: stage.role,
        orderKey: stage.orderKey,
        createdAt: stage.createdAt,
        updatedAt: stage.updatedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stage:query")));

  const removeStage = (stageId: BoardStageId) =>
    queries
      .deleteBoardStageRow(stageId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stageDelete:query")));

  // Wholesale rewrite of a card's plan rows from the proposal (bodies live
  // here, D8): idempotent, and structurally incapable of drifting from the
  // read-model plan metadata.
  const replacePlans = (
    cardId: BoardCardId,
    plans: ReadonlyArray<BoardPlan & { readonly body: string }>,
  ) =>
    Effect.gen(function* () {
      yield* queries.deleteBoardPlansForCard(cardId);
      for (const plan of plans) {
        yield* queries.insertBoardPlanRow({
          planId: plan.planId,
          cardId: plan.cardId,
          title: plan.title,
          summary: plan.summary,
          dependsOn: plan.dependsOn,
          ordinal: plan.ordinal,
          locked: plan.locked ? 1 : 0,
          body: plan.body,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        });
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.plans:query")));

  const writePlanBody = (planId: BoardPlanId, body: string, updatedAt: string) =>
    queries
      .updateBoardPlanBodyRow({ planId, body, updatedAt })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.planBody:query")));

  const applyBoardCardsProjection = Effect.fn("applyBoardCardsProjection")(function* (
    event: OrchestrationEvent,
  ) {
    // T3o-18: two THREAD events feed board-owned tables. Nothing upstream is
    // written — this projector still owns only `board_*` tables — but the board's
    // todo cache is a projection of the thread activity that already carries the
    // full plan (D1), so it is captured where every other projection is: in the
    // event's own transaction.
    if (!isBoardEvent(event)) {
      if (event.type === "thread.activity-appended") {
        const activity = event.payload.activity;
        if (activity.kind !== "turn.plan.updated") return;
        const plan = readTurnPlanSteps(activity.payload);
        if (plan === null) return;
        yield* captureThreadTodos({
          threadId: event.payload.threadId,
          plan,
          occurredAt: activity.createdAt,
        });
        return;
      }
      if (event.type === "thread.deleted") {
        // The link is tombstoned by its own board event, but a deleted thread's
        // cached list must go now — it can never be updated again (AC 19).
        yield* dropThreadTodos(event.payload.threadId);
      }
      return;
    }
    switch (event.type) {
      case "board.card-created": {
        const card = boardCardFromCreatedPayload(event.payload);
        yield* upsertCard(card);
        yield* syncCardLabels(card);
        // A brief captured at creation (t3o-06) writes its body here — the
        // one table bodies ever live in (D8) — mirroring the update path.
        // `upsertCard` already wrote `depends_on` and `brief_ref` from `card`.
        if (event.payload.brief !== undefined) {
          yield* queries
            .upsertBoardCardBodyRow({
              cardId: event.payload.cardId,
              kind: BOARD_CARD_BRIEF_BODY_KIND,
              body: event.payload.brief,
              updatedAt: event.payload.updatedAt,
            })
            .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.body:query")));
        }
        // A sub-board child's brief is its plan's body, carried by pointer
        // because the decider cannot read bodies (t3o-23, D2/D8). Resolved
        // here, in the same transaction that projected the approval; the
        // plans-proposed event precedes this one in any replay and approval
        // froze the plans, so the copy is deterministic. A missing plan row
        // (impossible short of hand-edited tables) leaves the child briefless
        // rather than failing the projection.
        if (event.payload.briefFromPlanId !== undefined) {
          const planRow = yield* queries
            .findBoardPlanRow(event.payload.briefFromPlanId)
            .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.planBody:query")));
          if (Option.isSome(planRow)) {
            yield* queries
              .upsertBoardCardBodyRow({
                cardId: event.payload.cardId,
                kind: BOARD_CARD_BRIEF_BODY_KIND,
                body: planRow.value.body,
                updatedAt: event.payload.updatedAt,
              })
              .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.body:query")));
          }
        }
        yield* recordActivity({
          event,
          cardId: card.id,
          kind: "card-created",
          payload: { toStage: card.stage },
          threadId: null,
        });
        return;
      }

      case "board.card-moved":
        yield* upsertCard(event.payload.card);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-moved",
          payload: { fromStage: event.payload.fromStage, toStage: event.payload.toStage },
          threadId: null,
        });
        return;

      case "board.card-archived":
        yield* upsertCard(event.payload.card);
        // An archived card leaves the board, so its cached todo lists go with it
        // (AC 19) — nothing renders them and nothing will update them again.
        yield* dropCardThreadTodos(event.payload.cardId);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-archived",
          payload: {},
          threadId: null,
        });
        return;

      case "board.card-unarchived":
        yield* upsertCard(event.payload.card);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-unarchived",
          payload: {},
          threadId: null,
        });
        return;

      case "board.card-deleted":
        // A purge, not a state change: every table keyed on the card is
        // emptied and NO activity is recorded — the rail is per-card, and the
        // card it would hang off no longer exists.
        yield* purgeCard(event.payload.card);
        return;

      case "board.card-worktree-failed":
        yield* upsertCard(event.payload.card);
        // The one worktree event on the rail (D12): the three non-failure ones
        // are progress noise, this one is a card that cannot start.
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-worktree-failed",
          payload: { detail: event.payload.error },
          threadId: null,
        });
        return;

      case "board.card-pull-request-recorded": {
        yield* upsertCard(event.payload.card);
        // Only TRANSITIONS earn a rail row. The reactor already suppresses a
        // no-change lookup, so anything reaching here moved: the link
        // appearing, or its state changing. A link DISAPPEARING (null) is not
        // railed — it means the branch's PR was deleted on the forge, which is
        // not something the card did.
        const pullRequest = event.payload.pullRequest;
        if (pullRequest === null) return;
        const kind =
          event.payload.transition === "linked"
            ? ("card-pull-request-linked" as const)
            : pullRequest.state === "merged"
              ? ("card-pull-request-merged" as const)
              : ("card-pull-request-state-changed" as const);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind,
          payload: { prNumber: pullRequest.number, prState: pullRequest.state },
          threadId: null,
        });
        return;
      }

      case "board.card-note-recorded":
        // No card write: the event exists only so the deletion (or the reason
        // one was skipped) is visible on the card rather than buried in a log.
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: event.payload.kind,
          payload: { detail: event.payload.detail },
          threadId: null,
        });
        return;

      case "board.card-reordered":
      // Worktree lifecycle (t3o-09): every payload carries the whole card, so
      // the persisted projection is the same idempotent upsert — the worktree
      // column rides `board_cards` with the rest of the aggregate.
      case "board.card-worktree-provisioning":
      case "board.card-worktree-ready":
      case "board.card-worktree-reclaimed":
        yield* upsertCard(event.payload.card);
        return;

      case "board.label-created":
      case "board.label-updated":
      case "board.label-deleted":
      case "board.label-undeleted":
        // Catalogue rows (904); delete/undelete are tombstone upserts.
        yield* upsertLabel(event.payload.label);
        return;

      case "board.stage-created":
      case "board.stage-renamed":
      case "board.stage-reordered":
        // Stage rows (014); the payload carries the whole post-change stage.
        yield* upsertStage(event.payload.stage);
        return;

      case "board.stage-deleted":
        yield* removeStage(event.payload.stageId);
        return;

      case "board.card-stage-thread-requested":
        // A request signal only — the reactor reacts; no table write.
        return;

      case "board.card-updated": {
        yield* upsertCard(event.payload.card);
        yield* syncCardLabels(event.payload.card);
        // A new round budget or a stop changes what the loop's counts MEAN
        // (t3o-22, D7), so the cache is refolded against the updated card.
        yield* refreshReviewSummary(event.payload.card);
        // Bodies live only in this table (D8); absent means unchanged.
        if (event.payload.brief === null) {
          yield* queries
            .deleteBoardCardBodyRow({
              cardId: event.payload.cardId,
              kind: BOARD_CARD_BRIEF_BODY_KIND,
            })
            .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.body:query")));
        } else if (event.payload.brief !== undefined) {
          yield* queries
            .upsertBoardCardBodyRow({
              cardId: event.payload.cardId,
              kind: BOARD_CARD_BRIEF_BODY_KIND,
              body: event.payload.brief,
              updatedAt: event.payload.card.updatedAt,
            })
            .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.body:query")));
        }
        return;
      }

      case "board.card-thread-linked":
        yield* upsertCard(event.payload.card);
        yield* syncThreadLinks(event.payload.card);
        return;

      case "board.card-thread-unlinked":
        yield* upsertCard(event.payload.card);
        yield* syncThreadLinks(event.payload.card);
        // The link is gone (removed or tombstoned) — so is the cached list it
        // was the only justification for (AC 19).
        yield* dropThreadTodos(event.payload.threadId);
        return;

      case "board.card-attached":
      case "board.card-detached":
        // Not on the Activity rail — a brief edit is not either, and the list
        // is visible on the card itself.
        yield* upsertCard(event.payload.card);
        yield* syncAttachments(event.payload.card);
        return;

      case "board.card-step-completed":
        yield* upsertStep(event.payload.completion);
        // Only a REVIEW step can move the review summary, and every other
        // stage's step skips this entirely.
        //
        // The decider folds the summary onto the event (t3o-22, D7), so the
        // common path is a plain write of what the event already carries — the
        // same value the client's `card-review` delta is applying, so the cache
        // and the live shell cannot disagree. The recompute is the fallback for
        // events written BEFORE t3o-22, which carry no summary: that is what
        // makes a from-empty replay of an older log rebuild the cache correctly
        // rather than leaving it null.
        if (parseReviewStepId(event.payload.completion.stepId) !== null) {
          const carried = event.payload.reviewSummary;
          if (carried === undefined) {
            const cardRow = yield* queries
              .findBoardCardRow(event.payload.cardId)
              .pipe(
                Effect.mapError(toPersistenceSqlError("BoardCardsProjection.reviewCard:query")),
              );
            if (Option.isSome(cardRow)) {
              yield* refreshReviewSummary(rowToBoardCard(cardRow.value, [], [], []));
            }
          } else {
            yield* queries
              .updateBoardCardReviewSummaryRow({
                cardId: event.payload.cardId,
                reviewSummary: carried,
              })
              .pipe(
                Effect.mapError(toPersistenceSqlError("BoardCardsProjection.reviewSummary:query")),
              );
          }
        }
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-step-completed",
          payload: {
            stepId: event.payload.completion.stepId,
            outcome: event.payload.completion.outcome,
          },
          threadId: event.payload.completion.threadId,
        });
        return;

      // The override is recorded on the step row and nothing else (t3o-33):
      // the step is still queued, and the activity rail keeps its nine curated
      // kinds. What the user sees change is the card starting.
      case "board.card-step-force-start-requested":
        yield* upsertStepState(event.payload.state);
        return;

      case "board.card-step-awaiting-input":
        yield* upsertStepState(event.payload.state);
        // The rail's `card-input-requested` row (D12/D13). Sourced from the step
        // parking on the gate rather than from the deleted `board_request_input`
        // tool, so it fires for EVERY input request — including the ordinary
        // question an agent asks without calling any board tool at all.
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-input-requested",
          payload: {
            stepId: event.payload.state.stepId,
            // `stepLabel` is null on a stage with no steps (t3o-19, D4), so
            // the rail names the STAGE instead — "asked for input on Planning"
            // rather than dropping the name. The key is `optionalKey`, so when
            // neither name exists it is omitted rather than set to undefined.
            ...boardActivityStepLabel(event.payload.state),
          },
          threadId: event.payload.state.threadId,
        });
        return;

      case "board.card-step-selected":
      case "board.card-step-admitted":
      case "board.card-step-recovered":
      case "board.card-step-settled":
      case "board.card-step-retuned":
        // Live step state (t3o-10): every payload carries the whole computed
        // `BoardCardStepState`, so the persisted projection is one idempotent
        // upsert on card_id — replay and rehydration cannot diverge. None of
        // these reaches the Activity rail (D12): a card that ran three steps
        // would otherwise carry ~20 rows, which is the same unreadability that
        // motivated deleting the agent-written notes.
        yield* upsertStepState(event.payload.state);
        return;

      case "board.plans-proposed":
        yield* replacePlans(event.payload.cardId, event.payload.plans);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "plans-proposed",
          payload: { planCount: event.payload.plans.length },
          threadId: null,
        });
        return;

      case "board.plans-approved":
        // Children and the parent's move ride their own events (t3o-23, D2);
        // this re-asserts the post-approval parent (covering the skipped-move
        // shape) and writes the rail's "approved the split" row.
        yield* upsertCard(event.payload.card);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "plans-approved",
          payload: { planCount: event.payload.childCardIds.length },
          threadId: null,
        });
        return;

      case "board.card-integration-branch-recorded":
        // Detail-only state (the worktree slice); the rail says nothing — the
        // approval row above already covers the moment.
        yield* upsertCard(event.payload.card);
        return;

      case "board.plan-written":
        yield* writePlanBody(
          event.payload.planId,
          event.payload.body,
          event.payload.plan.updatedAt,
        );
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "plan-written",
          payload: {
            planId: event.payload.planId,
            planTitle: event.payload.plan.title,
          },
          threadId: null,
        });
        return;

      default: {
        event satisfies never;
        return;
      }
    }
  });

  return [
    {
      name: BOARD_CARDS_PROJECTOR_NAME,
      apply: applyBoardCardsProjection,
    },
  ];
}

/** The compiled query set — built once at snapshot-query assembly and
    threaded through every reader below, never rebuilt per call. */
type BoardCardQueries = ReturnType<typeof makeBoardCardQueries>;

/**
 * The board slice rehydrated from the projection tables, or null when no
 * card has ever been created (the board field stays absent then — see the
 * enricher note below). Archived cards are included: they stay in the read
 * model so unarchive and replay work; the shell filter drops them.
 */
export function loadBoardState(
  queries: BoardCardQueries,
): Effect.Effect<BoardState | null, ProjectionRepositoryError> {
  return Effect.all([
    queries.listBoardCardRows(),
    queries.listBoardCardThreadLinkRows(),
    queries.listBoardCardAttachmentRows(),
    queries.listNextCardNumberRows(),
    queries.listBoardLabelRows(),
    queries.listBoardStageRows(),
    queries.listBoardCardLabelRows(),
    queries.listBoardCardStepRows(),
    queries.listBoardCardStepStateRows(),
    queries.listBoardPlanRows(),
  ]).pipe(
    Effect.map(
      ([
        cardRows,
        linkRows,
        attachmentRows,
        counterRows,
        labelRows,
        stageRows,
        cardLabelRows,
        stepRows,
        stepStateRows,
        planRows,
      ]) => {
        // Canonical ordering comes from the shared JS comparators — the same
        // ones the replay path uses — never from SQL collation.
        const labels = labelRows
          .map((row) => ({
            labelId: row.labelId,
            name: row.name,
            colour: row.colour,
            deletedAt: row.deletedAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }))
          .sort(compareBoardLabels);
        const stages = stageRows
          .map(
            (row): BoardStageDefinition => ({
              stageId: row.stageId,
              label: row.label,
              role: row.role,
              orderKey: row.orderKey,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
            }),
          )
          .sort(compareBoardStages);
        // A migrated-but-unused board (no cards, catalogue AND stage list still
        // the compiled seeds) reports the board slice as ABSENT — the decider
        // falls back to EMPTY_BOARD_STATE (same seeds), so this equals a
        // from-empty replay where no board event ever fired. The moment a card,
        // a label change or a stage change exists, the slice materialises.
        if (
          cardRows.length === 0 &&
          boardLabelsAreSeedOnly(labels) &&
          boardStagesAreSeedOnly(stages)
        ) {
          return null;
        }

        const linksByCard = new Map<BoardCardId, BoardCardThreadLink[]>();
        for (const row of linkRows) {
          const links = linksByCard.get(row.cardId) ?? [];
          links.push({
            threadId: row.threadId,
            role: row.role,
            linkedAt: row.linkedAt,
            tombstonedAt: row.tombstonedAt,
          });
          linksByCard.set(row.cardId, links);
        }
        const attachmentsByCard = new Map<BoardCardId, BoardCardAttachment[]>();
        for (const row of attachmentRows) {
          const attachments = attachmentsByCard.get(row.cardId) ?? [];
          attachments.push(rowToBoardCardAttachment(row));
          attachmentsByCard.set(row.cardId, attachments);
        }
        const labelsByCard = groupCardLabels(cardLabelRows);
        // Agent write-path slices (t3o-08): rehydrated with the same shared JS
        // comparators the replay path uses. Omitted (not empty) when no event
        // has produced them, so a table rehydration equals a from-empty replay
        // where no step/plan event ever fired — the same absent-vs-empty rule
        // the board slice itself follows.
        const stepCompletions = stepRows
          .map((row) => ({
            cardId: row.cardId,
            stepId: row.stepId,
            outcome: row.outcome,
            summary: row.summary,
            payload: row.payload,
            threadId: row.threadId,
            completedAt: row.completedAt,
          }))
          .sort(compareBoardStepCompletions);
        const stepStates = stepStateRows
          .map(
            (row): BoardCardStepState => ({
              cardId: row.cardId,
              stepId: row.stepId,
              stepLabel: row.stepLabel,
              stageLabel: row.stageLabel,
              attempt: row.attempt,
              stallCount: row.stallCount,
              lastNudgeAt: row.lastNudgeAt,
              prompt: row.prompt,
              providerInstanceId: row.providerInstanceId,
              model: row.model,
              mode: row.mode,
              runtimeMode: resolveStoredStepRuntimeMode(row.runtimeMode, row.mode),
              ...stepModelOptionsPatch(row.modelOptions),
              baseTipAtRoundStart: row.baseTipAtRoundStart,
              lastError: row.lastError,
              // A NULL column reads as `question` (t3o-34, D3): pre-033 rows
              // could only have parked through the structured-question path.
              awaitingReason: row.awaitingReason ?? "question",
              humanInLoop: row.humanInLoop !== 0,
              maxAttempts: row.maxAttempts,
              timeoutMs: row.timeoutMs,
              threadId: row.threadId,
              status: row.status,
              slotHeld: row.slotHeld !== 0,
              forceStart: row.forceStart !== 0,
              startedAt: row.startedAt,
              updatedAt: row.updatedAt,
            }),
          )
          .sort(compareBoardStepStates);
        const plans = planRows.map(rowToBoardPlan).sort(compareBoardPlans);
        return {
          cards: cardRows
            .map((row) =>
              rowToBoardCard(
                row,
                sortBoardCardThreadLinks(linksByCard.get(row.cardId) ?? []),
                labelsByCard.get(row.cardId) ?? [],
                sortBoardCardAttachments(attachmentsByCard.get(row.cardId) ?? []),
              ),
            )
            .sort(compareBoardCards),
          labels,
          stages,
          ...(stepCompletions.length > 0 ? { stepCompletions } : {}),
          ...(stepStates.length > 0 ? { stepStates } : {}),
          ...(plans.length > 0 ? { plans } : {}),
          nextCardNumberByProject: Object.fromEntries(
            counterRows.map((row) => [row.projectId, row.maxCardNumber + 1]),
          ),
        };
      },
    ),
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.list:query")),
  );
}

// Both enrichers omit the board data entirely when no card has ever been
// created. A never-used board is represented as an *absent* field, never as
// `{ cards: [] }`, for two reasons: (1) it makes a from-empty replay's read
// model equal the table-rehydrated one for the no-cards case —
// createEmptyReadModel and projectBoardEvent never synthesize an empty
// `board`, so rehydration must not either; (2) it keeps an empty `cards: []`
// off every shell payload (payload discipline). Every consumer already reads
// through `board ?? EMPTY_BOARD_STATE` / `cards ?? []`, so absent and empty
// are equivalent downstream.
export function withBoardReadModel(
  queries: BoardCardQueries,
  readModel: Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationReadModel, ProjectionRepositoryError> {
  return Effect.all([readModel, loadBoardState(queries)]).pipe(
    Effect.map(([model, board]) => (board === null ? model : { ...model, board })),
  );
}

/** Canonical shell-row order, same comparator family as `compareBoardCards`
    ((createdAt, cardId) by code units) applied to the narrow rows. */
function compareBoardCardShellRows(
  left: { readonly createdAt: string; readonly cardId: string },
  right: { readonly createdAt: string; readonly cardId: string },
): number {
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return compare(left.createdAt, right.createdAt) || compare(left.cardId, right.cardId);
}

/**
 * Bounded `BoardCardShell`s ride the shell snapshot (t3o-04, D7): a narrow
 * SQL projection of the live (non-archived) cards, joined in JS against the
 * snapshot's own thread shells for the thread-derived fields — the thread
 * data is already in the snapshot being enriched, so no thread SQL is
 * needed. Archived cards leave the shell (D15) but stay in the table and
 * the read model, so unarchive can bring them back.
 */
export function withBoardShellCards(
  queries: BoardCardQueries,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  const shellRows = Effect.all([
    queries.listBoardCardShellRows(),
    queries.listLiveBoardCardThreadLinkRows(),
    queries.listBoardCardLabelRows(),
    // The one step-state field on the bounded shell (t3o-11, D11): a card is
    // `queued` when its live step is holding for a slot. One row per card
    // (D4), so a small map keyed by card id.
    queries.listBoardCardStepStateRows(),
  ]).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shell:query")));
  return Effect.all([snapshot, shellRows]).pipe(
    Effect.map(([shell, [cardRows, linkRows, cardLabelRows, stepStateRows]]) => {
      if (cardRows.length === 0) return shell;
      const linksByCard = new Map<BoardCardId, BoardCardThreadLink[]>();
      for (const row of linkRows) {
        const links = linksByCard.get(row.cardId) ?? [];
        links.push({
          threadId: row.threadId,
          role: row.role,
          linkedAt: row.linkedAt,
          tombstonedAt: row.tombstonedAt,
        });
        linksByCard.set(row.cardId, links);
      }
      const labelsByCard = groupCardLabels(cardLabelRows);
      const queuedByCard = new Set<BoardCardId>();
      const stalledByCard = new Set<BoardCardId>();
      const runningByCard = new Set<BoardCardId>();
      const heldByCard = new Set<BoardCardId>();
      const awaitingByCard = new Map<BoardCardId, BoardCardStepAwaitingReason>();
      for (const row of stepStateRows) {
        if (row.status === "queued") queuedByCard.add(row.cardId);
        // The second step-state field on the bounded shell (t3o-17, D3): a card
        // is `stalled` when recovery gave up on its live step.
        if (row.status === "stalled") stalledByCard.add(row.cardId);
        // The durable "being worked" flag: the executor's step is admitted and
        // running, so the card dot stays lit across a loop stage's per-phase
        // thread spin-up gaps rather than only while a single thread is mid-turn.
        if (row.status === "running") runningByCard.add(row.cardId);
        // The quiet counterpart of `stalled`: the step SETTLED and the card is
        // still sitting on it, so the pipeline is finished and only a human
        // moves it on. Terminal covers `succeeded` (a human-in-the-loop build
        // that ran to the end, a card parked at merge) as well as `failed` /
        // `abandoned`; `stalled` is terminal-adjacent but has its own louder
        // flag, and the shared `boardCardAttention` ranks it first regardless.
        if (isBoardTerminalStepStatus(row.status)) heldByCard.add(row.cardId);
        // Why the step is parked on a human (t3o-34, D4). Before this the
        // column card could only learn about a waiting agent from the THREAD's
        // pending question, so a step parked for a prose question — or for a
        // human-in-the-loop turn that ended with nothing to answer — left the
        // card pulsing blue as if it were working.
        if (row.status === "awaiting-input") {
          awaitingByCard.set(row.cardId, row.awaitingReason ?? "question");
        }
      }
      const threadsById = new Map(shell.threads.map((thread) => [thread.id, thread]));
      const cards = [...cardRows].sort(compareBoardCardShellRows).map((row) => {
        const links = linksByCard.get(row.cardId) ?? [];
        const activeThreadId = activeBoardCardThreadId(links);
        // The badge aggregates across EVERY live-linked thread (t3o-18, D7), not
        // just the most recently linked one: a card whose OLDER thread awaits
        // input showed no "Input needed" badge at all before this, and a card
        // with work running in a non-active thread looked dead.
        const liveThreads = links
          .filter((link) => link.tombstonedAt === null)
          .map((link) => threadsById.get(link.threadId));
        return makeBoardCardShell({
          cardId: row.cardId,
          key: row.key,
          projectId: row.projectId,
          labelIds: labelsByCard.get(row.cardId) ?? [],
          stage: row.stage,
          orderKey: row.orderKey,
          title: row.title,
          blocked: row.blocked !== 0,
          dependencyCount: row.dependencyCount,
          hasBrief: row.hasBrief !== 0,
          briefHasImage: row.briefHasImage !== 0,
          planCount: row.planCount,
          attachmentCount: row.attachmentCount,
          prNumber: row.prNumber,
          // Sub-board membership (t3o-23, D1/D6): the client scopes the root
          // board and the sub-board off this key, and derives a parent's plan
          // pips from its children's. Omitted here, every child looked
          // top-level after a reconnect — on the root board, and no longer
          // counted against its parent.
          parentCardId: row.parentCardId,
          // Carried UNRESOLVED (t3o-22, D7). The renderer settles the outcome
          // against `stepRunning`, which every shell already holds — resolving
          // it here as well would give the snapshot and the `card-review`
          // delta two different answers for the same loop.
          reviewSummary: row.reviewSummary,
          archivedAt: row.archivedAt,
          activeThreadId,
          queued: queuedByCard.has(row.cardId),
          stalled: stalledByCard.has(row.cardId),
          stepRunning: runningByCard.has(row.cardId),
          held: heldByCard.has(row.cardId),
          stepAwaiting: awaitingByCard.get(row.cardId) ?? null,
          thread: liveThreads,
        });
      });
      return { ...shell, cards };
    }),
  );
}

/**
 * Live card→thread links and their cached todo summaries ride the shell
 * snapshot as their OWN array (t3o-18, D3), following the `boardLabels`
 * precedent — never denormalised onto `BoardCardShell`, whose 1280-byte budget
 * and scalars-only test are left untouched and unamended.
 *
 * Attached only when there is something to attach, exactly like the label
 * catalogue: a board with no linked threads pays nothing.
 */
export function withBoardCardThreads(
  queries: BoardCardQueries,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  const rows = queries
    .listBoardCardThreadShellRows()
    .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shellCardThreads:query")));
  return Effect.all([snapshot, rows]).pipe(
    Effect.map(([shell, threadRows]) => {
      if (threadRows.length === 0) return shell;
      return { ...shell, boardCardThreads: threadRows.map(toBoardCardThreadShell) };
    }),
  );
}

/**
 * The archive page's card list (t3o-13, D7), riding the same
 * `getArchivedShellSnapshot` the archived-threads panel already reads — the
 * archive is a page you open, not state every client carries, so it stays off
 * the live snapshot and the delta stream exactly as D15 requires.
 *
 * Newest archive first: the card you just archived by mistake is the one you
 * came to restore. Thread state is left at its resting value — an archived
 * card's threads are not what the archive list is for, and asking for them
 * would cost a query per page open.
 */
export function withBoardArchivedShellCards(
  queries: BoardCardQueries,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  const shellRows = Effect.all([
    queries.listArchivedBoardCardShellRows(),
    queries.listBoardCardLabelRows(),
  ]).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.archivedShell:query")));
  return Effect.all([snapshot, shellRows]).pipe(
    Effect.map(([shell, [cardRows, cardLabelRows]]) => {
      if (cardRows.length === 0) return shell;
      const labelsByCard = groupCardLabels(cardLabelRows);
      const cards = [...cardRows]
        .sort(
          (left, right) =>
            (right.archivedAt ?? "").localeCompare(left.archivedAt ?? "") ||
            compareBoardCardShellRows(left, right),
        )
        .map((row) =>
          makeBoardCardShell({
            cardId: row.cardId,
            key: row.key,
            projectId: row.projectId,
            labelIds: labelsByCard.get(row.cardId) ?? [],
            stage: row.stage,
            orderKey: row.orderKey,
            title: row.title,
            blocked: row.blocked !== 0,
            dependencyCount: row.dependencyCount,
            hasBrief: row.hasBrief !== 0,
            attachmentCount: row.attachmentCount,
            prNumber: row.prNumber,
            parentCardId: row.parentCardId,
            archivedAt: row.archivedAt,
            activeThreadId: null,
          }),
        );
      return { ...shell, cards };
    }),
  );
}

/**
 * The label catalogue rides the shell snapshot ONCE (t3o-06a): N labels for
 * the whole board, never denormalised per card. Includes tombstoned labels so
 * a client can render a retired-label chip muted; the picker filters them.
 * Sorted canonically for a stable picker order. Attached whenever the
 * catalogue has any rows — post-migration it always has the seeds — so even an
 * empty board's shell carries the vocabulary the picker needs.
 */
export function withBoardShellLabels(
  queries: BoardCardQueries,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  const labelRows = queries
    .listBoardLabelRows()
    .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shellLabels:query")));
  return Effect.all([snapshot, labelRows]).pipe(
    Effect.map(([shell, rows]) => {
      if (rows.length === 0) return shell;
      const boardLabels = rows
        .map((row) => ({
          labelId: row.labelId,
          name: row.name,
          colour: row.colour,
          deletedAt: row.deletedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }))
        .sort(compareBoardLabels);
      return { ...shell, boardLabels };
    }),
  );
}

/** Enrich the shell snapshot with the user-defined stage list (t3o-15) so the
    board reads column order and labels from it (D13). Always present (stages
    are seeded), so — unlike labels — this is not conditional on non-empty. */
export function withBoardShellStages(
  queries: BoardCardQueries,
  snapshot: Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>,
): Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError> {
  const stageRows = queries
    .listBoardStageRows()
    .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shellStages:query")));
  return Effect.all([snapshot, stageRows]).pipe(
    Effect.map(([shell, rows]) => {
      if (rows.length === 0) return shell;
      const boardStages = rows
        .map(
          (row): BoardStageDefinition => ({
            stageId: row.stageId,
            label: row.label,
            role: row.role,
            orderKey: row.orderKey,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }),
        )
        .sort(compareBoardStages);
      return { ...shell, boardStages };
    }),
  );
}

/**
 * Full detail for one open card (`board.subscribeCard`, t3o-04): the whole
 * aggregate (thread links incl. tombstones from 902) plus the brief body
 * from `board_card_bodies` (901). Archived cards resolve too — an archive
 * landing while the card is open must not kill the viewer's subscription.
 * Null when the card has never existed.
 *
 * A maker (queries compiled once at assembly) rather than a per-call
 * loader: the reader runs on every board event for a subscribed card.
 */
export function makeBoardCardDetailLoader(
  queries: BoardCardQueries,
): (cardId: BoardCardId) => Effect.Effect<BoardCardDetail | null, ProjectionRepositoryError> {
  return (cardId) =>
    Effect.all([
      queries.findBoardCardRow(cardId),
      queries.listBoardCardThreadLinkRowsForCard(cardId),
      queries.listBoardCardAttachmentRowsForCard(cardId),
      queries.findBoardCardBodyRow({ cardId, kind: BOARD_CARD_BRIEF_BODY_KIND }),
      queries.listBoardCardLabelRowsForCard(cardId),
      queries.listBoardCardDependencyRefRows(cardId),
      queries.listBoardCardDependentRefRows(cardId),
      queries.listBoardCardChildRefRows(cardId),
      queries.listBoardPlanRowsForCard(cardId),
      queries.listBoardCardStepRowsForCard(cardId),
      queries.listBoardCardActivityRowsForCard(cardId),
      queries.findBoardCardStepErrorRow(cardId),
    ]).pipe(
      Effect.map(
        ([
          cardRow,
          linkRows,
          attachmentRows,
          bodyRow,
          labelRows,
          dependencyRows,
          dependentRows,
          childRows,
          planRows,
          stepRows,
          activityRows,
          stepErrorRow,
        ]) => {
          if (Option.isNone(cardRow)) return null;
          const links = sortBoardCardThreadLinks(
            linkRows.map((row) => ({
              threadId: row.threadId,
              role: row.role,
              linkedAt: row.linkedAt,
              tombstonedAt: row.tombstonedAt,
            })),
          );
          const labels = [...labelRows]
            .sort((left, right) => left.ordinal - right.ordinal)
            .map((row) => row.labelId);
          const attachments = sortBoardCardAttachments(
            attachmentRows.map(rowToBoardCardAttachment),
          );
          const card = rowToBoardCard(cardRow.value, links, labels, attachments);
          // `dependsOn` order is the card's order — the SQL returns a set, so
          // the sequence is restored here rather than trusted from the rows.
          // An id whose row is gone is simply dropped: the chip has nothing to
          // show, and the gate already treats it as unmet.
          const dependencyRefsById = new Map(dependencyRows.map((row) => [row.cardId, row]));
          // Plans with their bodies (t3o-08), in the card's ordinal order — the
          // Plan pane's source, and the `hasPlan` flag is just "any plan".
          const plans = planRows.map(rowToBoardPlanWithBody).sort(compareBoardPlans);
          return {
            card,
            brief: Option.match(bodyRow, {
              onNone: () => null,
              onSome: (row) => row.body,
            }),
            dependencies: card.dependsOn.flatMap((dependencyId) => {
              const row = dependencyRefsById.get(dependencyId);
              return row === undefined ? [] : [row];
            }),
            dependents: dependentRows,
            hasPlan: plans.length > 0,
            plans,
            // Materialised children (t3o-23) in plan order, archived included
            // — the pane strikes them through rather than losing the pairing.
            children: childRows,
            // The card's completions in completion order (t3o-16, D9), from the
            // per-card step query — the same rows the read model's
            // `stepCompletions` slice is built from — sorted so the modal renders
            // review rounds in the order they landed.
            stepCompletions: [...stepRows].sort(compareBoardStepCompletions),
            // The Activity rail (t3o-18, D10): already chronological from SQL,
            // and live because `board.subscribeCard` re-emits the whole detail on
            // every board event for this card.
            activity: activityRows.map(toBoardCardActivityEntry),
            // Why the live step stopped (t3o-30, D2), or null when it is
            // healthy or absent — the failure banner's text.
            stepError: Option.getOrNull(stepErrorRow)?.lastError ?? null,
            // Filled below for a sub-board child; a top-level card has no
            // parent to inherit from and keeps the null.
            parentModelOverrides: null,
          };
        },
      ),
      // The parent's model overrides (t3o-29, D4), for a child that inherits
      // them. A second lookup rather than a join because it is conditional on
      // the card being a child at all — a top-level card, which is most of
      // them, pays nothing — and the id is only known once the card row has
      // resolved, so it cannot ride in the `Effect.all` above.
      Effect.flatMap((detail) =>
        detail === null || detail.card.parentCardId === null
          ? Effect.succeed(detail)
          : queries.findBoardCardRow(detail.card.parentCardId).pipe(
              Effect.map((parentRow) => ({
                ...detail,
                parentModelOverrides: Option.isNone(parentRow)
                  ? null
                  : parentRow.value.modelOverrides,
              })),
            ),
      ),
      Effect.mapError(toPersistenceSqlError("BoardCardsProjection.detail:query")),
    );
}

/**
 * A card's activity log for `board_get_card_context` (t3o-08), in chronological
 * order. Table-only data (D8): the read model never holds activity bodies.
 */
export function makeBoardCardActivityLoader(
  queries: BoardCardQueries,
): (
  cardId: BoardCardId,
) => Effect.Effect<ReadonlyArray<BoardCardActivityEntry>, ProjectionRepositoryError> {
  return (cardId) =>
    queries.listBoardCardActivityRowsForCard(cardId).pipe(
      Effect.map((rows) => rows.map(toBoardCardActivityEntry)),
      Effect.mapError(toPersistenceSqlError("BoardCardsProjection.activityList:query")),
    );
}

/**
 * One plan's body from `board_plans` for `board_get_plan` / `board_write_plan`
 * (t3o-08); null when the plan does not exist. The body lives only in the
 * table (D8); the plan metadata rides the read model.
 */
export function makeBoardPlanBodyLoader(
  queries: BoardCardQueries,
): (planId: BoardPlanId) => Effect.Effect<string | null, ProjectionRepositoryError> {
  return (planId) =>
    queries.findBoardPlanRow(planId).pipe(
      Effect.map(
        Option.match({
          onNone: () => null,
          onSome: (row) => row.body,
        }),
      ),
      Effect.mapError(toPersistenceSqlError("BoardCardsProjection.planBody:query")),
    );
}

/**
 * Board-only methods riding the `ProjectionSnapshotQuery` record (t3o-04).
 *
 * The upstream service's declared shape erases these keys, so consumers
 * recover them with `boardSnapshotQueryMethodsOf` (a runtime-checked,
 * board-owned accessor). This is deliberate: the snapshot-query assembly is
 * the one place the board already receives the `SqlClient`, so a board
 * reader added HERE needs no new upstream seam — while a board reader
 * anywhere else would either grow the ws layer's requirements (leaking
 * `SqlClient` into every upstream test context) or need a new service
 * layer provided in upstream composition. Growth stays inside this factory,
 * which is exactly what the t3o-02a seam comment promises ("board module
 * wraps what it needs").
 */
export interface BoardSnapshotQueryMethods {
  /** Full detail for `board.subscribeCard`; null when the card does not exist. */
  readonly boardCardDetail: (
    cardId: BoardCardId,
  ) => Effect.Effect<BoardCardDetail | null, ProjectionRepositoryError>;
  /** A card's activity log for `board_get_card_context` (t3o-08). */
  readonly boardCardActivity: (
    cardId: BoardCardId,
  ) => Effect.Effect<ReadonlyArray<BoardCardActivityEntry>, ProjectionRepositoryError>;
  /** One plan's body for `board_get_plan` (t3o-08); null when absent. */
  readonly boardPlanBody: (
    planId: BoardPlanId,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;
  /** One card's live links + cached todo summaries (t3o-18, D3) — the shell
      delta payload, and what `board_get_card_context` hands a restarted agent. */
  readonly boardCardThreads: (
    cardId: BoardCardId,
  ) => Effect.Effect<ReadonlyArray<BoardCardThreadShell>, ProjectionRepositoryError>;
  /** The card a live-linked thread belongs to, or null — how a thread-shaped
      shell refetch finds the card whose `card-threads` delta it must emit. */
  readonly boardCardIdForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardCardId | null, ProjectionRepositoryError>;
  /** One thread's cached todo row (t3o-18, D16): the supervisor reads
      `hasTodoList` and the stall-reset signal from it, so `recoveryDecision`
      stays pure with no SQL of its own. Null when the thread has no list. */
  readonly boardThreadTodo: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardThreadTodoState | null, ProjectionRepositoryError>;
  /** The most recent assistant message on a thread (t3o-34, D2), with when it
      was written, or null when the thread has none. The supervisor passes the
      text to `boardTextEndsWithQuestion`, so the stop-signal reading stays a
      pure function with no SQL of its own — the pattern `boardThreadTodo`
      established for the stall signal — and uses the timestamp to ignore a
      message the agent wrote before the work last resumed. */
  readonly boardLatestAssistantMessage: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly text: string; readonly createdAt: string } | null,
    ProjectionRepositoryError
  >;
  /** Boot reconciliation sweep of orphaned todo rows (t3o-18, AC 20). */
  readonly boardSweepThreadTodos: () => Effect.Effect<void, ProjectionRepositoryError>;
}

/** What the supervisor reads off one cached todo row (t3o-18, D16). */
export interface BoardThreadTodoState {
  readonly hasList: boolean;
  readonly doneCount: number;
  readonly totalCount: number;
  /** When the list last ADVANCED — `done_count` rose or the in-progress item
      changed. Null when it has never advanced. */
  readonly advancedAt: string | null;
}

/**
 * Recover the board-only methods from a `ProjectionSnapshotQuery` service
 * instance. Null when the instance was built without the board factory —
 * e.g. upstream tests that mock the service — so callers degrade to a typed
 * error instead of a crash. The `boardCardDetail` presence check gates the
 * whole board method set (they are added together by the one factory).
 */
export function boardSnapshotQueryMethodsOf(service: unknown): BoardSnapshotQueryMethods | null {
  const candidate = service as Partial<BoardSnapshotQueryMethods>;
  return typeof candidate.boardCardDetail === "function" &&
    typeof candidate.boardCardActivity === "function" &&
    typeof candidate.boardPlanBody === "function" &&
    typeof candidate.boardCardThreads === "function" &&
    typeof candidate.boardCardIdForThread === "function" &&
    typeof candidate.boardThreadTodo === "function" &&
    typeof candidate.boardLatestAssistantMessage === "function" &&
    typeof candidate.boardSweepThreadTodos === "function"
    ? {
        boardCardDetail: candidate.boardCardDetail,
        boardCardActivity: candidate.boardCardActivity,
        boardPlanBody: candidate.boardPlanBody,
        boardCardThreads: candidate.boardCardThreads,
        boardCardIdForThread: candidate.boardCardIdForThread,
        boardThreadTodo: candidate.boardThreadTodo,
        boardLatestAssistantMessage: candidate.boardLatestAssistantMessage,
        boardSweepThreadTodos: candidate.boardSweepThreadTodos,
      }
    : null;
}

/**
 * Board-wrapped snapshot query methods, spread over the base methods in the
 * upstream ProjectionSnapshotQuery's returned object literal. The board
 * module decides which methods it wraps; when a future spec needs to wrap
 * another one (e.g. `getSnapshot`), only this factory grows. Board-only
 * additions (`BoardSnapshotQueryMethods`) ride the same spread — TS's
 * excess-property checking does not apply to spread members, so the
 * upstream `satisfies ProjectionSnapshotQueryShape` stays intact.
 */
export function boardSnapshotQueryMethods(
  sql: SqlClient.SqlClient,
  base: Pick<
    ProjectionSnapshotQueryShape,
    "getCommandReadModel" | "getShellSnapshot" | "getArchivedShellSnapshot"
  >,
  // Typed Partial deliberately: the spread in the upstream object literal sits
  // after the base methods, and TS rejects a spread that *definitely* rewrites
  // an earlier key (TS2783). Optional keys express "board may override any
  // subset", so wrapping more methods later needs no seam change.
): Partial<ProjectionSnapshotQueryShape> & BoardSnapshotQueryMethods {
  // Compiled once here — every reader below closes over the same query set.
  const queries = makeBoardCardQueries(sql);
  // Failure isolation for the PRESENTATION overrides: these wrap queries every
  // consumer runs (engine bootstrap, subscribeShell, HTTP snapshot), so a
  // board SQL failure must not take the Threads view down for thread-only
  // users — log loudly and serve the unenriched base snapshot instead. The
  // command read model is deliberately NOT isolated: the decider decides
  // against it, and silently substituting a board-less model would let
  // commands validate against an empty board (e.g. re-minting an existing
  // card) — a correctness read fails loudly.
  const isolated = <A, E>(
    label: string,
    enriched: Effect.Effect<A, E>,
    fallback: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    enriched.pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`board snapshot enrichment failed; serving base ${label}`, {
          cause: Cause.pretty(cause),
        }).pipe(Effect.flatMap(() => fallback)),
      ),
    );
  return {
    // Board cards join the engine's command read model (D8).
    getCommandReadModel: () => withBoardReadModel(queries, base.getCommandReadModel()),
    // Bounded card shells + the label catalogue ride the shell snapshot
    // (D2/D7; catalogue once, t3o-06a).
    getShellSnapshot: () =>
      isolated(
        "shell snapshot",
        // t3o-18: the card->thread + todo array is the outermost enricher, so a
        // failure serving it still degrades to the base snapshot like every other.
        withBoardCardThreads(
          queries,
          withBoardShellStages(
            queries,
            withBoardShellLabels(queries, withBoardShellCards(queries, base.getShellSnapshot())),
          ),
        ),
        base.getShellSnapshot(),
      ),
    // Archived cards ride the archive page's snapshot (t3o-13, D7), with the
    // catalogue so their label chips render like any other card's.
    getArchivedShellSnapshot: () =>
      isolated(
        "archived shell snapshot",
        withBoardShellStages(
          queries,
          withBoardShellLabels(
            queries,
            withBoardArchivedShellCards(queries, base.getArchivedShellSnapshot()),
          ),
        ),
        base.getArchivedShellSnapshot(),
      ),
    // Board-only detail reader for board.subscribeCard (t3o-04).
    boardCardDetail: makeBoardCardDetailLoader(queries),
    // Board-only readers for the MCP context / plan tools (t3o-08).
    boardCardActivity: makeBoardCardActivityLoader(queries),
    boardPlanBody: makeBoardPlanBodyLoader(queries),
    // Board-only readers for thread todos (t3o-18): the shell delta, the MCP
    // context tool, the supervisor's stall signal, and the boot sweep.
    boardCardThreads: (cardId) =>
      queries.listBoardCardThreadShellRowsForCard(cardId).pipe(
        Effect.map((rows) => rows.map(toBoardCardThreadShell)),
        Effect.mapError(toPersistenceSqlError("BoardCardsProjection.cardThreads:query")),
      ),
    boardCardIdForThread: (threadId) =>
      queries
        .findBoardCardIdForLiveThread(threadId)
        .pipe(
          Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.cardId })),
          Effect.mapError(toPersistenceSqlError("BoardCardsProjection.cardForThread:query")),
        ),
    boardThreadTodo: (threadId) =>
      queries.findBoardThreadTodoRow(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (row): BoardThreadTodoState => ({
              hasList: row.totalCount > 0,
              doneCount: row.doneCount,
              totalCount: row.totalCount,
              advancedAt: row.advancedAt,
            }),
          }),
        ),
        Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodo:query")),
      ),
    boardLatestAssistantMessage: (threadId) =>
      queries.findLatestAssistantMessage(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (row) => ({ text: row.text, createdAt: row.createdAt }),
          }),
        ),
        Effect.mapError(toPersistenceSqlError("BoardCardsProjection.latestAssistantMessage:query")),
      ),
    boardSweepThreadTodos: () =>
      queries
        .sweepOrphanBoardThreadTodoRows()
        .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodoSweep:query"))),
  };
}

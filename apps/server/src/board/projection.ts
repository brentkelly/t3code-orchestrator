/**
 * The board's SQL projector, read queries and shell snapshot. The engine runs
 * the projector in the transaction that appends the event, so a card and its
 * side rows always commit together.
 */
import {
  BoardCardStepAwaitingReason,
  BoardCardStepStalledReason,
  BoardCardWorkerMove,
  BoardCardPlacementOrphan,
  BoardCardCi,
  BoardCardCiLastOutcome,
  BoardCiPass,
  BoardCiStepList,
  BoardCiPassSettle,
  BoardCiPassStep,
  type BoardStepQueuedBy,
  BoardWorker,
  BoardWorkerId,
  compareBoardWorkers,
  BOARD_LOCAL_WORKER_ID,
  EnvironmentId,
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
  boardStagesAreSeedOnly,
  BoardStepCompletion,
  BoardCardStepState,
  BoardCardStepParkedReason,
  boardStepParkedReason,
  BoardStageMode,
  compareBoardLabels,
  compareBoardStages,
  BoardCardWorktree,
  BoardCardPullRequest,
  BoardCardModelOverrides,
  BoardSplitRecommendation,
  BoardCardAutoPlan,
  BoardCardPlanReview,
  BoardCardDecision,
  BoardCardReviewOverrides,
  BoardCardReviewSummary,
  deriveBoardCardReviewSummary,
  parseReviewStepId,
  isEmptyBoardCardModelOverrides,
  isBoardConflictFixLive,
  isBoardChecksFixLive,
  isBoardTerminalStepStatus,
  makeBoardCardShell,
  boardSplitChildPlanCopy,
  BoardCardGroupTarget,
  type BoardCardGroup,
  BoardCardAttachment,
  BoardCardAutoMergeHold,
  sortBoardCardAttachments,
  sortBoardCardThreadLinks,
  type BoardCardDetail,
  type BoardPlanWithBody,
  type BoardState,
  type BoardCardShell,
  type BoardShellSnapshot,
  IsoDateTime,
  BoardProjectStageConfig,
  boardProjectStageConfigShell,
  type BoardProjectStageConfigShell,
  ProjectId,
  ThreadId,
  RuntimeMode,
  type ProviderOptionSelections,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../persistence/Errors.ts";
import { boardActivityActorFor } from "./activityActors.ts";
import type { TodoSignal } from "./ThreadGateway.ts";
import { makeBoardEventStore } from "./boardEventStore.ts";
import {
  boardCardFromCreatedPayload,
  compareBoardCards,
  compareBoardPlans,
  compareBoardStepCompletions,
  compareBoardStepStates,
  type BoardEvent,
} from "./projector.ts";

/** How many trailing activity entries a context read returns ;
    outstanding `input-requested` entries are always included on top. */
const BOARD_CARD_ACTIVITY_TAIL_LIMIT = 50;

// `blocked` travels as 0/1 (SQLite has no boolean); the JSON-shaped columns
// encode/decode through fromJsonString so the row schema's Type side stays
// the domain shape.
/** An own Automation toggle as a nullable SQLite integer. */
const settingToInt = (value: boolean | null): number | null =>
  value === null ? null : value ? 1 : 0;
const settingFromInt = (value: number | null): boolean | null =>
  value === null ? null : value !== 0;

const encodeBoardCiPassStepJson = Schema.encodeSync(Schema.fromJsonString(BoardCiPassStep));

/** A CI pass row: its steps as JSON. */
const BoardCiPassDbRow = Schema.Struct({
  ...BoardCiPass.fields,
  steps: Schema.fromJsonString(BoardCiPass.fields.steps),
  // The frozen steps as JSON; NULL before it.
  snapshot: Schema.NullOr(Schema.fromJsonString(BoardCiStepList)),
  configVersion: Schema.NullOr(Schema.String),
});
// The insert's request is already encoded, so the snapshot is plain JSON data.
const encodeBoardCiSnapshotJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
  // Per-card human-in-the-loop override: 0/1/NULL (SQLite has no boolean;
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
      exactly as `reviewOverrides` is, so replay equals rehydration. */
  modelOverrides: Schema.NullOr(Schema.fromJsonString(BoardCardModelOverrides)),
  /** NULL before migration 057 and for every card that follows the default
      merge strategy — indistinguishable on purpose. */
  mergeStrategy: BoardCard.fields.mergeStrategy,
  /** NULL for every row written before migration 035, and for every card whose
      latest plan proposal was a single plan — indistinguishable on purpose, so
      replay equals rehydration (t3o card 11). Plain text, not JSON: one prose
      paragraph the human reads at the Approve split gate. */
  splitRationale: BoardCard.fields.splitRationale,
  /** NULL for every row written before migration 052 and for every card with
      no split proposed since T3O-31 (D8: replay equals rehydration). */
  splitRecommendation: Schema.NullOr(Schema.fromJsonString(BoardSplitRecommendation)),
  autoPlan: Schema.NullOr(Schema.fromJsonString(BoardCardAutoPlan)),
  /** NULL for every row written before migration 054 and for every card that
      follows the Settings default (plan review). */
  planReview: Schema.NullOr(Schema.fromJsonString(BoardCardPlanReview)),
  /** NULL for every row written before migration 036, and for every card that
      follows its project's default branch — indistinguishable on purpose, which
      is what makes replay equal rehydration. */
  baseBranch: BoardCard.fields.baseBranch,
  /** NULL for every row written before migration 038, for every card that has
      never been scheduled, and for every card whose schedule has already fired
      (the supervisor clears it in the pass that acts on it) — indistinguishable
      on purpose, which is what makes replay equal rehydration. */
  scheduledStartAt: BoardCard.fields.scheduledStartAt,
  /** The card's own Automation toggles: NULL inherits, 0/1 is an
      own value. Migration 055 backfilled them from the retired `auto_start` /
      `auto_merge` columns, which are no longer written. */
  autoPlanSetting: Schema.NullOr(Schema.Int),
  autoBuildSetting: Schema.NullOr(Schema.Int),
  autoMergeSetting: Schema.NullOr(Schema.Int),
  /** NULL for every row written before migration 043, for every card whose
      armed merge has never been refused, and for every card whose hold has
      been cleared — indistinguishable on purpose. */
  autoMergeHold: Schema.NullOr(Schema.fromJsonString(BoardCardAutoMergeHold)),
  /** NULL for every row written before migration 048 and for every card that
      follows the default / has never spawned / is not moving —
      indistinguishable on purpose, so replay equals rehydration. */
  pinnedWorkerId: BoardCard.fields.pinnedWorkerId,
  placedWorkerId: BoardCard.fields.placedWorkerId,
  workerMove: Schema.NullOr(Schema.fromJsonString(BoardCardWorkerMove)),
  /** NULL before migration 049 and for every card whose worker is still on
      the board. */
  placementOrphaned: Schema.NullOr(Schema.fromJsonString(BoardCardPlacementOrphan)),
  /** NULL before migration 060 and for every card outside CI. */
  ci: Schema.NullOr(Schema.fromJsonString(BoardCardCi)),
  ciLastOutcome: Schema.NullOr(Schema.fromJsonString(BoardCardCiLastOutcome)),
  // CI failure round trips without a human.
  ciRoundTrips: Schema.Int,
  /** Migration 051: NULL `groupTarget` is a leaf. */
  groupTarget: Schema.NullOr(BoardCardGroupTarget),
  groupAutoBuild: Schema.Int,
  groupAutoMerge: Schema.Int,
  groupAutoPlan: Schema.Int,
  groupStarted: Schema.Int,
  groupPlaced: Schema.NullOr(BoardStageId),
  groupPrevStage: Schema.NullOr(BoardStageId),
  groupHeading: Schema.Int,
  groupIntegrated: Schema.Int,
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
  /** Null for `local`. */
  workerId: Schema.NullOr(EnvironmentId),
  /** Null while live. */
  retiredAt: Schema.NullOr(IsoDateTime),
});
type BoardCardThreadLinkDbRow = typeof BoardCardThreadLinkDbRow.Type;

// Brief attachment row (032_BoardCardAttachments): the mirror of
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
  // NULL for a global stage; the project a stage was made for (057).
  projectId: Schema.NullOr(ProjectId),
  // 1 / 0, or NULL on a row written before it.
  defaultForProjects: Schema.NullOr(Schema.Number),
});
type BoardStageDbRow = typeof BoardStageDbRow.Type;

/** The `board_project_stage_configs` row (058). */
const BoardProjectStageConfigDbRow = Schema.Struct({
  projectId: ProjectId,
  config: Schema.fromJsonString(BoardProjectStageConfig),
  updatedAt: IsoDateTime,
});

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

// The payload rides as a JSON string so a round-trip cannot re-serialise it into
// a different string. `actor_kind` is NOT NULL: an unstamped command resolves to
// the system actor at write time.
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

/** The board's cached copy of one thread's todo list. `statuses`
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
  /** When the list last ADVANCED: `done_count` rose or the
      in-progress item changed. The stall-reset signal reads this, so
      `recoveryDecision` stays pure with no git and no SQL. */
  advancedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
type BoardThreadTodoDbRow = typeof BoardThreadTodoDbRow.Type;

/** The shell-snapshot row: one live link on a non-archived card, LEFT JOINed to
    its todo cache, so a linked thread with no list still rides. */
const BoardCardThreadShellDbRow = Schema.Struct({
  cardId: BoardCardId,
  threadId: ThreadId,
  statuses: Schema.NullOr(Schema.String),
  currentText: Schema.NullOr(Schema.String),
  doneCount: Schema.NullOr(Schema.Int),
  totalCount: Schema.NullOr(Schema.Int),
  currentStartedAt: Schema.NullOr(IsoDateTime),
  updatedAt: Schema.NullOr(IsoDateTime),
  workerId: Schema.NullOr(EnvironmentId),
});
type BoardCardThreadShellDbRow = typeof BoardCardThreadShellDbRow.Type;

/** Map an activity row to the wire entry. The actor's four
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

/** A link row's worker, absent for `local`. */
const linkWorker = (row: { readonly workerId: EnvironmentId | null }) =>
  row.workerId === null ? {} : { workerId: row.workerId };

// Key-optional like `workerId`, so rehydration equals replay.
const linkRetired = (row: { readonly retiredAt: string | null }) =>
  row.retiredAt === null ? {} : { retiredAt: row.retiredAt };

/** Map a joined row to the wire shell: the todo fields are
    key-optional, so a thread with no list serialises as a bare link entry. */
function toBoardCardThreadShell(row: BoardCardThreadShellDbRow): BoardCardThreadShell {
  const hasTodos = row.statuses !== null && row.statuses.length > 0;
  return {
    cardId: row.cardId,
    threadId: row.threadId,
    ...linkWorker(row),
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

/** A NULL column predates migration 021 and keeps the authority the step was
    actually running under. Not `effectiveBoardRuntimeMode`: that governs a new
    resolution, this preserves an in-flight one. */
export function resolveStoredStepRuntimeMode(
  stored: RuntimeMode | null,
  mode: BoardStageMode,
): RuntimeMode {
  return stored ?? (mode === "build" ? "full-access" : "approval-required");
}

/** We wrote the column from a valid selection, so a parsed array is trusted;
    anything else yields no options rather than breaking rehydration. */
function stepModelOptionsPatch(raw: string | null): { modelOptions?: ProviderOptionSelections } {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? { modelOptions: parsed as ProviderOptionSelections } : {};
  } catch {
    return {};
  }
}

// One row per card; `slotHeld` travels as 0/1 (SQLite has no boolean).
const BoardCardStepStateDbRow = Schema.Struct({
  cardId: BoardCardStepState.fields.cardId,
  stepId: BoardCardStepState.fields.stepId,
  stepLabel: BoardCardStepState.fields.stepLabel,
  stageLabel: BoardCardStepState.fields.stageLabel,
  attempt: BoardCardStepState.fields.attempt,
  // Stall detection counters.
  stallCount: BoardCardStepState.fields.stallCount,
  // The runaway ceiling's counter. NOT NULL with a 0 default in
  // the DB, so a row written before migration 037 reads 0 — the desired
  // outcome, not a compromise.
  stageEntryRecoveries: BoardCardStepState.fields.stageEntryRecoveries,
  lastNudgeAt: BoardCardStepState.fields.lastNudgeAt,
  // Frozen execution config.
  prompt: BoardCardStepState.fields.prompt,
  providerInstanceId: BoardCardStepState.fields.providerInstanceId,
  model: BoardCardStepState.fields.model,
  mode: BoardCardStepState.fields.mode,
  // NULLABLE in the DB: rows written before migration 021 have no value. The
  // projection resolves a null to the board default.
  runtimeMode: Schema.NullOr(RuntimeMode),
  // JSON-encoded ProviderOptionSelections, or null. Carried verbatim like the
  // completion `payload`.
  modelOptions: Schema.NullOr(Schema.String),
  // NULLABLE in the DB: rows written before migration 028 have no value, and a
  // null already MEANS "no tip recorded", so no resolution shim.
  baseTipAtRoundStart: BoardCardStepState.fields.baseTipAtRoundStart,
  // NULLABLE in the DB: rows written before migration 030 have no value, and a
  // null already MEANS "stopped for no recorded reason".
  lastError: BoardCardStepState.fields.lastError,
  // NULLABLE in the DB: rows written before migration 034 have no value, and
  // every step that reached `awaiting-input` before it did so through the
  // structured-question path — which is `question`.
  awaitingReason: Schema.NullOr(BoardCardStepAwaitingReason),
  // NULLABLE in the DB: rows written before migration 040 have no value, and a
  // null already MEANS "no human turn is owed a free ending".
  humanTurnAt: BoardCardStepState.fields.humanTurnAt,
  // NULLABLE in the DB: rows written before migration 041 have no value, and a
  // stalled row written before it was recovery giving up — which is
  // `gave-up`.
  stalledReason: Schema.NullOr(BoardCardStepStalledReason),
  // NULLABLE in the DB, and a null already MEANS "nothing scheduled": older
  // rows nudged instantly, so no row had a time to record.
  retryAt: BoardCardStepState.fields.retryAt,
  // NULL before migration 054 and on every step with no plan review started.
  planReviewStartedAt: Schema.NullOr(IsoDateTime),
  planReviewRounds: Schema.NullOr(Schema.Int),
  humanInLoop: Schema.Int,
  maxAttempts: BoardCardStepState.fields.maxAttempts,
  timeoutMs: BoardCardStepState.fields.timeoutMs,
  threadId: BoardCardStepState.fields.threadId,
  status: BoardCardStepState.fields.status,
  slotHeld: Schema.Int,
  // 0/1 like `slotHeld`. Rows written before migration 033 read 0 through the
  // column default, which already means "no override asked for".
  forceStart: Schema.Int,
  // NULL for rows written before migration 048 and for any step not queued —
  // both read as plain "Queued".
  queuedBy: BoardCardStepState.fields.queuedBy,
  startedAt: BoardCardStepState.fields.startedAt,
  updatedAt: BoardCardStepState.fields.updatedAt,
});
type BoardCardStepStateDbRow = typeof BoardCardStepStateDbRow.Type;

/** The `board_workers` row: the registry, one row per worker. */
const BoardWorkerDbRow = Schema.Struct({
  id: BoardWorker.fields.id,
  label: BoardWorker.fields.label,
  url: BoardWorker.fields.url,
  addedAt: BoardWorker.fields.addedAt,
});

// `dependsOn` JSON-encodes; `locked` travels as 0/1 (SQLite has no boolean).
const BoardPlanDbRow = Schema.Struct({
  planId: BoardPlan.fields.planId,
  cardId: BoardCardId,
  title: BoardPlan.fields.title,
  summary: BoardPlan.fields.summary,
  dependsOn: Schema.fromJsonString(Schema.Array(BoardPlanId)),
  ordinal: Schema.Int,
  locked: Schema.Int,
  /** 0/1; migration 052 defaults every older row to 1 (planned). */
  planned: Schema.Int,
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
    ...(row.planned === 0 ? { planned: false } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToBoardPlanWithBody(row: BoardPlanDbRow): BoardPlanWithBody {
  return { ...rowToBoardPlan(row), body: row.body };
}

/**
 * Exactly the columns the shell needs, computed in SQL, never `SELECT *` mapped
 * down: the shell split exists to stop moving the heavy columns. `createdAt` is
 * read for ordering only.
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
  /** `board_card_attachments` rows, counted in SQL — the shell's
      `attachmentCount`; the delta path derives it from `card.attachments`. */
  attachmentCount: Schema.Int,
  /** The card's PR number, read straight out of the `pull_request` JSON. Only
      the NUMBER, not the whole struct: it is all the shell carries, and
      pulling the URL and state onto every card would spend wire bytes the
      column view has nothing to do with. */
  prNumber: Schema.NullOr(Schema.Int),
  /** The card's sub-board parent, NULL for a top-level card. Like
      `prNumber` this is a plain column on the aggregate, and like it the SQL
      snapshot is its SECOND producer — the delta path derives it in JS. Both
      must carry it or a reload flattens every sub-board onto the root board. */
  parentCardId: BoardCard.fields.parentCardId,
  /** The card's scheduled start, NULL when it is not scheduled. On
      the aggregate like `parentCardId`, so this snapshot and the JS delta path
      both carry it — or a scheduled card's pill would vanish on reconnect. */
  scheduledStartAt: BoardCard.fields.scheduledStartAt,
  /** The card's own Automation toggles and unattended-run flag. On
      the aggregate like `parentCardId`, so this snapshot and the JS delta path
      both carry them — or a card's Automation summary would change on
      reconnect. */
  autoPlanSetting: Schema.NullOr(Schema.Int),
  autoBuildSetting: Schema.NullOr(Schema.Int),
  autoMergeSetting: Schema.NullOr(Schema.Int),
  autoPlanPending: Schema.Int,
  /** The card's auto-merge hold, flattened to the facts the shell carries:
      when the hold started and whether its ladder is spent.
      Derived in SQL here and in JS on the delta path;
      `cardMetaShellFields.test.ts` pins the pair. */
  autoMergeHeldSince: Schema.NullOr(IsoDateTime),
  autoMergeGaveUp: Schema.Int,
  /** Whether the CURRENT pull request is an open draft — the SQL
      twin of `boardCardPullRequestIsOpenDraft`. */
  prDraft: Schema.Int,
  /** The worktree pair: whether one is on disk, and why the last
      reclaim kept it. Derived in SQL here and in JS on the delta path;
      `cardMetaShellFields.test.ts` pins the pair. */
  worktreeReady: Schema.Int,
  worktreeKeptReason: Schema.NullOr(Schema.String),
  /** The placement pair: the bound worker, and a move's status and
      target. Derived in SQL here and in JS on the delta path. */
  workerId: BoardCard.fields.pinnedWorkerId,
  workerMoveStatus: Schema.NullOr(Schema.Literals(["moving", "failed"])),
  workerMoveTo: BoardCard.fields.pinnedWorkerId,
  /** The removed worker's label, for Worker removed. */
  orphanedWorkerLabel: Schema.NullOr(Schema.String),
  ci: Schema.NullOr(Schema.fromJsonString(BoardCardCi)),
  ciLastOutcome: Schema.NullOr(Schema.fromJsonString(BoardCardCiLastOutcome)),
  /** Group settings, the same columns the card row reads. */
  groupTarget: Schema.NullOr(BoardCardGroupTarget),
  groupAutoBuild: Schema.Int,
  groupAutoMerge: Schema.Int,
  groupAutoPlan: Schema.Int,
  groupStarted: Schema.Int,
  groupPlaced: Schema.NullOr(BoardStageId),
  groupPrevStage: Schema.NullOr(BoardStageId),
  groupHeading: Schema.Int,
  groupIntegrated: Schema.Int,
  /** The review-summary CACHE; NULL for a card with no review
      history. Its `outcome` is provisional — `resolveBoardCardReviewOutcome`
      settles it against the card's live step at assembly. */
  reviewSummary: Schema.NullOr(Schema.fromJsonString(BoardCardReviewSummary)),
  archivedAt: BoardCard.fields.archivedAt,
  createdAt: BoardCard.fields.createdAt,
});

/** The four columns a resolved dependency edge shows — enough
    to render a chip or name a card in the archive confirmation, and nothing
    more. */
const BoardCardDependencyRefDbRow = Schema.Struct({
  cardId: BoardCard.fields.id,
  key: BoardCard.fields.key,
  title: BoardCard.fields.title,
  stage: BoardCard.fields.stage,
  archivedAt: BoardCard.fields.archivedAt,
});

/** The dependency-ref shape plus the plan a child was cut from. */
const BoardCardChildRefDbRow = Schema.Struct({
  ...BoardCardDependencyRefDbRow.fields,
  sourcePlanId: Schema.NullOr(BoardPlanId),
  dependsOn: Schema.fromJsonString(Schema.Array(BoardCardId)),
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
    splitRationale: card.splitRationale,
    splitRecommendation: card.splitRecommendation ?? null,
    autoPlan: card.autoPlan ?? null,
    planReview: card.planReview ?? null,
    baseBranch: card.baseBranch,
    scheduledStartAt: card.scheduledStartAt,
    autoPlanSetting: settingToInt(card.autoPlanSetting),
    autoBuildSetting: settingToInt(card.autoBuildSetting),
    autoMergeSetting: settingToInt(card.autoMergeSetting),
    autoMergeHold: card.autoMergeHold,
    mergeStrategy: card.mergeStrategy,
    pinnedWorkerId: card.pinnedWorkerId,
    placedWorkerId: card.placedWorkerId,
    workerMove: card.workerMove,
    placementOrphaned: card.placementOrphaned,
    ci: card.ci,
    ciLastOutcome: card.ciLastOutcome,
    ciRoundTrips: card.ciRoundTrips,
    groupTarget: card.group?.target ?? null,
    groupAutoBuild: card.group?.autoBuild === true ? 1 : 0,
    groupAutoMerge: card.group?.autoMerge === true ? 1 : 0,
    groupAutoPlan: card.group?.autoPlan === true ? 1 : 0,
    groupStarted: card.group?.started === true ? 1 : 0,
    groupPlaced: card.group?.placed ?? null,
    groupPrevStage: card.group?.prevStage ?? null,
    groupHeading: card.group?.heading === true ? 1 : 0,
    groupIntegrated: card.group?.integrated === true ? 1 : 0,
    blocked: card.blocked ? 1 : 0,
    archivedAt: card.archivedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function boardCardGroupFromRow(
  row: Pick<
    BoardCardDbRow,
    | "stage"
    | "groupTarget"
    | "groupAutoBuild"
    | "groupAutoMerge"
    | "groupAutoPlan"
    | "groupStarted"
    | "groupPlaced"
    | "groupPrevStage"
    | "groupHeading"
    | "groupIntegrated"
  >,
): BoardCardGroup | null {
  if (row.groupTarget === null) return null;
  return {
    target: row.groupTarget,
    autoBuild: row.groupAutoBuild !== 0,
    autoMerge: row.groupAutoMerge !== 0,
    autoPlan: row.groupAutoPlan !== 0,
    started: row.groupStarted !== 0,
    placed: row.groupPlaced ?? row.stage,
    prevStage: row.groupPrevStage,
    heading: row.groupHeading !== 0,
    integrated: row.groupIntegrated !== 0,
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
    splitRationale: row.splitRationale,
    ...(row.splitRecommendation === null ? {} : { splitRecommendation: row.splitRecommendation }),
    ...(row.autoPlan === null ? {} : { autoPlan: row.autoPlan }),
    ...(row.planReview === null ? {} : { planReview: row.planReview }),
    baseBranch: row.baseBranch,
    scheduledStartAt: row.scheduledStartAt,
    autoPlanSetting: settingFromInt(row.autoPlanSetting),
    autoBuildSetting: settingFromInt(row.autoBuildSetting),
    autoMergeSetting: settingFromInt(row.autoMergeSetting),
    autoMergeHold: row.autoMergeHold,
    mergeStrategy: row.mergeStrategy,
    pinnedWorkerId: row.pinnedWorkerId,
    placedWorkerId: row.placedWorkerId,
    workerMove: row.workerMove,
    placementOrphaned: row.placementOrphaned,
    ci: row.ci,
    ciLastOutcome: row.ciLastOutcome,
    ciRoundTrips: row.ciRoundTrips,
    group: boardCardGroupFromRow(row),
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
        split_rationale,
        split_recommendation,
        auto_plan,
        plan_review,
        base_branch,
        scheduled_start_at,
        auto_plan_setting,
        auto_build_setting,
        auto_merge_setting,
        auto_merge_hold,
        merge_strategy,
        pinned_worker_id,
        placed_worker_id,
        worker_move,
        placement_orphaned,
        ci,
        ci_last_outcome,
        ci_round_trips,
        group_target,
        group_auto_build,
        group_auto_merge,
        group_auto_plan,
        group_started,
        group_placed,
        group_prev_stage,
        group_heading,
        group_integrated,
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
        ${row.splitRationale},
        ${row.splitRecommendation},
        ${row.autoPlan},
        ${row.planReview},
        ${row.baseBranch},
        ${row.scheduledStartAt},
        ${row.autoPlanSetting},
        ${row.autoBuildSetting},
        ${row.autoMergeSetting},
        ${row.autoMergeHold},
        ${row.mergeStrategy},
        ${row.pinnedWorkerId},
        ${row.placedWorkerId},
        ${row.workerMove},
        ${row.placementOrphaned},
        ${row.ci},
        ${row.ciLastOutcome},
        ${row.ciRoundTrips},
        ${row.groupTarget},
        ${row.groupAutoBuild},
        ${row.groupAutoMerge},
        ${row.groupAutoPlan},
        ${row.groupStarted},
        ${row.groupPlaced},
        ${row.groupPrevStage},
        ${row.groupHeading},
        ${row.groupIntegrated},
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
        split_rationale = excluded.split_rationale,
        split_recommendation = excluded.split_recommendation,
        auto_plan = excluded.auto_plan,
        plan_review = excluded.plan_review,
        base_branch = excluded.base_branch,
        scheduled_start_at = excluded.scheduled_start_at,
        auto_plan_setting = excluded.auto_plan_setting,
        auto_build_setting = excluded.auto_build_setting,
        auto_merge_setting = excluded.auto_merge_setting,
        auto_merge_hold = excluded.auto_merge_hold,
        merge_strategy = excluded.merge_strategy,
        pinned_worker_id = excluded.pinned_worker_id,
        placed_worker_id = excluded.placed_worker_id,
        worker_move = excluded.worker_move,
        placement_orphaned = excluded.placement_orphaned,
        ci = excluded.ci,
        ci_last_outcome = excluded.ci_last_outcome,
        ci_round_trips = excluded.ci_round_trips,
        group_target = excluded.group_target,
        group_auto_build = excluded.group_auto_build,
        group_auto_merge = excluded.group_auto_merge,
        group_auto_plan = excluded.group_auto_plan,
        group_started = excluded.group_started,
        group_placed = excluded.group_placed,
        group_prev_stage = excluded.group_prev_stage,
        group_heading = excluded.group_heading,
        group_integrated = excluded.group_integrated,
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
        split_rationale AS "splitRationale",
        split_recommendation AS "splitRecommendation",
        auto_plan AS "autoPlan",
        plan_review AS "planReview",
        base_branch AS "baseBranch",
        scheduled_start_at AS "scheduledStartAt",
        auto_plan_setting AS "autoPlanSetting",
        auto_build_setting AS "autoBuildSetting",
        auto_merge_setting AS "autoMergeSetting",
        auto_merge_hold AS "autoMergeHold",
        merge_strategy AS "mergeStrategy",
        pinned_worker_id AS "pinnedWorkerId",
        placed_worker_id AS "placedWorkerId",
        worker_move AS "workerMove",
        placement_orphaned AS "placementOrphaned",
        ci,
        ci_last_outcome AS "ciLastOutcome",
        ci_round_trips AS "ciRoundTrips",
        group_target AS "groupTarget",
        group_auto_build AS "groupAutoBuild",
        group_auto_merge AS "groupAutoMerge",
        group_auto_plan AS "groupAutoPlan",
        group_started AS "groupStarted",
        group_placed AS "groupPlaced",
        group_prev_stage AS "groupPrevStage",
        group_heading AS "groupHeading",
        group_integrated AS "groupIntegrated",
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
        tombstoned_at AS "tombstonedAt",
        worker_id AS "workerId",
        retired_at AS "retiredAt"
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
        tombstoned_at AS "tombstonedAt",
        worker_id AS "workerId",
        retired_at AS "retiredAt"
      FROM board_card_thread_links
      WHERE tombstoned_at IS NULL
        AND retired_at IS NULL
        AND card_id IN (SELECT card_id FROM board_cards WHERE archived_at IS NULL)
    `,
  });

  // Shell rows exclude archived cards at the source: they never reach
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
        scheduled_start_at AS "scheduledStartAt",
        auto_plan_setting AS "autoPlanSetting",
        auto_build_setting AS "autoBuildSetting",
        auto_merge_setting AS "autoMergeSetting",
        -- The unattended-run flag (T3O-38): the JS twin is
        -- isBoardCardAutoPlanPending.
        CASE
          WHEN auto_plan IS NOT NULL AND json_extract(auto_plan, '$.endedAt') IS NULL THEN 1
          ELSE 0
        END AS "autoPlanPending",
        -- The SECOND producer of the auto-merge shell facts (T3O-38, D14). The
        -- delta path derives the same three in JS off the card aggregate's
        -- autoMergeHold; these derive them in SQL
        -- off the same columns, and the two must agree or a held card's pill
        -- would appear
        -- after an edit and vanish on reconnect (cardMetaShellFields.test.ts
        -- asserts the pair).
        json_extract(auto_merge_hold, '$.heldSince') AS "autoMergeHeldSince",
        -- Gave up is exactly "a hold with no next rung": an exhausted hold is
        -- KEPT (D10) so the card goes on saying why it stopped.
        CASE
          WHEN auto_merge_hold IS NOT NULL
            AND json_extract(auto_merge_hold, '$.retryAt') IS NULL THEN 1
          ELSE 0
        END AS "autoMergeGaveUp",
        -- The SECOND producer of prDraft (T3O-12); the delta path reads it
        -- through boardCardPullRequestIsOpenDraft. Current link only: a retired
        -- round's pull request is never a draft worth tagging.
        CASE
          WHEN json_extract(pull_request, '$.isDraft') = 1
            AND json_extract(pull_request, '$.state') = 'open' THEN 1
          ELSE 0
        END AS "prDraft",
        -- The SECOND producer of the worktree pair (T3O-52, D5); the delta
        -- path reads the same two facts off the aggregate's worktree.
        CASE WHEN json_extract(worktree, '$.status') = 'ready' THEN 1 ELSE 0 END
          AS "worktreeReady",
        json_extract(worktree, '$.reclaimBlockedReason') AS "worktreeKeptReason",
        -- The SECOND producer of the placement pair (T3O-65); the delta path
        -- reads it through boardCardBoundWorkerId: the placement while the
        -- card holds a worktree, else its pin.
        CASE
          WHEN json_extract(worktree, '$.status') IN ('ready', 'provisioning')
            THEN COALESCE(placed_worker_id, ${BOARD_LOCAL_WORKER_ID})
          ELSE pinned_worker_id
        END AS "workerId",
        json_extract(worker_move, '$.status') AS "workerMoveStatus",
        json_extract(worker_move, '$.toWorkerId') AS "workerMoveTo",
        json_extract(placement_orphaned, '$.workerLabel') AS "orphanedWorkerLabel",
        ci,
        ci_last_outcome AS "ciLastOutcome",
        group_target AS "groupTarget",
        group_auto_build AS "groupAutoBuild",
        group_auto_merge AS "groupAutoMerge",
        group_auto_plan AS "groupAutoPlan",
        group_started AS "groupStarted",
        group_placed AS "groupPlaced",
        group_prev_stage AS "groupPrevStage",
        group_heading AS "groupHeading",
        group_integrated AS "groupIntegrated",
        review_summary AS "reviewSummary",
        archived_at AS "archivedAt",
        created_at AS "createdAt"
      FROM board_cards
      WHERE archived_at IS NULL
    `,
  });

  // The archive page's mirror of the shell query: same bounded
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
        -- A plain column read, so the archive list carries it for free. Same
        -- retired-round fallback as the live query.
        COALESCE(
          json_extract(pull_request, '$.number'),
          json_extract(pull_request_history, '$[#-1].number')
        ) AS "prNumber",
        parent_card_id AS "parentCardId",
        scheduled_start_at AS "scheduledStartAt",
        auto_plan_setting AS "autoPlanSetting",
        auto_build_setting AS "autoBuildSetting",
        auto_merge_setting AS "autoMergeSetting",
        -- The unattended-run flag (T3O-38): the JS twin is
        -- isBoardCardAutoPlanPending.
        CASE
          WHEN auto_plan IS NOT NULL AND json_extract(auto_plan, '$.endedAt') IS NULL THEN 1
          ELSE 0
        END AS "autoPlanPending",
        -- The SECOND producer of the auto-merge shell facts (T3O-38, D14). The
        -- delta path derives the same three in JS off the card aggregate's
        -- autoMergeHold; these derive them in SQL
        -- off the same columns, and the two must agree or a held card's pill
        -- would appear
        -- after an edit and vanish on reconnect (cardMetaShellFields.test.ts
        -- asserts the pair).
        json_extract(auto_merge_hold, '$.heldSince') AS "autoMergeHeldSince",
        -- Gave up is exactly "a hold with no next rung": an exhausted hold is
        -- KEPT (D10) so the card goes on saying why it stopped.
        CASE
          WHEN auto_merge_hold IS NOT NULL
            AND json_extract(auto_merge_hold, '$.retryAt') IS NULL THEN 1
          ELSE 0
        END AS "autoMergeGaveUp",
        -- The SECOND producer of prDraft (T3O-12); the delta path reads it
        -- through boardCardPullRequestIsOpenDraft. Current link only: a retired
        -- round's pull request is never a draft worth tagging.
        CASE
          WHEN json_extract(pull_request, '$.isDraft') = 1
            AND json_extract(pull_request, '$.state') = 'open' THEN 1
          ELSE 0
        END AS "prDraft",
        -- The SECOND producer of the worktree pair (T3O-52, D5); the delta
        -- path reads the same two facts off the aggregate's worktree.
        CASE WHEN json_extract(worktree, '$.status') = 'ready' THEN 1 ELSE 0 END
          AS "worktreeReady",
        json_extract(worktree, '$.reclaimBlockedReason') AS "worktreeKeptReason",
        -- The SECOND producer of the placement pair (T3O-65); the delta path
        -- reads it through boardCardBoundWorkerId: the placement while the
        -- card holds a worktree, else its pin.
        CASE
          WHEN json_extract(worktree, '$.status') IN ('ready', 'provisioning')
            THEN COALESCE(placed_worker_id, ${BOARD_LOCAL_WORKER_ID})
          ELSE pinned_worker_id
        END AS "workerId",
        json_extract(worker_move, '$.status') AS "workerMoveStatus",
        json_extract(worker_move, '$.toWorkerId') AS "workerMoveTo",
        json_extract(placement_orphaned, '$.workerLabel') AS "orphanedWorkerLabel",
        ci,
        ci_last_outcome AS "ciLastOutcome",
        group_target AS "groupTarget",
        group_auto_build AS "groupAutoBuild",
        group_auto_merge AS "groupAutoMerge",
        group_auto_plan AS "groupAutoPlan",
        group_started AS "groupStarted",
        group_placed AS "groupPlaced",
        group_prev_stage AS "groupPrevStage",
        group_heading AS "groupHeading",
        group_integrated AS "groupIntegrated",
        review_summary AS "reviewSummary",
        archived_at AS "archivedAt",
        created_at AS "createdAt"
      FROM board_cards
      WHERE archived_at IS NOT NULL
    `,
  });

  // Both ends of this card's dependency edges. Archived rows are
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

  // The ancestors' dependencies, minus the card's own. The depth cap
  // guards a corrupt parent cycle, as `boardCardAncestors` does.
  const listBoardCardGroupDependencyRefRows = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardDependencyRefDbRow,
    execute: (cardId) => sql`
      WITH RECURSIVE ancestors(card_id, depth) AS (
        SELECT parent_card_id, 1 FROM board_cards
        WHERE card_id = ${cardId} AND parent_card_id IS NOT NULL
        UNION ALL
        SELECT board_cards.parent_card_id, ancestors.depth + 1
        FROM board_cards JOIN ancestors ON board_cards.card_id = ancestors.card_id
        WHERE board_cards.parent_card_id IS NOT NULL AND ancestors.depth < 64
      )
      SELECT
        card_id AS "cardId",
        key,
        title,
        stage,
        archived_at AS "archivedAt"
      FROM board_cards
      WHERE card_id IN (
        SELECT dependency.value
        FROM ancestors
        JOIN board_cards AS group_card ON group_card.card_id = ancestors.card_id,
        json_each(group_card.depends_on) AS dependency
      )
      AND card_id NOT IN (
        SELECT value FROM json_each((SELECT depends_on FROM board_cards WHERE card_id = ${cardId}))
      )
      AND card_id <> ${cardId}
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

  // A split parent's children, in materialisation order — card_number
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
        source_plan_id AS "sourcePlanId",
        depends_on AS "dependsOn"
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
        split_rationale AS "splitRationale",
        split_recommendation AS "splitRecommendation",
        auto_plan AS "autoPlan",
        plan_review AS "planReview",
        base_branch AS "baseBranch",
        scheduled_start_at AS "scheduledStartAt",
        auto_plan_setting AS "autoPlanSetting",
        auto_build_setting AS "autoBuildSetting",
        auto_merge_setting AS "autoMergeSetting",
        auto_merge_hold AS "autoMergeHold",
        merge_strategy AS "mergeStrategy",
        pinned_worker_id AS "pinnedWorkerId",
        placed_worker_id AS "placedWorkerId",
        worker_move AS "workerMove",
        placement_orphaned AS "placementOrphaned",
        ci,
        ci_last_outcome AS "ciLastOutcome",
        ci_round_trips AS "ciRoundTrips",
        group_target AS "groupTarget",
        group_auto_build AS "groupAutoBuild",
        group_auto_merge AS "groupAutoMerge",
        group_auto_plan AS "groupAutoPlan",
        group_started AS "groupStarted",
        group_placed AS "groupPlaced",
        group_prev_stage AS "groupPrevStage",
        group_heading AS "groupHeading",
        group_integrated AS "groupIntegrated",
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
        tombstoned_at AS "tombstonedAt",
        worker_id AS "workerId",
        retired_at AS "retiredAt"
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

  // MAX over all rows (archived cards keep their numbers) UNION the number floor,
  // the only record of a deleted card's number. Without it, deleting a project's
  // newest card would re-issue its key.
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

  // No foreign keys between the `board_*` tables, so nothing cascades: a table
  // added without a purge statement here leaks a row per deleted card.

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
        tombstoned_at,
        worker_id,
        retired_at
      )
      VALUES (
        ${row.threadId},
        ${row.cardId},
        ${row.role},
        ${row.linkedAt},
        ${row.tombstonedAt},
        ${row.workerId},
        ${row.retiredAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        card_id = excluded.card_id,
        role = excluded.role,
        linked_at = excluded.linked_at,
        tombstoned_at = excluded.tombstoned_at,
        worker_id = excluded.worker_id,
        retired_at = excluded.retired_at
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

  // ── Labels ─────────────────────────────────────────────────

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

  // ── Stages ──────────────────────────────────────────────────

  const upsertBoardStageRow = SqlSchema.void({
    Request: BoardStageDbRow,
    execute: (row) => sql`
      INSERT INTO board_stages (stage_id, label, role, order_key, created_at, updated_at, project_id, default_for_projects)
      VALUES (${row.stageId}, ${row.label}, ${row.role}, ${row.orderKey}, ${row.createdAt}, ${row.updatedAt}, ${row.projectId}, ${row.defaultForProjects})
      ON CONFLICT (stage_id)
      DO UPDATE SET
        project_id = excluded.project_id,
        default_for_projects = excluded.default_for_projects,
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
        updated_at AS "updatedAt",
        project_id AS "projectId",
        default_for_projects AS "defaultForProjects"
      FROM board_stages
    `,
  });

  // ── Project stage configs ───────────────────────────────────

  const upsertBoardProjectStageConfigRow = SqlSchema.void({
    Request: BoardProjectStageConfigDbRow,
    execute: (row) => sql`
      INSERT INTO board_project_stage_configs (project_id, config_json, updated_at)
      VALUES (${row.projectId}, ${row.config}, ${row.updatedAt})
      ON CONFLICT (project_id)
      DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at
    `,
  });

  const listBoardProjectStageConfigRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardProjectStageConfigDbRow,
    execute: () => sql`
      SELECT
        project_id AS "projectId",
        config_json AS "config",
        updated_at AS "updatedAt"
      FROM board_project_stage_configs
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

  // ── Agent write path ────────────────────────────────────────

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

  // Returns a tail plus every `card-input-requested` entry, since an outstanding
  // human gate must never age out of view. UNION dedupes; the outer ORDER restores
  // log order.
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

  // ── Thread todo cache ───────────────────────────────────

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

  /** Every live link on a non-archived card, LEFT JOINed to its todo cache —
       one entry per link, todos when the thread has a list. */
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
        todos.updated_at AS "updatedAt",
        links.worker_id AS "workerId"
      FROM board_card_thread_links links
      INNER JOIN board_cards cards ON cards.card_id = links.card_id
      LEFT JOIN board_thread_todos todos ON todos.thread_id = links.thread_id
      WHERE links.tombstoned_at IS NULL
        AND links.retired_at IS NULL
        AND cards.archived_at IS NULL
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
        todos.updated_at AS "updatedAt",
        links.worker_id AS "workerId"
      FROM board_card_thread_links links
      INNER JOIN board_cards cards ON cards.card_id = links.card_id
      LEFT JOIN board_thread_todos todos ON todos.thread_id = links.thread_id
      WHERE links.card_id = ${cardId}
        AND links.tombstoned_at IS NULL
        AND links.retired_at IS NULL
        AND cards.archived_at IS NULL
      ORDER BY links.linked_at ASC, links.thread_id ASC
    `,
  });

  /** The card a live-linked thread belongs to — the "which card does this
      thread's todo update belong to" lookup. `thread_id` is the
      link table's primary key, so this is a point read. */
  const findBoardCardIdForLiveThread = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ cardId: BoardCardId }),
    execute: (threadId) => sql`
      SELECT card_id AS "cardId"
      FROM board_card_thread_links
      WHERE thread_id = ${threadId} AND tombstoned_at IS NULL AND retired_at IS NULL
    `,
  });

  const findBoardThreadWorker = SqlSchema.findOneOption({
    Request: ThreadId,
    Result: Schema.Struct({ workerId: Schema.NullOr(EnvironmentId) }),
    execute: (threadId) => sql`
      SELECT worker_id AS "workerId"
      FROM board_card_thread_links
      WHERE thread_id = ${threadId}
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

  // One card's step completions: the card-detail loader reads these
  // to render the review loop's findings, so it filters in SQL rather than
  // scanning the whole table per modal open.
  /** Write a card's review-summary CACHE. Its own statement, not
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

  /** Its own statement because `board.plans-proposed` carries the plans, not the
      card, so there is no card to upsert; the in-memory projector does the same
      targeted set. */
  const updateBoardCardSplitRationaleRow = SqlSchema.void({
    Request: Schema.Struct({
      cardId: BoardCardId,
      splitRationale: BoardCard.fields.splitRationale,
      splitRecommendation: Schema.NullOr(Schema.fromJsonString(BoardSplitRecommendation)),
    }),
    execute: (row) => sql`
      UPDATE board_cards
      SET split_rationale = ${row.splitRationale},
        split_recommendation = ${row.splitRecommendation}
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

  // One row per card: the card's live step state. Upsert on card_id
  // so a step transition or the next step of a recipe replaces the prior row.
  const upsertBoardCardStepStateRow = SqlSchema.void({
    Request: BoardCardStepStateDbRow,
    execute: (row) => sql`
      INSERT INTO board_card_step_state (
        card_id, step_id, step_label, stage_label, attempt, stall_count,
        stage_entry_recoveries, last_nudge_at, prompt,
        provider_instance_id, model, mode, runtime_mode, model_options, base_tip_at_round_start,
        last_error, awaiting_reason, human_turn_at, stalled_reason, retry_at,
        plan_review_started_at, plan_review_rounds,
        human_in_loop, max_attempts, timeout_ms, thread_id, status, slot_held, force_start,
        queued_by, started_at, updated_at
      )
      VALUES (
        ${row.cardId}, ${row.stepId}, ${row.stepLabel}, ${row.stageLabel}, ${row.attempt}, ${row.stallCount},
        ${row.stageEntryRecoveries}, ${row.lastNudgeAt}, ${row.prompt},
        ${row.providerInstanceId}, ${row.model}, ${row.mode}, ${row.runtimeMode}, ${row.modelOptions},
        ${row.baseTipAtRoundStart},
        ${row.lastError}, ${row.awaitingReason}, ${row.humanTurnAt}, ${row.stalledReason}, ${row.retryAt},
        ${row.planReviewStartedAt}, ${row.planReviewRounds},
        ${row.humanInLoop}, ${row.maxAttempts},
        ${row.timeoutMs}, ${row.threadId}, ${row.status}, ${row.slotHeld}, ${row.forceStart},
        ${row.queuedBy}, ${row.startedAt}, ${row.updatedAt}
      )
      ON CONFLICT (card_id)
      DO UPDATE SET
        step_id = excluded.step_id,
        step_label = excluded.step_label,
        stage_label = excluded.stage_label,
        attempt = excluded.attempt,
        stall_count = excluded.stall_count,
        stage_entry_recoveries = excluded.stage_entry_recoveries,
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
        human_turn_at = excluded.human_turn_at,
        stalled_reason = excluded.stalled_reason,
        retry_at = excluded.retry_at,
        plan_review_started_at = excluded.plan_review_started_at,
        plan_review_rounds = excluded.plan_review_rounds,
        human_in_loop = excluded.human_in_loop,
        max_attempts = excluded.max_attempts,
        timeout_ms = excluded.timeout_ms,
        thread_id = excluded.thread_id,
        status = excluded.status,
        slot_held = excluded.slot_held,
        force_start = excluded.force_start,
        queued_by = excluded.queued_by,
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
        stage_entry_recoveries AS "stageEntryRecoveries",
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
        human_turn_at AS "humanTurnAt",
        stalled_reason AS "stalledReason",
        retry_at AS "retryAt",
        plan_review_started_at AS "planReviewStartedAt",
        plan_review_rounds AS "planReviewRounds",
        human_in_loop AS "humanInLoop",
        max_attempts AS "maxAttempts",
        timeout_ms AS "timeoutMs",
        thread_id AS "threadId",
        status,
        slot_held AS "slotHeld",
        force_start AS "forceStart",
        queued_by AS "queuedBy",
        started_at AS "startedAt",
        updated_at AS "updatedAt"
      FROM board_card_step_state
    `,
  });

  // The worker registry. Upsert on the worker id: a re-pair replaces
  // the same row.
  const upsertBoardWorkerRow = SqlSchema.void({
    Request: BoardWorkerDbRow,
    execute: (row) => sql`
      INSERT INTO board_workers (worker_id, label, url, added_at)
      VALUES (${row.id}, ${row.label}, ${row.url}, ${row.addedAt})
      ON CONFLICT (worker_id)
      DO UPDATE SET label = excluded.label, url = excluded.url, added_at = excluded.added_at
    `,
  });

  const deleteBoardWorkerRow = SqlSchema.void({
    Request: Schema.String,
    execute: (workerId) => sql`
      DELETE FROM board_workers WHERE worker_id = ${workerId}
    `,
  });

  const listBoardWorkerRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BoardWorkerDbRow,
    execute: () => sql`
      SELECT worker_id AS "id", label, url, added_at AS "addedAt"
      FROM board_workers
    `,
  });

  // One row or none: none means the default is `local`.
  const writeBoardDefaultWorkerRow = SqlSchema.void({
    Request: BoardWorkerId,
    execute: (workerId) =>
      workerId === BOARD_LOCAL_WORKER_ID
        ? sql`DELETE FROM board_default_worker`
        : sql`
            INSERT INTO board_default_worker (singleton, worker_id)
            VALUES (1, ${workerId})
            ON CONFLICT (singleton) DO UPDATE SET worker_id = excluded.worker_id
          `,
  });

  const findBoardDefaultWorkerRow = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: Schema.Struct({ workerId: BoardWorkerId }),
    execute: () => sql`
      SELECT worker_id AS "workerId" FROM board_default_worker WHERE singleton = 1
    `,
  });

  /** ONE card's live-step stop reason — the card detail's failure
      banner and nothing else. A one-column read rather than a second use of
      `listBoardCardStepStateRows`: the banner needs the text, never the frozen
      run config, and the detail already runs a bundle of per-card queries. */
  const findBoardCardStepErrorRow = SqlSchema.findOneOption({
    Request: BoardCardId,
    Result: Schema.Struct({
      lastError: BoardCardStepState.fields.lastError,
      status: BoardCardStepState.fields.status,
      planReviewStartedAt: Schema.NullOr(IsoDateTime),
      planReviewRounds: Schema.NullOr(Schema.Int),
    }),
    execute: (cardId) => sql`
      SELECT
        last_error AS "lastError",
        status,
        plan_review_started_at AS "planReviewStartedAt",
        plan_review_rounds AS "planReviewRounds"
      FROM board_card_step_state
      WHERE card_id = ${cardId}
    `,
  });

  // Wholesale rewrite of a card's plan rows from the proposal: idempotent, and
  // structurally incapable of drifting from the read model.
  // The decision log. `INSERT OR IGNORE` on the event-derived id
  // makes a re-projected event a no-op.
  const insertBoardCardDecisionRow = SqlSchema.void({
    Request: BoardCardDecision,
    execute: (row) => sql`
      INSERT OR IGNORE INTO board_card_decisions (
        decision_id, card_id, step_id, thread_id, question, decision, reason,
        flag, decided_by, created_at
      ) VALUES (
        ${row.decisionId}, ${row.cardId}, ${row.stepId}, ${row.threadId},
        ${row.question}, ${row.decision}, ${row.reason}, ${row.flag},
        ${row.decidedBy}, ${row.createdAt}
      )
    `,
  });

  const listBoardCardDecisionRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCardDecision,
    execute: (cardId) => sql`
      SELECT
        decision_id AS "decisionId",
        card_id AS "cardId",
        step_id AS "stepId",
        thread_id AS "threadId",
        question,
        decision,
        reason,
        flag,
        decided_by AS "decidedBy",
        created_at AS "createdAt"
      FROM board_card_decisions
      WHERE card_id = ${cardId}
      -- rowid, not decision_id: "evt:10" sorts before "evt:2" as text.
      ORDER BY created_at, rowid
    `,
  });

  // CI passes: one row per pass, its steps (with output tails) as
  // JSON. Table-only, read by the card detail.
  const insertBoardCiPassRow = SqlSchema.void({
    Request: BoardCiPass,
    execute: (pass) => sql`
      INSERT OR IGNORE INTO board_ci_passes (
        run_id, card_id, entry, ordinal, started_at, finished_at, outcome, steps,
        log_dir, fix_thread_id, snapshot, config_version
      ) VALUES (
        ${pass.runId}, ${pass.cardId}, ${pass.entry}, ${pass.ordinal}, ${pass.startedAt},
        ${pass.finishedAt}, ${pass.outcome}, ${encodeBoardCiSnapshotJson(pass.steps)}, ${pass.logDir},
        ${pass.fixThreadId},
        ${pass.snapshot === null ? null : encodeBoardCiSnapshotJson(pass.snapshot)},
        ${pass.configVersion}
      )
    `,
  });

  const updateBoardCiPassStepRow = SqlSchema.void({
    Request: Schema.Struct({
      runId: Schema.String,
      index: Schema.Int,
      step: Schema.String,
    }),
    execute: (input) => sql`
      UPDATE board_ci_passes
      SET steps = json_set(steps, ${`$[${input.index}]`}, json(${input.step}))
      WHERE run_id = ${input.runId}
    `,
  });

  const settleBoardCiPassRow = SqlSchema.void({
    Request: BoardCiPassSettle,
    execute: (settle) => sql`
      UPDATE board_ci_passes
      SET
        outcome = COALESCE(outcome, ${settle.outcome ?? null}),
        finished_at = COALESCE(finished_at, ${settle.finishedAt ?? null}),
        fix_thread_id = COALESCE(${settle.fixThreadId ?? null}, fix_thread_id)
      WHERE run_id = ${settle.runId}
    `,
  });

  const listBoardCiPassRowsForCard = SqlSchema.findAll({
    Request: BoardCardId,
    Result: BoardCiPassDbRow,
    execute: (cardId) => sql`
      SELECT
        run_id AS "runId",
        card_id AS "cardId",
        entry,
        ordinal,
        started_at AS "startedAt",
        finished_at AS "finishedAt",
        outcome,
        steps,
        log_dir AS "logDir",
        fix_thread_id AS "fixThreadId",
        snapshot,
        config_version AS "configVersion"
      FROM board_ci_passes
      WHERE card_id = ${cardId}
      ORDER BY entry, ordinal, rowid
    `,
  });

  const deleteBoardCiPassesForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_ci_passes
      WHERE card_id = ${cardId}
    `,
  });

  const deleteBoardCardDecisionsForCard = SqlSchema.void({
    Request: BoardCardId,
    execute: (cardId) => sql`
      DELETE FROM board_card_decisions
      WHERE card_id = ${cardId}
    `,
  });

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
        plan_id, card_id, title, summary, depends_on, ordinal, locked, planned, body,
        created_at, updated_at
      )
      VALUES (
        ${row.planId}, ${row.cardId}, ${row.title}, ${row.summary}, ${row.dependsOn},
        ${row.ordinal}, ${row.locked}, ${row.planned}, ${row.body}, ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        card_id = excluded.card_id,
        title = excluded.title,
        summary = excluded.summary,
        depends_on = excluded.depends_on,
        ordinal = excluded.ordinal,
        locked = excluded.locked,
        planned = excluded.planned,
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
        planned,
        body,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM board_plans
    `,
  });

  // A card's proposed plans with their bodies — the detail loader's
  // source for both the Plan pane's markdown and the Build stage's
  // human-in-the-loop default, so one query serves the count and the text.
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
        planned,
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
        planned,
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
    listBoardCardGroupDependencyRefRows,
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
    listBoardCardThreadShellRows,
    listBoardCardThreadShellRowsForCard,
    findBoardCardIdForLiveThread,
    findBoardThreadWorker,
    listBoardCardStepRowsForCard,
    updateBoardCardReviewSummaryRow,
    updateBoardCardSplitRationaleRow,
    upsertBoardCardStepRow,
    listBoardCardStepRows,
    upsertBoardCardStepStateRow,
    listBoardCardStepStateRows,
    upsertBoardWorkerRow,
    deleteBoardWorkerRow,
    listBoardWorkerRows,
    upsertBoardProjectStageConfigRow,
    listBoardProjectStageConfigRows,
    writeBoardDefaultWorkerRow,
    findBoardDefaultWorkerRow,
    findBoardCardStepErrorRow,
    deleteBoardPlansForCard,
    insertBoardCardDecisionRow,
    listBoardCardDecisionRowsForCard,
    deleteBoardCardDecisionsForCard,
    insertBoardCiPassRow,
    updateBoardCiPassStepRow,
    settleBoardCiPassRow,
    listBoardCiPassRowsForCard,
    deleteBoardCiPassesForCard,
    insertBoardPlanRow,
    updateBoardPlanBodyRow,
    listBoardPlanRows,
    listBoardPlanRowsForCard,
    findBoardPlanRow,
  };
}

/**
 * `applyBoardEvent` runs inside the transaction that appends the event;
 * `applyTodoSignal` folds the thread signals the todo cache needs, driven by the
 * todo tail.
 */
export interface BoardSqlProjector {
  readonly applyBoardEvent: (event: BoardEvent) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly applyTodoSignal: (signal: TodoSignal) => Effect.Effect<void, ProjectionRepositoryError>;
}

export function makeBoardSqlProjector(sql: SqlClient.SqlClient): BoardSqlProjector {
  const queries = makeBoardCardQueries(sql);

  const upsertCard = (card: BoardCard) =>
    queries
      .upsertBoardCardRow(boardCardToRow(card))
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.upsert:query")));

  // Untraced: the card writers below (through replacePlans) run per projected event.
  /**
   * Ordered so a partial failure leaves more data, never a re-issuable key: the
   * number floor first, then the card row, then the satellites (invisible once
   * the card is gone).
   */
  const purgeCard = Effect.fnUntraced(
    function* (card: BoardCard) {
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
      yield* queries.deleteBoardCardDecisionsForCard(card.id);
      yield* queries.deleteBoardCiPassesForCard(card.id);
    },
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.purge:query")),
  );

  // Wholesale rewrite of a card's link rows from the event's card state:
  // idempotent, and structurally incapable of drifting from the read model.
  const syncThreadLinks = Effect.fnUntraced(
    function* (card: BoardCard) {
      yield* queries.deleteBoardCardThreadLinksForCard(card.id);
      for (const link of card.threadLinks) {
        yield* queries.insertBoardCardThreadLinkRow({
          threadId: link.threadId,
          cardId: card.id,
          role: link.role,
          linkedAt: link.linkedAt,
          tombstonedAt: link.tombstonedAt,
          workerId: link.workerId ?? null,
          retiredAt: link.retiredAt ?? null,
        });
      }
    },
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadLinks:query")),
  );

  // The brief's attachments: the same wholesale rewrite from the
  // event's card state as the thread links, synced where they can change.
  const syncAttachments = Effect.fnUntraced(
    function* (card: BoardCard) {
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
    },
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.attachments:query")),
  );

  // Same wholesale-rewrite discipline for the card↔label join: the
  // card's ordered label list is authoritative, and `ordinal` preserves its
  // order for rehydration. Synced only where labels can change (create /
  // update), mirroring the thread-link sync's link/unlink scope.
  const syncCardLabels = Effect.fnUntraced(
    function* (card: BoardCard) {
      yield* queries.deleteBoardCardLabelsForCard(card.id);
      for (let ordinal = 0; ordinal < card.labels.length; ordinal += 1) {
        yield* queries.insertBoardCardLabelRow({
          cardId: card.id,
          labelId: card.labels[ordinal]!,
          ordinal,
        });
      }
    },
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.cardLabels:query")),
  );

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

  // ── Agent write path ────────────────────────────────────────

  /**
   * The row id is the event's own id, so a replay is a no-op via
   * `ON CONFLICT DO NOTHING` and the rail never double-counts.
   */
  const recordActivity = (input: {
    readonly event: BoardEvent;
    readonly cardId: BoardCardId;
    readonly kind: BoardCardActivityEntry["kind"];
    readonly payload: BoardCardActivityPayload;
    readonly threadId: ThreadId | null;
    /** A second row from the same event needs its own id (plan review). */
    readonly activityIdSuffix?: string;
  }) => {
    const actor = boardActivityActorFor(input.event.commandId);
    return queries
      .insertBoardCardActivityRow({
        activityId: BoardActivityId.make(
          `${String(input.event.eventId)}${input.activityIdSuffix ?? ""}`,
        ),
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

  // ── Thread todo cache ─────────────────────────────

  /**
   * Captured from the domain event, not the runtime stream, so the row commits
   * with the event that drives the card delta, and rebuilds from thread activity.
   * Unlinked threads write nothing. `current_started_at` resets only when the
   * in-progress item's text changes; `advanced_at` is the stall-reset signal.
   */
  const captureThreadTodos = Effect.fnUntraced(
    function* (input: {
      readonly threadId: ThreadId;
      readonly plan: ReadonlyArray<{ readonly step: string; readonly status: string }>;
      readonly occurredAt: string;
    }) {
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
    },
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodos:query")),
  );

  /** Drop one thread's cached list — an unlink, whether it removed the link or
      tombstoned it, ends the same way (AC 19). Also the `thread.deleted`
      path, which reaches here before any board event does. */
  const dropThreadTodos = (threadId: ThreadId) =>
    queries
      .deleteBoardThreadTodoRow(threadId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodosDrop:query")));

  /** Drop every cached list on a card — archiving it (AC 19). Unarchiving does
      NOT restore them: the cache fills forward from the next `turn.plan.updated`,
      which is the same rule a fresh upgrade follows. */
  const dropCardThreadTodos = (cardId: BoardCardId) =>
    queries
      .deleteBoardThreadTodoRowsForCard(cardId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodosSweep:query")));

  /**
   * Recomputed from the whole ledger so the cache is rebuildable and cannot drift.
   * `maxRounds` is display only: the walk runs to the ceiling, so a budget this
   * layer cannot see never inverts the verdict.
   */
  const refreshReviewSummary = Effect.fnUntraced(
    function* (card: BoardCard) {
      const rows = yield* queries.listBoardCardStepRowsForCard(card.id);
      const completions: ReadonlyArray<BoardStepCompletion> = rows;
      const summary = deriveBoardCardReviewSummary({
        completions,
        maxRounds: card.reviewOverrides?.rounds ?? null,
        stopAfterRound: card.reviewOverrides?.stopAfterRound ?? null,
        runThroughRound: card.reviewOverrides?.runThroughRound ?? null,
        carriedFindings: card.reviewOverrides?.carriedFindings ?? {},
        stuckWaivedThrough: card.reviewOverrides?.stuckWaivedThrough ?? null,
      });
      yield* queries.updateBoardCardReviewSummaryRow({ cardId: card.id, reviewSummary: summary });
    },
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.reviewSummary:query")),
  );

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
        stageEntryRecoveries: state.stageEntryRecoveries,
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
        humanTurnAt: state.humanTurnAt,
        stalledReason: state.stalledReason,
        retryAt: state.retryAt,
        planReviewStartedAt: state.planReviewStartedAt ?? null,
        planReviewRounds: state.planReviewRounds ?? null,
        humanInLoop: state.humanInLoop ? 1 : 0,
        maxAttempts: state.maxAttempts,
        timeoutMs: state.timeoutMs,
        threadId: state.threadId,
        status: state.status,
        slotHeld: state.slotHeld ? 1 : 0,
        forceStart: state.forceStart ? 1 : 0,
        queuedBy: state.queuedBy,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stepState:query")));

  const upsertWorker = (worker: BoardWorker) =>
    queries
      .upsertBoardWorkerRow(worker)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.worker:query")));

  const deleteWorker = (workerId: EnvironmentId) =>
    queries
      .deleteBoardWorkerRow(workerId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.workerDelete:query")));

  const writeDefaultWorker = (workerId: BoardWorkerId) =>
    queries
      .writeBoardDefaultWorkerRow(workerId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.defaultWorker:query")));

  const upsertStage = (stage: BoardStageDefinition) =>
    queries
      .upsertBoardStageRow({
        stageId: stage.stageId,
        label: stage.label,
        role: stage.role,
        orderKey: stage.orderKey,
        createdAt: stage.createdAt,
        updatedAt: stage.updatedAt,
        projectId: stage.projectId,
        defaultForProjects:
          stage.defaultForProjects === undefined ? null : stage.defaultForProjects ? 1 : 0,
      })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stage:query")));

  const removeStage = (stageId: BoardStageId) =>
    queries
      .deleteBoardStageRow(stageId)
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.stageDelete:query")));

  // Wholesale rewrite of a card's plan rows from the proposal (bodies live
  // here, D8): idempotent, and structurally incapable of drifting from the
  // read-model plan metadata.
  const replacePlans = Effect.fnUntraced(
    function* (cardId: BoardCardId, plans: ReadonlyArray<BoardPlan & { readonly body: string }>) {
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
          planned: plan.planned === false ? 0 : 1,
          body: plan.body,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        });
      }
    },
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.plans:query")),
  );

  const writePlanBody = (planId: BoardPlanId, body: string, updatedAt: string) =>
    queries
      .updateBoardPlanBodyRow({ planId, body, updatedAt })
      .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.planBody:query")));

  // Two THREAD signals feed board-owned tables. Nothing upstream is
  // written — the todo cache is a projection of the plan the signal carries
  // whole.
  const applyTodoSignal = Effect.fn("applyBoardTodoSignal")(function* (signal: TodoSignal) {
    if (signal.type === "todos-changed") {
      yield* captureThreadTodos({
        threadId: signal.threadId,
        plan: signal.todos,
        occurredAt: signal.at,
      });
      return;
    }
    // The link is tombstoned by its own board event, but a deleted thread's
    // cached list must go now — it can never be updated again (AC 19).
    yield* dropThreadTodos(signal.threadId);
  });

  const applyBoardEvent = Effect.fn("applyBoardEvent")(function* (event: BoardEvent) {
    switch (event.type) {
      case "board.card-created": {
        const card = boardCardFromCreatedPayload(event.payload);
        yield* upsertCard(card);
        yield* syncCardLabels(card);
        // A brief captured at creation writes its body here — the
        // one table bodies ever live in — mirroring the update path.
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
        // A sub-board child's brief is its plan's body, carried by pointer because the
        // decider cannot read bodies. Approval froze the plans, so the copy is
        // deterministic; a missing plan row leaves the child briefless, not failing.
        if (event.payload.briefFromPlanId !== undefined) {
          const planRow = yield* queries
            .findBoardPlanRow(event.payload.briefFromPlanId)
            .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.planBody:query")));
          if (Option.isSome(planRow)) {
            const briefOnly = event.payload.briefOnly === true;
            yield* queries
              .upsertBoardCardBodyRow({
                cardId: event.payload.cardId,
                kind: BOARD_CARD_BRIEF_BODY_KIND,
                body: planRow.value.body,
                updatedAt: event.payload.updatedAt,
              })
              .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.body:query")));
            // The child owns a copy of its plan, so it counts as
            // planned without a parent special case — unless the plan was a
            // brief that still needs planning.
            if (!briefOnly) {
              const copy = boardSplitChildPlanCopy(planRow.value, {
                id: card.id,
                createdAt: card.createdAt,
              });
              yield* queries
                .insertBoardPlanRow({
                  ...copy,
                  locked: 0,
                  planned: 1,
                  body: planRow.value.body,
                })
                .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.plans:query")));
            }
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
        // A human's Advance past a stuck review loop writes its waiver in the
        // move, which changes what the loop's counts mean.
        if (event.payload.reviewSummary !== undefined) {
          yield* refreshReviewSummary(event.payload.card);
        }
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-moved",
          payload: { fromStage: event.payload.fromStage, toStage: event.payload.toStage },
          threadId: null,
        });
        return;

      // Raise the old project's number floor: if the card held its highest number,
      // the rehydrated counter would regress and re-issue an existing key.
      case "board.card-project-changed":
        yield* queries
          .raiseBoardCardNumberFloor({
            projectId: event.payload.previousProjectId,
            cardNumber: event.payload.previousCardNumber,
          })
          .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.numberFloor:query")));
        yield* upsertCard(event.payload.card);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-project-changed",
          payload: {
            fromProjectId: event.payload.previousProjectId,
            toProjectId: event.payload.card.projectId,
            fromKey: event.payload.previousKey,
            toKey: event.payload.card.key,
          },
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
        // The one worktree event on the rail: the three non-failure ones
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
        // Only transitions (`linked`, `state-changed`) earn a rail row. `updated` is
        // the same PR in the same state, and a vanished link is not the card's doing.
        const pullRequest = event.payload.pullRequest;
        if (pullRequest === null) return;
        if (event.payload.transition === "updated") return;
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

      case "board.card-ci-recorded": {
        yield* upsertCard(event.payload.card);
        const { action, started, settled, activity } = event.payload;
        const ciWrites = Effect.gen(function* () {
          for (const pass of settled) yield* queries.settleBoardCiPassRow(pass);
          if (started !== null) yield* queries.insertBoardCiPassRow(started);
          if (action.kind === "step") {
            yield* queries.updateBoardCiPassStepRow({
              runId: action.runId,
              index: action.index,
              step: encodeBoardCiPassStepJson(action.step),
            });
          }
        });
        yield* ciWrites.pipe(
          Effect.mapError(toPersistenceSqlError("BoardCardsProjection.ci:write")),
        );
        if (activity !== null) {
          yield* recordActivity({
            event,
            cardId: event.payload.cardId,
            kind: activity.kind,
            payload: {
              ...(activity.ciOutcome === undefined ? {} : { ciOutcome: activity.ciOutcome }),
              ...(activity.ciStepName === undefined ? {} : { ciStepName: activity.ciStepName }),
              ...(activity.ciFixAttempts === undefined
                ? {}
                : { ciFixAttempts: activity.ciFixAttempts }),
            },
            threadId: null,
          });
        }
        return;
      }

      case "board.card-decisions-recorded":
        // Table-only: the log never rides the read model.
        yield* Effect.forEach(event.payload.decisions, queries.insertBoardCardDecisionRow, {
          discard: true,
        }).pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.decisions:insert")));
        return;

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
      // The auto-merge hold rides `board_cards` too, and writes
      // NO rail row of its own: eight rungs would be eight rows saying the
      // same thing. The reactor rails the refusal ONCE, through
      // `card-merge-refused`, at the moment the ladder actually stops.
      case "board.card-auto-merge-hold-recorded":
      // Worktree lifecycle: every payload carries the whole card, so
      // the persisted projection is the same idempotent upsert — the worktree
      // column rides `board_cards` with the rest of the aggregate.
      case "board.card-worktree-provisioning":
      case "board.card-worktree-ready":
        yield* upsertCard(event.payload.card);
        return;

      case "board.card-worktree-reclaimed":
        yield* upsertCard(event.payload.card);
        // A removal is disk given back, and a kept worktree is a
        // card holding disk it is finished with — both are worth a row. A
        // REPEATED refusal is not: the decider marks only a changed reason.
        if (event.payload.outcome === "removed") {
          yield* recordActivity({
            event,
            cardId: event.payload.cardId,
            kind: "card-worktree-removed",
            payload: {
              ...(event.payload.forced ? { forced: true } : {}),
              ...(event.payload.hookWarning === undefined
                ? {}
                : { hookWarning: event.payload.hookWarning }),
            },
            threadId: null,
          });
        } else if (event.payload.reasonChanged && event.payload.reason !== null) {
          yield* recordActivity({
            event,
            cardId: event.payload.cardId,
            kind: "card-worktree-kept",
            payload: { detail: event.payload.reason },
            threadId: null,
          });
        }
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
      case "board.stage-updated":
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
        // A new round budget or a stop changes what the loop's counts MEAN,
        // so the cache is refolded against the updated card.
        yield* refreshReviewSummary(event.payload.card);
        // Bodies live only in this table; absent means unchanged.
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
        // An incremental edit is railed, so a card whose brief or
        // dependencies changed under it says who did it and how. Whole-value
        // edits carry no summary and stay off the rail.
        if (event.payload.edit !== undefined) {
          yield* recordActivity({
            event,
            cardId: event.payload.cardId,
            kind: "card-edited",
            payload: event.payload.edit,
            threadId: null,
          });
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
        // Only a review step moves the summary. The decider folds it onto the event, so
        // the cache matches the client's `card-review` delta; the recompute covers older
        // events that carry none.
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
        if (event.payload.planReviewFinished !== undefined) {
          yield* recordActivity({
            event,
            cardId: event.payload.cardId,
            kind: "plan-review-finished",
            payload: {
              stepId: event.payload.completion.stepId,
              planReviewRounds: event.payload.planReviewFinished.rounds,
              planReviewRoundsRun: event.payload.planReviewFinished.roundsRun,
              planReviewConverged: event.payload.planReviewFinished.converged,
            },
            threadId: event.payload.completion.threadId,
            activityIdSuffix: ":plan-review-finished",
          });
        }
        return;

      // Plan review: on the rail, so the card shows a review happened.
      case "board.plan-review-started":
        yield* upsertStepState(event.payload.state);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "plan-review-started",
          payload: {
            stepId: event.payload.state.stepId,
            ...(event.payload.state.planReviewRounds === undefined
              ? {}
              : { planReviewRounds: event.payload.state.planReviewRounds }),
          },
          threadId: event.payload.state.threadId,
        });
        return;

      case "board.plan-review-stopped":
        yield* upsertStepState(event.payload.state);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "plan-review-stopped",
          payload: { stepId: event.payload.stepId },
          threadId: event.payload.threadId,
        });
        return;

      case "board.plan-review-rounds-changed":
        yield* upsertStepState(event.payload.state);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "plan-review-rounds-changed",
          payload: {
            stepId: event.payload.state.stepId,
            ...(event.payload.state.planReviewRounds === undefined
              ? {}
              : { planReviewRounds: event.payload.state.planReviewRounds }),
          },
          threadId: event.payload.state.threadId,
        });
        return;

      // The override is recorded on the step row and nothing else:
      // the step is still queued, and the activity rail keeps its nine curated
      // kinds. What the user sees change is the card starting.
      case "board.card-step-force-start-requested":
        yield* upsertStepState(event.payload.state);
        return;

      case "board.card-step-awaiting-input":
        yield* upsertStepState(event.payload.state);
        // The rail's `card-input-requested` row. Sourced from the step
        // parking on the gate rather than from the deleted `board_request_input`
        // tool, so it fires for EVERY input request — including the ordinary
        // question an agent asks without calling any board tool at all.
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-input-requested",
          payload: {
            stepId: event.payload.state.stepId,
            // `stepLabel` is null on a stage with no steps, so
            // the rail names the STAGE instead — "asked for input on Planning"
            // rather than dropping the name. The key is `optionalKey`, so when
            // neither name exists it is omitted rather than set to undefined.
            ...boardActivityStepLabel(event.payload.state),
          },
          threadId: event.payload.state.threadId,
        });
        return;

      // A background-wait check-in is on the rail: it is the board
      // talking to the agent while nothing else on the card moves, and the
      // rail collapses repeats, so a long wait still reads as one row.
      case "board.card-step-checked-in":
        yield* upsertStepState(event.payload.state);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-step-checked-in",
          payload: {
            stepId: event.payload.state.stepId,
            ...boardActivityStepLabel(event.payload.state),
          },
          threadId: event.payload.state.threadId,
        });
        return;

      case "board.card-step-selected":
      case "board.card-step-admitted":
      // A human pausing a step stays off the rail for the same reason:
      // the card face says `Paused` and the Resume button is right there, so a
      // row per stop-and-start would only crowd out the nine curated kinds.
      case "board.card-step-paused":
      case "board.card-step-recovered":
      case "board.card-step-settled":
      case "board.card-step-retuned":
      // A human steering a running step stays off the rail too: it is
      // the supervisor's own nudge bookkeeping, and the human is looking at the
      // thread they just typed into.
      case "board.card-step-steered":
        // Each payload carries the whole step state, so this is one idempotent upsert.
        // Step state never reaches the Activity rail, which it would flood.
        yield* upsertStepState(event.payload.state);
        return;

      case "board.plans-proposed":
        // The split justification rides the card row (t3o card 11), mirroring
        // the in-memory projector's targeted field set — the event carries no
        // card to upsert.
        yield* queries
          .updateBoardCardSplitRationaleRow({
            cardId: event.payload.cardId,
            splitRationale: event.payload.splitRationale,
            splitRecommendation: event.payload.splitRecommendation ?? null,
          })
          .pipe(
            Effect.mapError(toPersistenceSqlError("BoardCardsProjection.splitRationale:query")),
          );
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
        // Children and the parent's move ride their own events;
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

      case "board.card-base-ref-recorded":
        // A retarget rebase landed and moved the recorded base.
        // Detail-only, and the rail says nothing: the sync step's own
        // completion row already covers the moment.
        yield* upsertCard(event.payload.card);
        return;

      case "board.card-worker-pinned":
        // A human choosing where the card runs earns its row.
        yield* upsertCard(event.payload.card);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-worker-pinned",
          payload: { workerId: event.payload.workerId },
          threadId: null,
        });
        return;

      case "board.card-placed":
        // Placement at spawn is the thread's own row's business: each thread
        // link already names its worker, so the rail says nothing here.
        yield* upsertCard(event.payload.card);
        return;

      case "board.card-worker-move-recorded":
        // Every step of a move is a row: checked and started, old
        // worktree retired, new one ready, or provisioning failed.
        yield* upsertCard(event.payload.card);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-worker-moved",
          payload: {
            movePhase: event.payload.step.phase,
            fromWorkerId: event.payload.move.fromWorkerId,
            toWorkerId: event.payload.move.toWorkerId,
            ...(event.payload.step.phase === "failed" ? { detail: event.payload.step.error } : {}),
            // A force-move's start checked nothing.
            ...(event.payload.step.phase === "start" && event.payload.step.force === true
              ? { forced: true }
              : {}),
            ...(event.payload.step.phase === "abandoned" && event.payload.step.worktreePath !== null
              ? { detail: event.payload.step.worktreePath }
              : {}),
          },
          threadId: null,
        });
        return;

      case "board.card-worker-removal":
        // The one board-driven placement change earns its row,
        // and so do the hold it leaves and the re-add that ends it.
        yield* upsertCard(event.payload.card);
        yield* recordActivity({
          event,
          cardId: event.payload.cardId,
          kind: "card-worker-removal",
          payload: {
            workerId: event.payload.workerId,
            detail: event.payload.workerLabel,
            removalOutcome: event.payload.outcome,
          },
          threadId: null,
        });
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

      // T3o: the worker registry. No card, so no activity row; what
      // removal does to the cards on a worker belongs to D22's fallback.
      case "board.worker-registered":
        yield* upsertWorker(event.payload.worker);
        return;

      case "board.worker-removed":
        yield* deleteWorker(event.payload.workerId);
        return;

      case "board.default-worker-set":
        yield* writeDefaultWorker(event.payload.workerId);
        return;

      case "board.project-stage-config-set":
        // Config row (059) plus any stage rows a legacy payload moved.
        yield* queries
          .upsertBoardProjectStageConfigRow({
            projectId: event.payload.projectId,
            config: event.payload.config,
            updatedAt: event.occurredAt,
          })
          .pipe(
            Effect.mapError(toPersistenceSqlError("BoardCardsProjection.projectStageConfig:query")),
          );
        for (const stage of event.payload.upserts) yield* upsertStage(stage);
        for (const stageId of event.payload.deletedStageIds) yield* removeStage(stageId);
        return;

      default: {
        event satisfies never;
        return;
      }
    }
  });

  return { applyBoardEvent, applyTodoSignal };
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
function loadBoardState(
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
    queries.listBoardWorkerRows(),
    queries.findBoardDefaultWorkerRow(),
    queries.listBoardProjectStageConfigRows(),
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
        workerRows,
        defaultWorkerRow,
        projectStageConfigRows,
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
          .map((row): BoardStageDefinition => ({
            stageId: row.stageId,
            label: row.label,
            role: row.role,
            orderKey: row.orderKey,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            projectId: row.projectId,
            ...boardStageRowDefault(row),
          }))
          .sort(compareBoardStages);
        // An unused board (no cards, seed catalogue and stages) reports the slice as
        // absent, matching a from-empty replay.
        if (
          cardRows.length === 0 &&
          boardLabelsAreSeedOnly(labels) &&
          boardStagesAreSeedOnly(stages) &&
          // A board with only workers registered is not unused.
          workerRows.length === 0 &&
          Option.isNone(defaultWorkerRow) &&
          // Nor is one with only a project's t3o.json reconciled.
          projectStageConfigRows.length === 0
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
            ...linkWorker(row),
            ...linkRetired(row),
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
        // Omitted, not empty, when no event produced them, so rehydration equals a
        // from-empty replay.
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
          .map((row): BoardCardStepState => ({
            cardId: row.cardId,
            stepId: row.stepId,
            stepLabel: row.stepLabel,
            stageLabel: row.stageLabel,
            attempt: row.attempt,
            stallCount: row.stallCount,
            stageEntryRecoveries: row.stageEntryRecoveries,
            lastNudgeAt: row.lastNudgeAt,
            prompt: row.prompt,
            providerInstanceId: row.providerInstanceId,
            model: row.model,
            mode: row.mode,
            runtimeMode: resolveStoredStepRuntimeMode(row.runtimeMode, row.mode),
            ...stepModelOptionsPatch(row.modelOptions),
            baseTipAtRoundStart: row.baseTipAtRoundStart,
            lastError: row.lastError,
            // A NULL column reads as `question`: pre-034 rows
            // could only have parked through the structured-question path.
            awaitingReason: row.awaitingReason ?? "question",
            humanTurnAt: row.humanTurnAt,
            // A NULL column reads as `gave-up`: pre-041 rows
            // could only have stalled through recovery giving up.
            stalledReason: row.stalledReason ?? "gave-up",
            retryAt: row.retryAt,
            ...(row.planReviewStartedAt === null
              ? {}
              : { planReviewStartedAt: row.planReviewStartedAt }),
            ...(row.planReviewRounds === null ? {} : { planReviewRounds: row.planReviewRounds }),
            humanInLoop: row.humanInLoop !== 0,
            maxAttempts: row.maxAttempts,
            timeoutMs: row.timeoutMs,
            threadId: row.threadId,
            status: row.status,
            slotHeld: row.slotHeld !== 0,
            forceStart: row.forceStart !== 0,
            queuedBy: row.queuedBy,
            startedAt: row.startedAt,
            updatedAt: row.updatedAt,
          }))
          .sort(compareBoardStepStates);
        const plans = planRows.map(rowToBoardPlan).sort(compareBoardPlans);
        // The worker registry: absent when empty, and the default
        // absent when it is `local`, matching the projector's fold.
        const workers = [...workerRows].sort(compareBoardWorkers);
        const defaultWorkerId = Option.getOrNull(
          Option.map(defaultWorkerRow, (row) => row.workerId),
        );
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
          ...(workers.length > 0 ? { workers } : {}),
          ...(projectStageConfigRows.length > 0
            ? { projectStageConfigs: projectStageConfigsFromRows(projectStageConfigRows) }
            : {}),
          ...(defaultWorkerId !== null && defaultWorkerId !== BOARD_LOCAL_WORKER_ID
            ? { defaultWorkerId }
            : {}),
          nextCardNumberByProject: Object.fromEntries(
            counterRows.map((row) => [row.projectId, row.maxCardNumber + 1]),
          ),
        };
      },
    ),
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.list:query")),
  );
}

// Both enrichers omit the board data when no card was ever created, so
// rehydration matches a from-empty replay and shell payloads stay small.
// Consumers read through `board ?? EMPTY_BOARD_STATE` / `cards ?? []`.

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
 * Bounded `BoardCardShell`s for the board snapshot: a narrow SQL
 * projection of the live (non-archived) cards. Archived cards leave it
 * but stay in the table and the read model, so unarchive can bring them back.
 */
function boardShellCards(
  queries: BoardCardQueries,
): Effect.Effect<ReadonlyArray<BoardCardShell>, ProjectionRepositoryError> {
  return Effect.all([
    queries.listBoardCardShellRows(),
    queries.listLiveBoardCardThreadLinkRows(),
    queries.listBoardCardLabelRows(),
    // The one step-state field on the bounded shell: a card is
    // `queued` when its live step is holding for a slot. One row per card,
    // so a small map keyed by card id.
    queries.listBoardCardStepStateRows(),
  ]).pipe(
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shell:query")),
    Effect.map(([cardRows, linkRows, cardLabelRows, stepStateRows]) => {
      const linksByCard = new Map<BoardCardId, BoardCardThreadLink[]>();
      for (const row of linkRows) {
        const links = linksByCard.get(row.cardId) ?? [];
        links.push({
          threadId: row.threadId,
          role: row.role,
          linkedAt: row.linkedAt,
          tombstonedAt: row.tombstonedAt,
          ...linkWorker(row),
          ...linkRetired(row),
        });
        linksByCard.set(row.cardId, links);
      }
      const labelsByCard = groupCardLabels(cardLabelRows);
      const queuedByCard = new Set<BoardCardId>();
      const queueReasonByCard = new Map<BoardCardId, BoardStepQueuedBy>();
      const stalledByCard = new Set<BoardCardId>();
      const runningByCard = new Set<BoardCardId>();
      const heldByCard = new Set<BoardCardId>();
      const awaitingByCard = new Map<BoardCardId, BoardCardStepParkedReason>();
      const stallByCard = new Map<
        BoardCardId,
        {
          readonly stalledReason: BoardCardStepStalledReason;
          readonly retryAt: string | null;
        }
      >();
      const conflictFixByCard = new Set<BoardCardId>();
      const checksFixByCard = new Set<BoardCardId>();
      for (const row of stepStateRows) {
        if (row.status === "queued") queuedByCard.add(row.cardId);
        // Which limit holds it, the same field `card-queued` carries.
        if (row.status === "queued" && row.queuedBy !== null) {
          queueReasonByCard.set(row.cardId, row.queuedBy);
        }
        // The second step-state field on the bounded shell: a card
        // is `stalled` when recovery gave up on its live step.
        if (row.status === "stalled") stalledByCard.add(row.cardId);
        // The durable "being worked" flag: the executor's step is admitted and
        // running, so the card dot stays lit across a loop stage's per-phase
        // thread spin-up gaps rather than only while a single thread is mid-turn.
        if (row.status === "running") runningByCard.add(row.cardId);
        // Settled and still sitting on it: only a human moves it on. `stalled` has its
        // own louder flag.
        if (isBoardTerminalStepStatus(row.status)) heldByCard.add(row.cardId);
        // Derived through the same definition as the projector's deltas, so the
        // snapshot and the live stream never disagree.
        const parked = boardStepParkedReason({
          status: row.status,
          awaitingReason: row.awaitingReason ?? "question",
        });
        if (parked !== null) awaitingByCard.set(row.cardId, parked);
        // Why the step stalled and when it next tries. Read off
        // the persisted row through the same rule the delta uses, so a
        // reconnect renders identically to the live stream.
        if (row.status === "stalled") {
          stallByCard.set(row.cardId, {
            stalledReason: row.stalledReason ?? "gave-up",
            retryAt: row.retryAt,
          });
        }
        // Read off the persisted step label, so a reconnect or restart mid-fix renders
        // the same as the live stream.
        if (isBoardConflictFixLive(row)) conflictFixByCard.add(row.cardId);
        if (isBoardChecksFixLive(row)) checksFixByCard.add(row.cardId);
      }
      return [...cardRows].sort(compareBoardCardShellRows).map((row) => {
        const links = linksByCard.get(row.cardId) ?? [];
        const activeThreadId = activeBoardCardThreadId(links);
        // Thread-derived fields rest at "none": the client derives them from
        // the thread shells it holds, across every live-linked thread.
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
          // The client scopes the sub-board and derives a parent's plan pips off this
          // key; without it every child looks top-level after a reconnect.
          parentCardId: row.parentCardId,
          scheduledStartAt: row.scheduledStartAt,
          autoPlanSetting: settingFromInt(row.autoPlanSetting),
          autoBuildSetting: settingFromInt(row.autoBuildSetting),
          autoMergeSetting: settingFromInt(row.autoMergeSetting),
          autoPlanPending: row.autoPlanPending !== 0,
          autoMergeHeldSince: row.autoMergeHeldSince,
          autoMergeGaveUp: row.autoMergeGaveUp !== 0,
          prDraft: row.prDraft !== 0,
          worktreeReady: row.worktreeReady !== 0,
          worktreeKeptReason: row.worktreeKeptReason,
          workerId: row.workerId,
          workerMove:
            row.workerMoveStatus === null || row.workerMoveTo === null
              ? null
              : { status: row.workerMoveStatus, toWorkerId: row.workerMoveTo },
          placementOrphaned:
            row.orphanedWorkerLabel === null ? null : { workerLabel: row.orphanedWorkerLabel },
          ci: row.ci,
          ciLastOutcome: row.ciLastOutcome,
          group: boardCardGroupFromRow(row),
          queuedBy: queueReasonByCard.get(row.cardId) ?? null,
          // Carried UNRESOLVED. The renderer settles the outcome
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
          ...stallByCard.get(row.cardId),
          stepConflictFix: conflictFixByCard.has(row.cardId),
          stepChecksFix: checksFixByCard.has(row.cardId),
        });
      });
    }),
  );
}

/** Live card→thread links and their cached todo summaries: their
    own array, never denormalised onto `BoardCardShell`, whose 1280-byte budget
    is left untouched. */
function boardShellCardThreads(
  queries: BoardCardQueries,
): Effect.Effect<ReadonlyArray<BoardCardThreadShell>, ProjectionRepositoryError> {
  return queries.listBoardCardThreadShellRows().pipe(
    Effect.map((rows) => rows.map(toBoardCardThreadShell)),
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shellCardThreads:query")),
  );
}

/**
 * The archive is opened on demand, so it stays off the live snapshot and delta
 * stream. Newest first; thread state stays at rest to avoid a query per open.
 */
function boardArchivedShellCards(
  queries: BoardCardQueries,
): Effect.Effect<ReadonlyArray<BoardCardShell>, ProjectionRepositoryError> {
  return Effect.all([
    queries.listArchivedBoardCardShellRows(),
    queries.listBoardCardLabelRows(),
  ]).pipe(
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.archivedShell:query")),
    Effect.map(([cardRows, cardLabelRows]) => {
      const labelsByCard = groupCardLabels(cardLabelRows);
      return [...cardRows]
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
            scheduledStartAt: row.scheduledStartAt,
            autoPlanSetting: settingFromInt(row.autoPlanSetting),
            autoBuildSetting: settingFromInt(row.autoBuildSetting),
            autoMergeSetting: settingFromInt(row.autoMergeSetting),
            autoPlanPending: row.autoPlanPending !== 0,
            autoMergeHeldSince: row.autoMergeHeldSince,
            autoMergeGaveUp: row.autoMergeGaveUp !== 0,
            prDraft: row.prDraft !== 0,
            worktreeReady: row.worktreeReady !== 0,
            worktreeKeptReason: row.worktreeKeptReason,
            workerId: row.workerId,
            workerMove:
              row.workerMoveStatus === null || row.workerMoveTo === null
                ? null
                : { status: row.workerMoveStatus, toWorkerId: row.workerMoveTo },
            placementOrphaned:
              row.orphanedWorkerLabel === null ? null : { workerLabel: row.orphanedWorkerLabel },
            ci: row.ci,
            ciLastOutcome: row.ciLastOutcome,
            group: boardCardGroupFromRow(row),
            archivedAt: row.archivedAt,
            activeThreadId: null,
          }),
        );
    }),
  );
}

/**
 * The label catalogue rides the board snapshot ONCE: N labels for the
 * whole board, never denormalised per card. Includes tombstoned labels so a
 * client can render a retired-label chip muted; the picker filters them.
 * Sorted canonically for a stable picker order.
 */
function boardShellLabels(
  queries: BoardCardQueries,
): Effect.Effect<ReadonlyArray<BoardLabel>, ProjectionRepositoryError> {
  return queries.listBoardLabelRows().pipe(
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shellLabels:query")),
    Effect.map((rows) =>
      rows
        .map((row) => ({
          labelId: row.labelId,
          name: row.name,
          colour: row.colour,
          deletedAt: row.deletedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        }))
        .sort(compareBoardLabels),
    ),
  );
}

/** Project id → resolved config, in project-id order so rehydration and a
    from-empty replay build the same record. */
function projectStageConfigsFromRows(
  rows: ReadonlyArray<{ readonly projectId: ProjectId; readonly config: BoardProjectStageConfig }>,
): Record<ProjectId, BoardProjectStageConfig> {
  return Object.fromEntries(
    [...rows]
      .sort((left, right) =>
        left.projectId < right.projectId ? -1 : left.projectId > right.projectId ? 1 : 0,
      )
      .map((row) => [row.projectId, row.config]),
  );
}

/** Per-project deltas for the shell, shell-sized; absent when none. */
function boardShellProjectStageConfigs(
  queries: BoardCardQueries,
): Effect.Effect<
  Record<ProjectId, BoardProjectStageConfigShell> | null,
  ProjectionRepositoryError
> {
  return queries.listBoardProjectStageConfigRows().pipe(
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shellProjectStageConfigs:query")),
    Effect.map((rows) =>
      rows.length === 0
        ? null
        : Object.fromEntries(
            Object.entries(projectStageConfigsFromRows(rows)).map(([projectId, config]) => [
              projectId,
              boardProjectStageConfigShell(config),
            ]),
          ),
    ),
  );
}

/** A stage row's `defaultForProjects`: absent when the column is NULL, so a
    row written before T3O-49 rehydrates exactly as its replayed payload. */
function boardStageRowDefault(row: {
  readonly defaultForProjects: number | null;
}): Pick<BoardStageDefinition, "defaultForProjects"> {
  return row.defaultForProjects === null
    ? {}
    : { defaultForProjects: row.defaultForProjects === 1 };
}

/** The user-defined stage list, so the board reads column order and
    labels from it. */
function boardShellStages(
  queries: BoardCardQueries,
): Effect.Effect<ReadonlyArray<BoardStageDefinition>, ProjectionRepositoryError> {
  return queries.listBoardStageRows().pipe(
    Effect.mapError(toPersistenceSqlError("BoardCardsProjection.shellStages:query")),
    Effect.map((rows) =>
      rows
        .map((row): BoardStageDefinition => ({
          stageId: row.stageId,
          label: row.label,
          role: row.role,
          orderKey: row.orderKey,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          projectId: row.projectId,
          ...boardStageRowDefault(row),
        }))
        .sort(compareBoardStages),
    ),
  );
}

/**
 * The log head is read first, so the tables are at least as new as
 * `snapshotSequence`; replayed deltas they already hold are idempotent.
 */
const loadBoardShellSnapshot: (
  queries: BoardCardQueries,
  latestSequence: Effect.Effect<number, ProjectionRepositoryError>,
) => Effect.Effect<BoardShellSnapshot, ProjectionRepositoryError> = Effect.fn(
  "BoardCardsProjection.loadBoardShellSnapshot",
)(function* (
  queries: BoardCardQueries,
  latestSequence: Effect.Effect<number, ProjectionRepositoryError>,
) {
  const snapshotSequence = yield* latestSequence;
  const [cards, labels, stages, cardThreads, projectStageConfigs] = yield* Effect.all([
    boardShellCards(queries),
    boardShellLabels(queries),
    boardShellStages(queries),
    boardShellCardThreads(queries),
    boardShellProjectStageConfigs(queries),
  ]);
  return {
    snapshotSequence,
    cards,
    labels,
    stages,
    cardThreads,
    ...(projectStageConfigs === null ? {} : { projectStageConfigs }),
  };
});

/**
 * Full detail for one open card, or null if it never existed. Archived cards
 * resolve too, so an archive does not kill an open viewer. A maker because the
 * reader runs on every board event for a subscribed card.
 */
function makeBoardCardDetailLoader(
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
      queries.listBoardCardDecisionRowsForCard(cardId),
      queries.listBoardCardGroupDependencyRefRows(cardId),
      queries.listBoardCiPassRowsForCard(cardId),
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
          decisionRows,
          groupDependencyRows,
          ciPassRows,
        ]) => {
          if (Option.isNone(cardRow)) return null;
          const links = sortBoardCardThreadLinks(
            linkRows.map((row) => ({
              threadId: row.threadId,
              role: row.role,
              linkedAt: row.linkedAt,
              tombstonedAt: row.tombstonedAt,
              ...linkWorker(row),
              ...linkRetired(row),
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
          // Plans with their bodies, in the card's ordinal order — the
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
            groupDependencies: groupDependencyRows,
            dependents: dependentRows,
            hasPlan: plans.length > 0,
            plans,
            // Materialised children in plan order, archived included
            // — the pane strikes them through rather than losing the pairing.
            children: childRows,
            // The card's completions in completion order, from the
            // per-card step query — the same rows the read model's
            // `stepCompletions` slice is built from — sorted so the modal renders
            // review rounds in the order they landed.
            stepCompletions: [...stepRows].sort(compareBoardStepCompletions),
            // The Activity rail: already chronological from SQL,
            // and live because `board.subscribeCard` re-emits the whole detail on
            // every board event for this card.
            activity: activityRows.map(toBoardCardActivityEntry),
            ciPasses: ciPassRows,
            // Why the live step stopped, or null when it is
            // healthy or absent — the failure banner's text.
            stepError: Option.getOrNull(stepErrorRow)?.lastError ?? null,
            ...(() => {
              const step = Option.getOrNull(stepErrorRow);
              return step === null ||
                step.planReviewStartedAt === null ||
                step.planReviewRounds === null ||
                isBoardTerminalStepStatus(step.status)
                ? {}
                : {
                    planReviewStarted: {
                      startedAt: step.planReviewStartedAt,
                      rounds: step.planReviewRounds,
                    },
                  };
            })(),
            decisions: decisionRows,
            // Filled below for a sub-board child; a top-level card has no
            // parent to inherit from and keeps the null.
            parentModelOverrides: null,
            parentMergeStrategy: null,
          };
        },
      ),
      // A child inheriting its parent's model overrides needs a second lookup: the
      // parent id is only known once the card row has resolved.
      Effect.filterOrElse(
        (detail) => detail === null || detail.card.parentCardId === null,
        (detail) => {
          const child = detail!;
          return queries.findBoardCardRow(child.card.parentCardId!).pipe(
            Effect.map((parentRow) => ({
              ...child,
              parentModelOverrides: Option.isNone(parentRow)
                ? null
                : parentRow.value.modelOverrides,
              parentMergeStrategy: Option.isNone(parentRow) ? null : parentRow.value.mergeStrategy,
            })),
          );
        },
      ),
      Effect.mapError(toPersistenceSqlError("BoardCardsProjection.detail:query")),
    );
}

/**
 * A card's activity log for `board_get_card_context`, in chronological
 * order. Table-only data: the read model never holds activity bodies.
 */
function makeBoardCardActivityLoader(
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
 * One plan's body from `board_plans` for `board_get_plan` / `board_write_plan`;
 * null when the plan does not exist. The body lives only in the
 * table; the plan metadata rides the read model.
 */
function makeBoardPlanBodyLoader(
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
 * The board's read side: every board query, over the board tables
 * alone — thread reads go through the thread gateway. Served by the
 * `BoardQueries` service; this factory is what it is built from, and what a
 * test builds directly when it wants the real SQL behind a double.
 */
export interface BoardQueriesShape {
  /** The board slice rehydrated from the board tables, or null for a board
      no event has ever touched — what the board engine boots from. */
  readonly loadBoardState: () => Effect.Effect<BoardState | null, ProjectionRepositoryError>;
  /** The board's bounded summary for `board.subscribeBoard`. */
  readonly boardShellSnapshot: () => Effect.Effect<BoardShellSnapshot, ProjectionRepositoryError>;
  /** Archived card shells for the archive page, newest archive first. */
  readonly boardArchivedCards: () => Effect.Effect<
    ReadonlyArray<BoardCardShell>,
    ProjectionRepositoryError
  >;
  /** Full detail for `board.subscribeCard`; null when the card does not exist. */
  readonly boardCardDetail: (
    cardId: BoardCardId,
  ) => Effect.Effect<BoardCardDetail | null, ProjectionRepositoryError>;
  /** A card's activity log for `board_get_card_context`. */
  readonly boardCardActivity: (
    cardId: BoardCardId,
  ) => Effect.Effect<ReadonlyArray<BoardCardActivityEntry>, ProjectionRepositoryError>;
  /** One card's brief body, null when it has none — the one row an
      incremental brief edit is decided against. */
  readonly boardCardBrief: (
    cardId: BoardCardId,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;
  /** A card's decision log, oldest first. */
  readonly boardCardDecisions: (
    cardId: BoardCardId,
  ) => Effect.Effect<ReadonlyArray<BoardCardDecision>, ProjectionRepositoryError>;
  /** One plan's body for `board_get_plan`; null when absent. */
  readonly boardPlanBody: (
    planId: BoardPlanId,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;
  /** One card's live links + cached todo summaries — the shell
      delta payload, and what `board_get_card_context` hands a restarted agent. */
  readonly boardCardThreads: (
    cardId: BoardCardId,
  ) => Effect.Effect<ReadonlyArray<BoardCardThreadShell>, ProjectionRepositoryError>;
  /** Every card's live links + cached todo summaries — the snapshot's
      `cardThreads` slice, which a resume-by-replay re-sends because todo
      changes are not in the board log. */
  readonly boardAllCardThreads: () => Effect.Effect<
    ReadonlyArray<BoardCardThreadShell>,
    ProjectionRepositoryError
  >;
  /** The card a live-linked thread belongs to, or null — how a thread-shaped
      shell refetch finds the card whose `card-threads` delta it must emit. */
  readonly boardCardIdForThread: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardCardId | null, ProjectionRepositoryError>;
  /** The worker a linked thread lives on — tombstoned links
      included, since a deleted thread still answers where it was — or null
      for a thread no card links. */
  readonly boardThreadWorker: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardWorkerId | null, ProjectionRepositoryError>;
  /** One thread's cached todo row: the supervisor reads the
      stall-reset signal from it, so `recoveryDecision` stays pure with no SQL
      of its own. Null when the thread has no list. */
  readonly boardThreadTodo: (
    threadId: ThreadId,
  ) => Effect.Effect<BoardThreadTodoState | null, ProjectionRepositoryError>;
  /** Drops todo rows whose link or card is gone or whose thread is not live.
      A row written after `listedAt` is spared: the live list may have missed it. */
  readonly boardSweepThreadTodos: (
    liveThreadIds: ReadonlyArray<ThreadId>,
    listedAt: string,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/** What the supervisor reads off one cached todo row. */
export interface BoardThreadTodoState {
  readonly doneCount: number;
  readonly totalCount: number;
  /** When the list last ADVANCED — `done_count` rose or the in-progress item
      changed. Null when it has never advanced. */
  readonly advancedAt: string | null;
}

export function makeBoardQueries(sql: SqlClient.SqlClient): BoardQueriesShape {
  const queries = makeBoardCardQueries(sql);
  const eventStore = makeBoardEventStore(sql);
  /* The cache is a projection, so a leaked row is invisible until it resurfaces
     on a reused id; sweeping at boot is the cheap, total answer. The live
     thread set arrives as one JSON array parameter. */
  const sweepOrphans = SqlSchema.void({
    Request: Schema.Struct({ liveThreadIdsJson: Schema.String, listedAt: Schema.String }),
    execute: ({ liveThreadIdsJson, listedAt }) => sql`
      DELETE FROM boards.board_thread_todos
      WHERE thread_id NOT IN (
              SELECT thread_id FROM boards.board_card_thread_links
              WHERE tombstoned_at IS NULL AND retired_at IS NULL
            )
         OR card_id NOT IN (SELECT card_id FROM boards.board_cards WHERE archived_at IS NULL)
         OR (
              updated_at < ${listedAt}
              AND thread_id NOT IN (SELECT value FROM json_each(${liveThreadIdsJson}))
            )
    `,
  });
  return {
    loadBoardState: () => loadBoardState(queries),
    boardShellSnapshot: () => loadBoardShellSnapshot(queries, eventStore.latestSequence),
    boardArchivedCards: () => boardArchivedShellCards(queries),
    // Board-only detail reader for board.subscribeCard.
    boardCardDetail: makeBoardCardDetailLoader(queries),
    // Board-only readers for the MCP context / plan tools.
    boardCardActivity: makeBoardCardActivityLoader(queries),
    boardPlanBody: makeBoardPlanBodyLoader(queries),
    // A card's decision log: ancestor context for planning agents.
    boardCardDecisions: (cardId) =>
      queries
        .listBoardCardDecisionRowsForCard(cardId)
        .pipe(Effect.mapError(toPersistenceSqlError("BoardCardsProjection.decisions:query"))),
    // The brief alone, for the engine's pre-decide read.
    boardCardBrief: (cardId) =>
      queries
        .findBoardCardBodyRow({ cardId, kind: BOARD_CARD_BRIEF_BODY_KIND })
        .pipe(
          Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.body })),
          Effect.mapError(toPersistenceSqlError("BoardCardsProjection.cardBrief:query")),
        ),
    // Board-only readers for thread todos: the shell delta, the MCP
    // context tool, the supervisor's stall signal, and the boot sweep.
    boardCardThreads: (cardId) =>
      queries.listBoardCardThreadShellRowsForCard(cardId).pipe(
        Effect.map((rows) => rows.map(toBoardCardThreadShell)),
        Effect.mapError(toPersistenceSqlError("BoardCardsProjection.cardThreads:query")),
      ),
    boardAllCardThreads: () => boardShellCardThreads(queries),
    boardCardIdForThread: (threadId) =>
      queries
        .findBoardCardIdForLiveThread(threadId)
        .pipe(
          Effect.map(Option.match({ onNone: () => null, onSome: (row) => row.cardId })),
          Effect.mapError(toPersistenceSqlError("BoardCardsProjection.cardForThread:query")),
        ),
    boardThreadWorker: (threadId) =>
      queries.findBoardThreadWorker(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (row): BoardWorkerId => row.workerId ?? BOARD_LOCAL_WORKER_ID,
          }),
        ),
        Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadWorker:query")),
      ),
    boardThreadTodo: (threadId) =>
      queries.findBoardThreadTodoRow(threadId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (row): BoardThreadTodoState => ({
              doneCount: row.doneCount,
              totalCount: row.totalCount,
              advancedAt: row.advancedAt,
            }),
          }),
        ),
        Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodo:query")),
      ),
    boardSweepThreadTodos: (liveThreadIds, listedAt) =>
      sweepOrphans({ liveThreadIdsJson: JSON.stringify(liveThreadIds), listedAt }).pipe(
        Effect.mapError(toPersistenceSqlError("BoardCardsProjection.threadTodoSweep:query")),
      ),
  };
}

/**
 * T3o new-card draft (T3O-26) — the pure half.
 *
 * Everything typed into the create dialog is kept while the dialog is closed,
 * so an accidental Esc, backdrop click or ✕ costs nothing. This module owns
 * the shape that is stored, the rule for what counts as a draft at all, and
 * the sanitising restore that maps a stored record back onto a board whose
 * projects, cards, labels and stages have moved on since. The store
 * (`boardCardDraftStore.ts`) only persists what these functions produce.
 *
 * Attachments are kept by REFERENCE, never by bytes: a staged file is already
 * a server-side pending upload (t3o-32, K6), so the draft holds the pending id
 * and the card claims it at create time exactly as an in-session row would.
 */
import {
  BOARD_CARD_ATTACHMENTS_MAX,
  BoardCardId,
  BoardLabelId,
  BoardStageId,
  ProjectId,
  type BoardLabel,
  type BoardStageDefinition,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { BoardPendingUpload } from "./boardAttachmentUpload";
import type { BoardStagedAttachment } from "./BoardBriefAttachments";

/**
 * How long a persisted attachment reference is worth restoring. Matches the
 * server's `PENDING_ATTACHMENT_MAX_AGE_MS` sweep: past it the pending upload
 * is gone, and a row that cannot be claimed is worse than no row.
 */
export const BOARD_CARD_DRAFT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** One staged file, by reference. Structurally `BoardPendingUpload`. */
export const BoardCardDraftAttachmentSchema = Schema.Struct({
  pendingAttachmentId: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["image", "file"]),
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
});

export const BoardCardDraftSchema = Schema.Struct({
  title: Schema.String,
  brief: Schema.String,
  stage: BoardStageId,
  projectId: Schema.NullOr(ProjectId),
  baseBranch: Schema.NullOr(Schema.String),
  labelIds: Schema.Array(BoardLabelId),
  dependsOn: Schema.Array(BoardCardId),
  scheduledStartAt: Schema.NullOr(Schema.String),
  attachments: Schema.Array(BoardCardDraftAttachmentSchema),
  /** Epoch millis of the last save — the clock the attachment TTL reads. */
  updatedAt: Schema.Number,
});
export type BoardCardDraft = typeof BoardCardDraftSchema.Type;

/** The draft minus its bookkeeping: exactly the dialog's own field state. */
export type BoardCardDraftFields = Omit<BoardCardDraft, "updatedAt">;

const decodeDraft = Schema.decodeUnknownOption(BoardCardDraftSchema);

/** A stored record, or null when it is corrupt, foreign-shaped or empty. */
export function parseBoardCardDraft(value: unknown): BoardCardDraft | null {
  const decoded = Option.getOrNull(decodeDraft(value));
  if (decoded === null) return null;
  return boardCardDraftHasContent(decoded) ? decoded : null;
}

/**
 * One draft per place a card can be created from: a child drafted inside a
 * sub-board must never resurface as a top-level card, and two servers must
 * not share one draft.
 */
export function boardCardDraftKey(
  environmentId: EnvironmentId,
  subBoardParentId: BoardCardId | null,
): string {
  return `${environmentId}:${subBoardParentId ?? "root"}`;
}

/**
 * What makes a draft worth keeping. Project, stage, label, base branch and
 * schedule are all defaults the dialog opens with — counting them would mean
 * merely opening the dialog leaves a draft that greets you forever.
 */
export function boardCardDraftHasContent(
  draft: Pick<BoardCardDraftFields, "title" | "brief" | "dependsOn" | "attachments">,
): boolean {
  return (
    draft.title.trim().length > 0 ||
    draft.brief.trim().length > 0 ||
    draft.dependsOn.length > 0 ||
    draft.attachments.length > 0
  );
}

/** Whether two drafts hold the same input, ignoring the save clock — the
    autosave writes on every keystroke and most of them change nothing. */
export function boardCardDraftContentEquals(left: BoardCardDraft, right: BoardCardDraft): boolean {
  return (
    left.title === right.title &&
    left.brief === right.brief &&
    left.stage === right.stage &&
    left.projectId === right.projectId &&
    left.baseBranch === right.baseBranch &&
    left.scheduledStartAt === right.scheduledStartAt &&
    sameIds(left.labelIds, right.labelIds) &&
    sameIds(left.dependsOn, right.dependsOn) &&
    left.attachments.length === right.attachments.length &&
    left.attachments.every(
      (attachment, index) =>
        attachment.pendingAttachmentId === right.attachments[index]?.pendingAttachmentId,
    )
  );
}

function sameIds(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** The subset of a card shell the dependency rules need. */
export interface BoardCardDraftCard {
  readonly cardId: BoardCardId;
  readonly projectId: ProjectId;
  readonly parentCardId?: BoardCardId | null | undefined;
}

export interface BoardCardDraftRestore {
  readonly fields: BoardCardDraftFields;
  /** Whether any stored attachment reference was dropped (expired or over
      the per-card cap), so the banner can say attachments went missing. */
  readonly droppedAttachments: boolean;
}

/**
 * Map a stored draft onto the board as it is now.
 *
 * The draft's own stage wins over the stage the dialog was opened on (the
 * brief, and the prototype): a card drafted for Planning is a Planning card,
 * and the picker in the identity row shows which stage it will land in. A
 * stage this scope no longer offers falls back to the opened one, and the
 * result is always clamped to the offered stages.
 *
 * Everything else is filtered against the live snapshot: a project that is
 * gone takes its dependencies and base branch with it (the same reasoning as
 * the dialog's project-switch handler), dependencies must still exist in the
 * chosen project and inside this sub-board, deleted labels drop out, and
 * attachment references past the pending-upload TTL are not offered back.
 */
export function restoreBoardCardDraft(input: {
  readonly draft: BoardCardDraft;
  readonly now: number;
  readonly cards: ReadonlyArray<BoardCardDraftCard>;
  readonly projectIds: ReadonlyArray<ProjectId>;
  readonly labels: ReadonlyArray<BoardLabel>;
  readonly stageOptions: ReadonlyArray<BoardStageDefinition>;
  readonly subBoardParentId: BoardCardId | null;
  readonly fallbackProjectId: ProjectId | null;
  readonly openedStage: BoardStageId;
  readonly maxAttachments?: number;
}): BoardCardDraftRestore {
  const { draft, stageOptions } = input;
  const offered = (stage: BoardStageId) =>
    stageOptions.some((definition) => definition.stageId === stage);
  const preferred = offered(draft.stage) ? draft.stage : input.openedStage;
  const stage = offered(preferred) ? preferred : (stageOptions[0]?.stageId ?? input.openedStage);

  const projectKnown = draft.projectId !== null && input.projectIds.includes(draft.projectId);
  const projectId = projectKnown ? draft.projectId : input.fallbackProjectId;

  const cardsById = new Map(input.cards.map((card) => [card.cardId as string, card]));
  const dependsOn = projectKnown
    ? draft.dependsOn.filter((cardId, index) => {
        if (draft.dependsOn.indexOf(cardId) !== index) return false;
        const card = cardsById.get(cardId as string);
        if (card === undefined || card.projectId !== projectId) return false;
        return input.subBoardParentId === null || card.parentCardId === input.subBoardParentId;
      })
    : [];

  const liveLabelIds = new Set(
    input.labels
      .filter((label) => label.deletedAt === null)
      .map((label) => label.labelId as string),
  );
  const labelIds = draft.labelIds.filter(
    (labelId, index) =>
      draft.labelIds.indexOf(labelId) === index && liveLabelIds.has(labelId as string),
  );

  const expired = input.now - draft.updatedAt > BOARD_CARD_DRAFT_ATTACHMENT_TTL_MS;
  const attachments = expired
    ? []
    : draft.attachments.slice(0, input.maxAttachments ?? BOARD_CARD_ATTACHMENTS_MAX);

  return {
    fields: {
      title: draft.title,
      brief: draft.brief,
      stage,
      projectId,
      // A branch named in another project's checkout means nothing here.
      baseBranch: projectKnown ? draft.baseBranch : null,
      labelIds,
      dependsOn,
      // Kept verbatim even when it is now in the past: the user set it, and
      // Create treats a past time exactly as it always has.
      scheduledStartAt: draft.scheduledStartAt,
      attachments,
    },
    droppedAttachments: attachments.length < draft.attachments.length,
  };
}

/**
 * Restored attachment rows: uploaded, with no local bytes. They carry no
 * `file`, so the strip renders them from a signed asset URL and offers no
 * retry — there is nothing left to retry with. Remove and attach again.
 */
export function stagedRowsFromUploads(
  uploads: ReadonlyArray<BoardPendingUpload>,
): ReadonlyArray<BoardStagedAttachment> {
  return uploads.map((upload) => ({
    id: upload.pendingAttachmentId,
    name: upload.name,
    type: upload.type,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    file: null,
    previewUrl: null,
    status: "uploaded",
    progress: 1,
    error: null,
    upload,
  }));
}

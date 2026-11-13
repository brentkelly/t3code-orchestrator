/**
 * The new-card draft, pure half: the stored shape, what counts as a draft, and
 * the sanitising restore. Attachments are kept by reference: a staged file is
 * already a server-side pending upload the card claims at create time.
 */
import {
  BOARD_CARD_ATTACHMENTS_MAX,
  BoardCardId,
  BoardCardPriority,
  BoardLabelId,
  BoardStageId,
  ProjectId,
  type BoardLabel,
  type BoardStageDefinition,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { BoardStagedAttachment } from "./BoardBriefAttachments";

/**
 * How long a persisted attachment reference is worth restoring. Matches the
 * server's `PENDING_ATTACHMENT_MAX_AGE_MS` sweep: past it the pending upload
 * is gone, and a row that cannot be claimed is worse than no row.
 */
export const BOARD_CARD_DRAFT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

/** One staged file, by reference: a `BoardPendingUpload` plus the moment it
    landed, which is the clock the server's sweep runs on. */
export const BoardCardDraftAttachmentSchema = Schema.Struct({
  pendingAttachmentId: Schema.String,
  name: Schema.String,
  type: Schema.Literals(["image", "file"]),
  mimeType: Schema.String,
  sizeBytes: Schema.Number,
  /** Epoch millis the upload landed — the same instant the server stamps the
      pending file's mtime, which is what `PENDING_ATTACHMENT_MAX_AGE_MS`
      sweeps against. Editing the draft afterwards must not extend it. */
  uploadedAt: Schema.Number,
});
export type BoardCardDraftAttachment = typeof BoardCardDraftAttachmentSchema.Type;

export const BoardCardDraftSchema = Schema.Struct({
  title: Schema.String,
  brief: Schema.String,
  stage: BoardStageId,
  projectId: Schema.NullOr(ProjectId),
  baseBranch: Schema.NullOr(Schema.String),
  labelIds: Schema.Array(BoardLabelId),
  dependsOn: Schema.Array(BoardCardId),
  scheduledStartAt: Schema.NullOr(Schema.String),
  /** Decodes to normal on drafts saved before priority existed. */
  priority: BoardCardPriority.pipe(Schema.withDecodingDefault(Effect.succeed("normal" as const))),
  attachments: Schema.Array(BoardCardDraftAttachmentSchema),
});
/** Exactly the dialog's own field state: the draft carries no clock of its
    own, so nothing can be tempted to age an attachment against it again. */
export type BoardCardDraft = typeof BoardCardDraftSchema.Type;

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
 * What makes a draft worth keeping. Project, stage, label, base branch,
 * schedule and priority are all defaults the dialog opens with — counting them would mean
 * merely opening the dialog leaves a draft that greets you forever.
 */
export function boardCardDraftHasContent(
  draft: Pick<BoardCardDraft, "title" | "brief" | "dependsOn" | "attachments">,
): boolean {
  return (
    draft.title.trim().length > 0 ||
    draft.brief.trim().length > 0 ||
    draft.dependsOn.length > 0 ||
    draft.attachments.length > 0
  );
}

/** Whether two drafts hold the same input. The autosave hands the store a
    fresh object on every render, and most of them changed nothing. */
export function boardCardDraftContentEquals(left: BoardCardDraft, right: BoardCardDraft): boolean {
  return (
    left.title === right.title &&
    left.brief === right.brief &&
    left.stage === right.stage &&
    left.projectId === right.projectId &&
    left.baseBranch === right.baseBranch &&
    left.scheduledStartAt === right.scheduledStartAt &&
    left.priority === right.priority &&
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
  readonly fields: BoardCardDraft;
  /** Whether any stored attachment reference was dropped (expired or over
      the per-card cap), so the banner can say attachments went missing. */
  readonly droppedAttachments: boolean;
}

/**
 * Map a stored draft onto the board as it is now. The draft's stage wins over
 * the opened one, clamped to offered stages. Gone projects, cards and labels
 * drop out, as do attachments past the pending-upload TTL.
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
  // A dependency survives while the card exists, in any project (cross-project
  // edges are legal). Inside a sub-board a child may only depend on siblings.
  const dependsOn = draft.dependsOn.filter((cardId, index) => {
    if (draft.dependsOn.indexOf(cardId) !== index) return false;
    const card = cardsById.get(cardId as string);
    if (card === undefined) return false;
    return input.subBoardParentId === null || card.parentCardId === input.subBoardParentId;
  });

  const liveLabelIds = new Set(
    input.labels
      .filter((label) => label.deletedAt === null)
      .map((label) => label.labelId as string),
  );
  const labelIds = draft.labelIds.filter(
    (labelId, index) =>
      draft.labelIds.indexOf(labelId) === index && liveLabelIds.has(labelId as string),
  );

  // Each reference ages on its OWN upload time, which is the clock the
  // server's sweep runs on: an hour of typing after attaching a file must not
  // pretend the pending upload is an hour younger than the server thinks it
  // is, and one expired file must not take the fresh ones with it.
  const attachments = draft.attachments
    .filter((attachment) => input.now - attachment.uploadedAt <= BOARD_CARD_DRAFT_ATTACHMENT_TTL_MS)
    .slice(0, input.maxAttachments ?? BOARD_CARD_ATTACHMENTS_MAX);

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
      priority: draft.priority,
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
  attachments: ReadonlyArray<BoardCardDraftAttachment>,
): ReadonlyArray<BoardStagedAttachment> {
  // The row keeps the upload time beside the reference, not inside it:
  // `upload` is spread straight into `board.attachCardFile`, so it holds the
  // server's own fields and nothing else.
  return attachments.map(({ uploadedAt, ...upload }) => ({
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
    uploadedAt,
  }));
}

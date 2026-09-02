/**
 * T3o brief attachments — board-owned storage (t3o-32, K1/K2/K4).
 *
 * Files live at `<stateDir>/board/attachments/<cardId>/<name>`, beside
 * `boards.sqlite`. One copy, board-owned: never a worktree (reclaimed at
 * Done) and never upstream's flat `attachmentsDir` (opaque uuid names, mixed
 * with chat-turn files). Upstream's UPLOAD half is reused unchanged — the
 * client mints a `pending-<uuid>` upload and POSTs the bytes — and this module
 * owns the CLAIM: copy the pending file under the original (sanitised,
 * de-duplicated) filename and hand back the record the decider stores.
 *
 * The one push (K4) is also here: `stageBoardCardImagesAsPending` copies a
 * card's images back out as fresh pending uploads so the supervisor can pass
 * them as ordinary `ChatAttachment`s on a spawn turn — upstream's
 * `Normalizer` then claims them into thread scope untouched, and the board
 * copy stays the truth.
 */
import {
  BOARD_CARD_ATTACHMENTS_MAX,
  BoardCardAttachmentId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type BoardCard,
  type BoardCardAttachment,
  type BoardCardId,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  attachmentFileExtension,
  createPendingAttachmentId,
  parseAttachmentUuid,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { inferImageExtension } from "../imageMime.ts";

/** Where every card's attachment folder lives. */
export function boardAttachmentsRoot(input: {
  readonly path: Path.Path;
  readonly stateDir: string;
}): string {
  return input.path.join(input.stateDir, "board", "attachments");
}

/** One card's folder. `cardId` is a client-minted uuid; a traversal-shaped id
    resolves to null rather than to a path. */
export function boardCardAttachmentsDir(input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly cardId: BoardCardId;
}): string | null {
  return resolveAttachmentRelativePath({
    attachmentsDir: boardAttachmentsRoot(input),
    relativePath: String(input.cardId),
  });
}

/** The absolute path of one attachment, or null when the name or id would
    escape the card's folder. The same guard upstream applies to its own
    attachment ids (`resolveAttachmentRelativePath`). */
export function resolveBoardCardAttachmentPath(input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly cardId: BoardCardId;
  readonly name: string;
}): string | null {
  const dir = boardCardAttachmentsDir(input);
  if (dir === null || input.name.includes("/") || input.name.includes("\\")) return null;
  return resolveAttachmentRelativePath({ attachmentsDir: dir, relativePath: input.name });
}

const NAME_MAX_CHARS = 120;

/** Path separators, C0/C1 control characters and DEL have no business in a
    filename an agent will `cat`. Spelled as a predicate rather than a regex so
    the intent reads without escape sequences. */
function isUnsafeNameChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return char === "/" || char === "\\" || code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

export function sanitizeBoardAttachmentName(input: {
  readonly name: string;
  readonly type: BoardCardAttachment["type"];
  readonly mimeType: string;
}): string {
  const stripped = [...input.name]
    .map((char) => (isUnsafeNameChar(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+/, "")
    .replace(/[\s.]+$/, "");
  const extension =
    input.type === "image"
      ? inferImageExtension({ mimeType: input.mimeType, fileName: stripped })
      : attachmentFileExtension(stripped);
  const stem = (() => {
    const dot = stripped.lastIndexOf(".");
    const raw = dot > 0 ? stripped.slice(0, dot) : stripped;
    return raw.length > 0 ? raw : input.type === "image" ? "image" : "file";
  })();
  const bounded = stem.slice(0, Math.max(1, NAME_MAX_CHARS - extension.length));
  return `${bounded}${extension}`;
}

/** `name.ext`, then `name-2.ext`, `name-3.ext`… until it is free of `taken`. */
export function dedupeBoardAttachmentName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type BoardAttachmentClaimFailure =
  | { readonly reason: "upload-missing"; readonly message: string; readonly cause?: unknown }
  | { readonly reason: "rejected"; readonly message: string }
  | { readonly reason: "storage"; readonly message: string; readonly cause?: unknown };

export class BoardAttachmentClaimError extends Error {
  readonly _tag = "BoardAttachmentClaimError";
  readonly failure: BoardAttachmentClaimFailure;
  constructor(failure: BoardAttachmentClaimFailure) {
    super(failure.message);
    this.failure = failure;
  }
}

/**
 * Copy a pending upload into the card's folder and return the record to
 * store (K2). The pending copy is left for upstream's 24h sweep, as the
 * chat path does. Refuses a non-pending id, a missing or size-mismatched
 * file, and a card already at `BOARD_CARD_ATTACHMENTS_MAX`.
 */
export const claimBoardCardAttachment = Effect.fn("board-attachments-claim")(function* (input: {
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly card: BoardCard;
  readonly pendingAttachmentId: string;
  readonly name: string;
  readonly type: BoardCardAttachment["type"];
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly addedAt: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (failure: BoardAttachmentClaimFailure) =>
    Effect.fail(new BoardAttachmentClaimError(failure));

  if (input.card.attachments.length >= BOARD_CARD_ATTACHMENTS_MAX) {
    return yield* fail({
      reason: "rejected",
      message: `Card ${input.card.key} already has ${BOARD_CARD_ATTACHMENTS_MAX} attachments.`,
    });
  }
  const uuid = parseAttachmentUuid(input.pendingAttachmentId);
  if (
    uuid === null ||
    parseThreadSegmentFromAttachmentId(input.pendingAttachmentId) !==
      PENDING_ATTACHMENT_THREAD_SEGMENT
  ) {
    return yield* fail({ reason: "rejected", message: "Attachment must be a pending upload." });
  }
  const sourcePath = resolveAttachmentPathById({
    attachmentsDir: input.attachmentsDir,
    attachmentId: input.pendingAttachmentId,
  });
  if (sourcePath === null) {
    return yield* fail({
      reason: "upload-missing",
      message: `'${input.name}' was not found on the server (the upload may have expired). Attach it again.`,
    });
  }
  const info = yield* fileSystem.stat(sourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new BoardAttachmentClaimError({
          reason: "upload-missing",
          message: `'${input.name}' was not found on the server. Attach it again.`,
          cause,
        }),
    ),
  );
  if (Number(info.size) !== input.sizeBytes) {
    return yield* fail({
      reason: "rejected",
      message: `'${input.name}' cannot be attached: stored size does not match.`,
    });
  }

  // The record's `type` decides which spawns push the file and how it is
  // served; it must agree with the bytes' declared mime rather than be taken
  // on the client's word.
  const mimeType = input.mimeType.toLowerCase();
  if ((input.type === "image") !== mimeType.startsWith("image/")) {
    return yield* fail({
      reason: "rejected",
      message: `'${input.name}' cannot be attached: its type does not match its content type.`,
    });
  }

  const dir = boardCardAttachmentsDir({ path, stateDir: input.stateDir, cardId: input.card.id });
  if (dir === null) {
    return yield* fail({ reason: "rejected", message: "Attachment name is not allowed." });
  }
  // De-duplicate against the card's records AND the files already in its
  // folder: two attaches of the same name racing each other both read the
  // same record list, so without the on-disk check the loser would copy over
  // the winner's file and, when the decider refused its duplicate record,
  // delete it on rollback. With it the loser lands as `name-2` and the
  // decider accepts both — nothing is overwritten and each rollback removes
  // only its own file.
  const taken = new Set(input.card.attachments.map((attachment) => attachment.name));
  const onDisk = yield* fileSystem
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  for (const entry of onDisk) taken.add(entry);
  const name = dedupeBoardAttachmentName(
    sanitizeBoardAttachmentName({ name: input.name, type: input.type, mimeType }),
    taken,
  );
  const target = resolveBoardCardAttachmentPath({
    path,
    stateDir: input.stateDir,
    cardId: input.card.id,
    name,
  });
  if (target === null) {
    return yield* fail({ reason: "rejected", message: "Attachment name is not allowed." });
  }
  yield* fileSystem.makeDirectory(dir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.copyFile(sourcePath, target)),
    Effect.mapError(
      (cause) =>
        new BoardAttachmentClaimError({
          reason: "storage",
          message: `Failed to store '${name}' for card ${input.card.key}.`,
          cause,
        }),
    ),
  );
  return {
    id: BoardCardAttachmentId.make(uuid),
    name,
    type: input.type,
    mimeType,
    sizeBytes: input.sizeBytes,
    addedAt: input.addedAt,
  } satisfies BoardCardAttachment;
});

/** Delete one attachment's file. A file that is already gone is not an
    error: the record is what the user removed, and it is gone either way. */
export const deleteBoardCardAttachmentFile = Effect.fn("board-attachments-delete")(
  function* (input: {
    readonly stateDir: string;
    readonly cardId: BoardCardId;
    readonly name: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const target = resolveBoardCardAttachmentPath({
      path,
      stateDir: input.stateDir,
      cardId: input.cardId,
      name: input.name,
    });
    if (target === null) return;
    yield* fileSystem.remove(target).pipe(Effect.ignore);
  },
);

/** Remove a card's whole folder — the card-delete path. Best-effort. */
export const removeBoardCardAttachmentsDir = Effect.fn("board-attachments-remove-dir")(
  function* (input: { readonly stateDir: string; readonly cardId: BoardCardId }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = boardCardAttachmentsDir({ path, stateDir: input.stateDir, cardId: input.cardId });
    if (dir === null) return;
    yield* fileSystem.remove(dir, { recursive: true }).pipe(Effect.ignore);
  },
);

/** One manifest row: the record plus the absolute path an agent can read. */
export interface BoardCardAttachmentManifestEntry {
  readonly id: BoardCardAttachmentId;
  readonly name: string;
  readonly type: BoardCardAttachment["type"];
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly path: string;
}

/** The pull half (K3): what `board_get_card_context` hands a thread. Pure —
    a path is derived, not checked, so a listing costs no I/O. */
export function boardCardAttachmentManifest(input: {
  readonly path: Path.Path;
  readonly stateDir: string;
  readonly card: BoardCard;
}): ReadonlyArray<BoardCardAttachmentManifestEntry> {
  return input.card.attachments.flatMap((attachment) => {
    const filePath = resolveBoardCardAttachmentPath({
      path: input.path,
      stateDir: input.stateDir,
      cardId: input.card.id,
      name: attachment.name,
    });
    return filePath === null
      ? []
      : [
          {
            id: attachment.id,
            name: attachment.name,
            type: attachment.type,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            path: filePath,
          },
        ];
  });
}

/**
 * Which spawns push the brief's images (K4): the two that act on the brief.
 * Review rounds and the sync step are build-mode too, but they run against a
 * diff and pull the files by path when they need them (K3) — pushing the same
 * bytes into every round is what K4 rejected.
 */
export function spawnPushesBriefImages(role: string | null | undefined): boolean {
  return role === "build" || role === "plan";
}

/**
 * The one push (K4): copy the card's images back out as fresh `pending-`
 * uploads and return them as the `ChatAttachment`s a spawn turn carries.
 * Capped at upstream's per-turn limit; the rest stay reachable by path.
 * A copy that fails is skipped, not fatal — the manifest still covers it.
 */
export const stageBoardCardImagesAsPending = Effect.fn("board-attachments-stage-images")(
  function* (input: {
    readonly stateDir: string;
    readonly attachmentsDir: string;
    readonly card: BoardCard;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const images = input.card.attachments
      .filter((attachment) => attachment.type === "image")
      .slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
    const staged: ChatAttachment[] = [];
    for (const image of images) {
      const source = resolveBoardCardAttachmentPath({
        path,
        stateDir: input.stateDir,
        cardId: input.card.id,
        name: image.name,
      });
      if (source === null) continue;
      // Images carry no extension in the id (upstream resolves them by
      // probing the safe image extensions), so the pending file takes the
      // extension the mime implies — the same one `attachmentRelativePath`
      // will look for at claim time.
      const pendingId = createPendingAttachmentId();
      const extension = inferImageExtension({ mimeType: image.mimeType, fileName: image.name });
      const target = resolveAttachmentRelativePath({
        attachmentsDir: input.attachmentsDir,
        relativePath: `${pendingId}${extension}`,
      });
      if (target === null) continue;
      const copied = yield* fileSystem
        .makeDirectory(input.attachmentsDir, { recursive: true })
        .pipe(
          Effect.andThen(fileSystem.copyFile(source, target)),
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        );
      if (!copied) continue;
      staged.push({
        type: "image",
        id: pendingId,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      } as ChatAttachment);
    }
    return staged;
  },
);

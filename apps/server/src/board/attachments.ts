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
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type BoardCard,
  type BoardCardAttachment,
  type BoardCardId,
  type ChatAttachment,
  type ChatAttachmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
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

// Bound in UTF-8 BYTES, extension included, well under the 255-byte NAME_MAX
// most filesystems enforce, so a long CJK name cannot surface as ENAMETOOLONG.
const NAME_MAX_BYTES = 200;
const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

/** Path separators, C0/C1 control characters and DEL have no business in a
    filename an agent will `cat`. Spelled as a predicate rather than a regex so
    the intent reads without escape sequences. */
function isUnsafeNameChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return char === "/" || char === "\\" || code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/**
 * A filename safe to store and pleasant to `cat`: the original name with
 * path separators and control characters stripped, collapsed whitespace,
 * `..` runs removed from the front (one leading dot is fine — a dotfile is a
 * dotfile), and a bounded length that keeps the extension. A generic file
 * keeps its name exactly, extension or not (`Makefile` stays `Makefile`):
 * the whole point of the card folder is that an agent sees the file as it
 * was. Only an image gets an inferred extension, so a pasted screenshot
 * named "" becomes `image.png` rather than nothing.
 */
export function sanitizeBoardAttachmentName(input: {
  readonly name: string;
  readonly type: BoardCardAttachment["type"];
  readonly mimeType: string;
}): string {
  // A dropped path contributes only its basename; then separators, control
  // characters and surrounding dot/space junk go, keeping exactly one leading
  // dot when that is all that preceded the name (a dotfile).
  const segments = input.name.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const base = segments.length > 0 ? (segments[segments.length - 1] ?? "") : "";
  let stripped = [...base]
    .map((char) => (isUnsafeNameChar(char) ? " " : char))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const lead = /^[\s.]+/.exec(stripped)?.[0] ?? "";
  stripped = (lead === "." ? "." : "") + stripped.slice(lead.length);
  stripped = stripped.replace(/[\s.]+$/, "");
  const dot = stripped.lastIndexOf(".");
  const ownExtension = dot > 0 ? stripped.slice(dot) : "";
  const extension =
    input.type === "image"
      ? inferImageExtension({ mimeType: input.mimeType, fileName: stripped })
      : ownExtension;
  const rawStem = dot > 0 ? stripped.slice(0, dot) : stripped;
  const stem = rawStem.length > 0 ? rawStem : input.type === "image" ? "image" : "file";
  // Trim the stem (never the extension) until the whole name fits the byte
  // budget; an extension that alone exceeds it is dropped as unusable.
  const ext = utf8Bytes(extension) > NAME_MAX_BYTES - 1 ? "" : extension;
  let bounded = stem;
  while (utf8Bytes(bounded) + utf8Bytes(ext) > NAME_MAX_BYTES && bounded.length > 1) {
    bounded = [...bounded].slice(0, -1).join("");
  }
  return `${bounded}${ext}`;
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
  /** The record's id, minted by the caller per claim — never the pending
      upload's uuid, so two claims of one upload onto two cards can never
      share an id (the mirror table and the decider both assume ids are
      unique across the board). */
  readonly attachmentId: BoardCardAttachmentId;
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
  if (
    parseAttachmentUuid(input.pendingAttachmentId) === null ||
    parseThreadSegmentFromAttachmentId(input.pendingAttachmentId) !==
      PENDING_ATTACHMENT_THREAD_SEGMENT
  ) {
    return yield* fail({ reason: "rejected", message: "Attachment must be a pending upload." });
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

  // An image is pushed onto spawn turns (K4) under upstream's image cap; a
  // pending FILE upload can be anything up to the file cap, so the cap is
  // enforced here rather than trusted from the mint.
  if (input.type === "image" && input.sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return yield* fail({
      reason: "rejected",
      message: `'${input.name}' cannot be attached: images are limited to ${
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / (1024 * 1024)
      } MB.`,
    });
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
  const dir = boardCardAttachmentsDir({ path, stateDir: input.stateDir, cardId: input.card.id });
  if (dir === null) {
    return yield* fail({ reason: "rejected", message: "Attachment name is not allowed." });
  }
  // De-duplicate against the card's records, then claim the name on disk
  // with an EXCLUSIVE create: two attaches of the same name racing each other
  // read the same record list, and a check-then-copy would let the loser
  // overwrite the winner's file and, when the decider refused its duplicate
  // record, delete it on rollback. `wx` makes the collision the filesystem's
  // to detect — the loser lands as `name-2`, the decider accepts both, and
  // each rollback removes only its own file.
  const taken = new Set(input.card.attachments.map((attachment) => attachment.name));
  const preferred = sanitizeBoardAttachmentName({
    name: input.name,
    type: input.type,
    mimeType,
  });
  yield* fileSystem.makeDirectory(dir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new BoardAttachmentClaimError({
          reason: "storage",
          message: `Failed to store '${preferred}' for card ${input.card.key}.`,
          cause,
        }),
    ),
  );
  let name = dedupeBoardAttachmentName(preferred, taken);
  for (let attempt = 0; ; attempt += 1) {
    const target = resolveBoardCardAttachmentPath({
      path,
      stateDir: input.stateDir,
      cardId: input.card.id,
      name,
    });
    if (target === null) {
      return yield* fail({ reason: "rejected", message: "Attachment name is not allowed." });
    }
    // Two phases, so a failure is never misread. RESERVE the name with an
    // exclusive open: the only way that fails against an existing file is a
    // collision, which is retried under the next suffix. Then COPY the bytes
    // over the reservation: a failure here is a storage error — the reserved
    // (possibly partial) file is removed and nothing is retried.
    const reserved = yield* Effect.scoped(fileSystem.open(target, { flag: "wx" })).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        fileSystem.exists(target).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((exists) =>
            exists && attempt < 100
              ? Effect.succeed(false)
              : Effect.fail(
                  new BoardAttachmentClaimError({
                    reason: "storage",
                    message: `Failed to store '${name}' for card ${input.card.key}.`,
                    cause,
                  }),
                ),
          ),
        ),
      ),
    );
    if (!reserved) {
      taken.add(name);
      name = dedupeBoardAttachmentName(preferred, taken);
      continue;
    }
    yield* fileSystem.copyFile(sourcePath, target).pipe(
      Effect.tapError(() => fileSystem.remove(target).pipe(Effect.ignore)),
      Effect.mapError(
        (cause) =>
          new BoardAttachmentClaimError({
            reason: "storage",
            message: `Failed to store '${name}' for card ${input.card.key}.`,
            cause,
          }),
      ),
    );
    break;
  }
  return {
    id: input.attachmentId,
    name,
    type: input.type,
    mimeType,
    sizeBytes: input.sizeBytes,
    addedAt: input.addedAt,
  } satisfies BoardCardAttachment;
});

/** Delete one attachment's file. A file that is already gone is not an
    error: the record is what the user removed, and it is gone either way.
    Any other failure is logged and left for a manual tidy — never raised,
    because the record is already gone. */
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
    yield* fileSystem.remove(target).pipe(
      Effect.catchCause((cause) =>
        fileSystem.exists(target).pipe(
          Effect.orElseSucceed(() => false),
          Effect.flatMap((stillThere) =>
            stillThere
              ? Effect.logWarning("board attachments: file delete failed", {
                  cardId: input.cardId,
                  name: input.name,
                  cause: String(cause),
                })
              : Effect.void,
          ),
        ),
      ),
    );
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
      // `ChatAttachmentId` is exported as a type only; the brand is asserted
      // on the id alone so the struct itself is type-checked as an image.
      const chatAttachment: ChatAttachment = {
        type: "image",
        id: pendingId as ChatAttachmentId,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.sizeBytes,
      };
      staged.push(chatAttachment);
    }
    return staged;
  },
);

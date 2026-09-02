/**
 * T3o brief attachments — the web upload path (t3o-32, K2/K7).
 *
 * A dropped, pasted or picked file becomes a pending upload through the SAME
 * cycle the chat composer uses (`runAttachmentUploadCycle`: mint a signed URL,
 * POST the bytes), then the card claims it through `board.attachCardFile`.
 * This module owns the pure half — classification, image preparation, the XHR
 * transport and size labels — and stays clear of the composer draft store,
 * which is threaded through the chat surfaces and has no card to hang off.
 */
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type BoardCardAttachment,
  type EnvironmentId,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  clampFileAttachmentUploadBytes,
  deletePendingAttachmentUpload,
  fileAttachmentTooLargeMessage,
  runAttachmentUploadCycle,
} from "@t3tools/client-runtime/state/attachments";

import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "../components/chat/composerAttachmentFiles";
import { prepareImageForAttachment } from "../lib/imageCompression";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachmentEnvironment } from "../state/attachments";
import { readPreparedConnection } from "../state/session";

const UPLOAD_TIMEOUT_MS = 5 * 60_000;

/** What the environment allows, read off its advertised capabilities. */
export interface BoardAttachmentLimits {
  /** False until the server's config has arrived. */
  readonly known: boolean;
  /** Whether uploads are supported at all. */
  readonly enabled: boolean;
  /** Effective per-file byte cap for non-image files, or null when files are
      not accepted (images still are, up to upstream's image cap). */
  readonly maxFileBytes: number | null;
}

export function boardAttachmentLimits(
  capabilities:
    | {
        readonly attachmentUploads?: boolean | undefined;
        readonly fileAttachments?: { readonly maxUploadBytes: number } | undefined;
      }
    | null
    | undefined,
): BoardAttachmentLimits {
  if (capabilities === null || capabilities === undefined) {
    return { known: false, enabled: false, maxFileBytes: null };
  }
  const enabled = capabilities.attachmentUploads === true;
  const advertised = capabilities.fileAttachments?.maxUploadBytes;
  return {
    known: true,
    enabled,
    maxFileBytes:
      enabled && advertised !== undefined ? clampFileAttachmentUploadBytes(advertised) : null,
  };
}

/** "512 B" / "74 KB" / "8.1 MB" — the prototype's `fmtBytes`. */
export function formatBoardAttachmentSize(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The record the card stores, minus what the server assigns (id, addedAt). */
export interface BoardPendingUpload {
  readonly pendingAttachmentId: string;
  readonly name: string;
  readonly type: BoardCardAttachment["type"];
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export type BoardAttachmentPrepared =
  | { readonly ok: true; readonly file: File; readonly type: BoardCardAttachment["type"] }
  | { readonly ok: false; readonly reason: string };

/**
 * Decide what a file is and get it upload-ready: images are recompressed to
 * upstream's image cap (and HEIC converted), generic files are size-checked
 * against the environment's limit. Only images may arrive by paste; the
 * caller enforces that.
 */
export async function prepareBoardAttachmentFile(
  input: File,
  limits: BoardAttachmentLimits,
): Promise<BoardAttachmentPrepared> {
  const kind = classifyComposerAttachmentFile(input);
  if (kind === "unsupported-image") {
    return { ok: false, reason: `'${input.name}' is not a supported image type.` };
  }
  if (kind === "image") {
    const normalized = normalizeComposerImageFileMimeType(input);
    const prepared = await prepareImageForAttachment(
      normalized,
      PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    );
    if (!prepared.ok) {
      return {
        ok: false,
        reason:
          prepared.reason === "too-large"
            ? `'${input.name}' is too large to attach as an image.`
            : `'${input.name}' could not be read as an image.`,
      };
    }
    return { ok: true, file: prepared.file, type: "image" };
  }
  if (limits.maxFileBytes === null) {
    return {
      ok: false,
      reason: limits.known
        ? "This server does not accept file attachments."
        : "Waiting for the server before files can be attached.",
    };
  }
  if (input.size > limits.maxFileBytes) {
    return { ok: false, reason: fileAttachmentTooLargeMessage(input.name, limits.maxFileBytes) };
  }
  if (input.size === 0) {
    return { ok: false, reason: `'${input.name}' is empty.` };
  }
  return { ok: true, file: input, type: "file" };
}

function uploadBytes(input: {
  readonly url: string;
  readonly file: File;
  readonly mimeType: string;
  readonly onProgress: (progress: number) => void;
}): { readonly done: Promise<void>; readonly abort: () => void } {
  const xhr = new XMLHttpRequest();
  const done = new Promise<void>((resolve, reject) => {
    xhr.open("POST", input.url, true);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader("Content-Type", input.mimeType);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress(event.loaded / event.total);
      }
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload rejected (${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("timeout", () => reject(new Error("Upload timed out")));
    xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
    xhr.send(input.file);
  });
  return { done, abort: () => xhr.abort() };
}

export type BoardUploadOutcome =
  | { readonly status: "uploaded"; readonly upload: BoardPendingUpload }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly reason: string };

/** Mint + transfer one prepared file as a pending upload on the environment. */
export async function uploadBoardAttachment(input: {
  readonly environmentId: EnvironmentId;
  readonly file: File;
  readonly type: BoardCardAttachment["type"];
  readonly onProgress?: (progress: number) => void;
  readonly onAbortable?: (abort: () => void) => void;
  readonly isCancelled?: () => boolean;
}): Promise<BoardUploadOutcome> {
  const mimeType = input.file.type.toLowerCase();
  const result = await runAttachmentUploadCycle({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    environmentId: input.environmentId,
    upload: {
      ...(input.type === "file" ? { type: "file" as const } : {}),
      name: input.file.name,
      mimeType,
      sizeBytes: input.file.size,
    } as Parameters<typeof runAttachmentUploadCycle>[0]["upload"],
    resolveUploadUrl: (relativeUrl) => {
      const connection = readPreparedConnection(input.environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) =>
      uploadBytes({
        url,
        file: input.file,
        mimeType,
        onProgress: (progress) => input.onProgress?.(progress),
      }),
    onMinted: () => (input.isCancelled?.() ? "cancel" : "continue"),
    onTransferStart: (abort) => input.onAbortable?.(abort),
  });
  if (result.status === "cancelled") return { status: "cancelled" };
  if (result.status === "uploaded") {
    return {
      status: "uploaded",
      upload: {
        pendingAttachmentId: result.attachmentId,
        name: input.file.name,
        type: input.type,
        mimeType,
        sizeBytes: input.file.size,
      },
    };
  }
  return {
    status: "failed",
    reason:
      result.step === "mint"
        ? "Upload could not start"
        : result.step === "resolve-url"
          ? "Not connected"
          : result.error instanceof Error
            ? result.error.message
            : "Upload failed",
  };
}

/** Best-effort release of a pending upload the card will never claim. */
export function releaseBoardPendingUpload(environmentId: EnvironmentId, pendingId: string): void {
  deletePendingAttachmentUpload({
    registry: appAtomRegistry,
    remove: attachmentEnvironment.remove,
    environmentId,
    attachmentId: pendingId,
  });
}

/** Files a paste may claim: images only (K9) — a pasted document falls
    through to the default text paste. */
export function pastedImageFiles(data: DataTransfer | null): File[] {
  if (data === null) return [];
  return Array.from(data.files).filter((file) => classifyComposerAttachmentFile(file) === "image");
}

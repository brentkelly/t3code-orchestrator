/**
 * T3o brief attachments — the shared UI (t3o-32, K9).
 *
 * One hook and two pieces, so the create dialog and the card modal compose
 * the same thing around their own text editor:
 *
 *   <div …drop handlers…>
 *     <BoardBriefThumbnailStrip …/>   images, 56×56, ✕ badge while editable
 *     <Textarea onPaste={handlers.onPaste} …/>
 *   </div>
 *   <BoardBriefAttachRow …/>          paperclip "Attach files" + file chips
 *
 * Pasting an image never inserts it inline — it becomes an attachment. Files
 * arrive by drop or the picker. Staged rows show upload progress and a retry;
 * persisted rows come from the card. `onUploaded` decides what happens when
 * bytes land: the modal attaches immediately and answers "consumed", the
 * dialog keeps the row until Create and answers "keep".
 */
import type { BoardCardAttachment, BoardCardId, EnvironmentId } from "@t3tools/contracts";
import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from "react";

import { useAssetUrl } from "../assets/assetUrls";
import { cn, randomUUID } from "../lib/utils";
import { BoardHint } from "./BoardHint";
import {
  formatBoardAttachmentSize,
  pastedImageFiles,
  prepareBoardAttachmentFile,
  releaseBoardPendingUpload,
  uploadBoardAttachment,
  type BoardAttachmentLimits,
  type BoardPendingUpload,
} from "./boardAttachmentUpload";

export type BoardStagedStatus = "preparing" | "uploading" | "attaching" | "uploaded" | "failed";

/** A file on its way onto the card: local until `onUploaded` consumes it. */
export interface BoardStagedAttachment {
  readonly id: string;
  readonly name: string;
  readonly type: BoardCardAttachment["type"];
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Kept for retry; null once the row no longer holds the bytes. */
  readonly file: File | null;
  /** `blob:` preview for images while they are local. */
  readonly previewUrl: string | null;
  readonly status: BoardStagedStatus;
  readonly progress: number;
  readonly error: string | null;
  readonly upload: BoardPendingUpload | null;
}

export type BoardDropZone = "brief" | "row" | null;

interface StagedRuntime {
  abort: (() => void) | null;
  cancelled: boolean;
}

export function useBoardBriefAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly limits: BoardAttachmentLimits;
  /** How many attachments the card already holds — the per-card cap counts
      both persisted and staged. */
  readonly persistedCount: number;
  readonly maxAttachments: number;
  readonly onUploaded: (upload: BoardPendingUpload) => Promise<"consumed" | "keep" | string>;
}) {
  const [staged, setStaged] = useState<ReadonlyArray<BoardStagedAttachment>>([]);
  const [dropZone, setDropZone] = useState<BoardDropZone>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const runtimes = useRef(new Map<string, StagedRuntime>());
  // The latest rows, readable from callbacks without capturing a render: the
  // release side effects below must run once, outside React's updater, which
  // may be invoked more than once.
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { environmentId, limits, onUploaded } = input;
  const capacityLeft = Math.max(0, input.maxAttachments - input.persistedCount - staged.length);

  const update = useCallback((id: string, patch: Partial<BoardStagedAttachment>) => {
    setStaged((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  /** Drop a row the card has taken over: its `blob:` preview is released
      here, since the persisted thumbnail loads through a signed URL. */
  const dropConsumed = useCallback((id: string) => {
    const row = stagedRef.current.find((candidate) => candidate.id === id);
    if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
    runtimes.current.delete(id);
    setStaged((rows) => rows.filter((candidate) => candidate.id !== id));
  }, []);

  const run = useCallback(
    async (id: string, file: File, type: BoardCardAttachment["type"]) => {
      const runtime: StagedRuntime = { abort: null, cancelled: false };
      runtimes.current.set(id, runtime);
      update(id, { status: "uploading", progress: 0, error: null });
      const outcome = await uploadBoardAttachment({
        environmentId,
        file,
        type,
        onProgress: (progress) => update(id, { progress }),
        onAbortable: (abort) => {
          runtime.abort = abort;
        },
        isCancelled: () => runtime.cancelled,
      });
      runtime.abort = null;
      if (runtime.cancelled || outcome.status === "cancelled") return;
      if (outcome.status === "failed") {
        update(id, { status: "failed", error: outcome.reason });
        return;
      }
      update(id, { status: "attaching", progress: 1, upload: outcome.upload });
      const verdict = await onUploaded(outcome.upload);
      if (runtime.cancelled) return;
      if (verdict === "consumed") {
        dropConsumed(id);
        return;
      }
      if (verdict === "keep") {
        update(id, { status: "uploaded" });
        return;
      }
      update(id, { status: "failed", error: verdict });
    },
    [dropConsumed, environmentId, onUploaded, update],
  );

  const addFiles = useCallback(
    (files: ReadonlyArray<File>) => {
      if (files.length === 0) return;
      if (!limits.enabled) {
        setNotice(
          limits.known
            ? "This server does not accept attachments."
            : "Waiting for the server before files can be attached.",
        );
        return;
      }
      const admitted = files.slice(0, capacityLeft);
      if (admitted.length < files.length) {
        setNotice(`A card can hold ${input.maxAttachments} attachments.`);
      } else {
        setNotice(null);
      }
      for (const file of admitted) {
        const id = randomUUID();
        const isImage = file.type.toLowerCase().startsWith("image/");
        const previewUrl = isImage ? URL.createObjectURL(file) : null;
        setStaged((rows) => [
          ...rows,
          {
            id,
            name: file.name.length > 0 ? file.name : isImage ? "image.png" : "file",
            type: isImage ? "image" : "file",
            mimeType: file.type.toLowerCase() || "application/octet-stream",
            sizeBytes: file.size,
            file,
            previewUrl,
            status: "preparing",
            progress: 0,
            error: null,
            upload: null,
          },
        ]);
        void prepareBoardAttachmentFile(file, limits).then((prepared) => {
          if (!prepared.ok) {
            update(id, { status: "failed", error: prepared.reason });
            return;
          }
          update(id, {
            file: prepared.file,
            type: prepared.type,
            mimeType: prepared.file.type.toLowerCase(),
            sizeBytes: prepared.file.size,
          });
          void run(id, prepared.file, prepared.type);
        });
      }
    },
    [capacityLeft, input.maxAttachments, limits, run, update],
  );

  const removeStaged = useCallback(
    (id: string) => {
      const runtime = runtimes.current.get(id);
      if (runtime) {
        runtime.cancelled = true;
        runtime.abort?.();
        runtimes.current.delete(id);
      }
      const row = stagedRef.current.find((candidate) => candidate.id === id);
      if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
      if (row?.upload && row.status !== "attaching") {
        releaseBoardPendingUpload(environmentId, row.upload.pendingAttachmentId);
      }
      setStaged((rows) => rows.filter((candidate) => candidate.id !== id));
    },
    [environmentId],
  );

  const retry = useCallback(
    (id: string) => {
      const row = staged.find((candidate) => candidate.id === id);
      if (row === undefined || row.file === null) return;
      // An upload that landed but failed to attach only needs the attach.
      if (row.upload !== null) {
        update(id, { status: "attaching", error: null });
        const upload = row.upload;
        void onUploaded(upload).then((verdict) => {
          if (verdict === "consumed") {
            dropConsumed(id);
          } else if (verdict === "keep") {
            update(id, { status: "uploaded" });
          } else {
            update(id, { status: "failed", error: verdict });
          }
        });
        return;
      }
      void run(id, row.file, row.type);
    },
    [dropConsumed, onUploaded, run, staged, update],
  );

  // Object URLs are process-wide; release whatever is still local on unmount.
  // Read through the ref: the closure below is created on the first render,
  // when the list is always empty.
  useEffect(
    () => () => {
      for (const row of stagedRef.current) if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
    },
    [],
  );

  const dragOver = (zone: Exclude<BoardDropZone, null>) => (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    if (dropZone !== zone) setDropZone(zone);
  };
  const drop = (event: DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDropZone(null);
    addFiles(Array.from(event.dataTransfer.files));
  };

  const handlers = {
    /** Images only: a pasted document falls through to the text paste. */
    onPaste: (event: ClipboardEvent) => {
      const images = pastedImageFiles(event.clipboardData);
      if (images.length === 0) return;
      event.preventDefault();
      addFiles(images);
    },
    onBriefDragOver: dragOver("brief"),
    onRowDragOver: dragOver("row"),
    onDragLeave: () => {
      if (dropZone !== null) setDropZone(null);
    },
    onDrop: drop,
  };

  /** Drop every staged row, releasing local previews and unclaimed uploads —
      the dialog's reset on its open edge. */
  const clear = useCallback(() => {
    for (const row of stagedRef.current) {
      const runtime = runtimes.current.get(row.id);
      if (runtime) {
        runtime.cancelled = true;
        runtime.abort?.();
      }
      if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
      if (row.upload) releaseBoardPendingUpload(environmentId, row.upload.pendingAttachmentId);
    }
    runtimes.current.clear();
    setStaged([]);
    setNotice(null);
  }, [environmentId]);

  /** True while any row is still moving: the dialog blocks Create on it. */
  const busy = staged.some(
    (row) => row.status === "preparing" || row.status === "uploading" || row.status === "attaching",
  );
  const failed = staged.some((row) => row.status === "failed");

  return {
    staged,
    limits,
    busy,
    failed,
    clear,
    notice,
    dropZone,
    handlers,
    addFiles,
    removeStaged,
    retry,
    openPicker: () => fileInputRef.current?.click(),
    /** Render once, anywhere: the hidden `<input type="file">` the button opens. */
    fileInput: (
      <input
        className="hidden"
        multiple
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
        ref={fileInputRef}
        type="file"
      />
    ),
  };
}

export type BoardBriefAttachmentsState = ReturnType<typeof useBoardBriefAttachments>;

/** The drop-target frame (K9): a dashed primary border and a tinted
    background while a file is over it, invisible otherwise. */
export function boardBriefDropClass(active: boolean): string {
  return active ? "border-dashed border-primary bg-accent/70" : "border-dashed border-transparent";
}

const THUMB_CLASS =
  "size-14 shrink-0 rounded-[9px] border border-border bg-muted bg-cover bg-center shadow-xs";

function RemoveBadge({ label, onClick }: { readonly label: string; readonly onClick: () => void }) {
  return (
    <BoardHint label={label}>
      <button
        aria-label={label}
        className="absolute -top-1.5 -right-1.5 inline-flex size-[18px] items-center justify-center rounded-full border border-border bg-popover text-foreground shadow-xs hover:bg-accent"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        }}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        <XIcon className="size-2.5" strokeWidth={3} />
      </button>
    </BoardHint>
  );
}

function PersistedImageThumb(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly attachment: BoardCardAttachment;
  readonly onDetach: ((attachmentId: BoardCardAttachment["id"]) => void) | null;
}) {
  const url = useAssetUrl(props.environmentId, {
    _tag: "board-attachment",
    cardId: props.cardId,
    fileName: props.attachment.name,
    mimeType: props.attachment.mimeType,
  });
  return (
    <div className="relative shrink-0">
      <BoardHint label={props.attachment.name}>
        <a
          className={cn(THUMB_CLASS, "block")}
          href={url ?? undefined}
          rel="noreferrer"
          style={url ? { backgroundImage: `url("${url}")` } : undefined}
          target="_blank"
        >
          <span className="sr-only">{props.attachment.name}</span>
        </a>
      </BoardHint>
      {props.onDetach ? (
        <RemoveBadge label="Remove" onClick={() => props.onDetach?.(props.attachment.id)} />
      ) : null}
    </div>
  );
}

function StagedImageThumb(props: {
  readonly row: BoardStagedAttachment;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}) {
  const { row } = props;
  return (
    <div className="relative shrink-0">
      <BoardHint label={row.error ?? row.name}>
        <div
          className={cn(THUMB_CLASS, row.status === "failed" && "ring-2 ring-destructive/60")}
          style={row.previewUrl ? { backgroundImage: `url("${row.previewUrl}")` } : undefined}
        >
          {row.status === "uploading" ||
          row.status === "preparing" ||
          row.status === "attaching" ? (
            <div className="absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded-full bg-background/70">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.round(row.progress * 100)}%` }}
              />
            </div>
          ) : null}
          {row.status === "failed" ? (
            <button
              className="absolute inset-0 rounded-[9px] bg-background/60 text-[10px] font-medium text-destructive-foreground"
              onClick={() => props.onRetry(row.id)}
              type="button"
            >
              Retry
            </button>
          ) : null}
        </div>
      </BoardHint>
      <RemoveBadge label="Remove" onClick={() => props.onRemove(row.id)} />
    </div>
  );
}

/** Images: persisted from the card, then staged, as 56×56 tiles. Renders
    nothing when there are none, so the editor sits flush. */
export function BoardBriefThumbnailStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId | null;
  readonly attachments: ReadonlyArray<BoardCardAttachment>;
  readonly state: BoardBriefAttachmentsState;
  /** Whether ✕ badges render — view mode shows none. */
  readonly editable: boolean;
  readonly onDetach: ((attachmentId: BoardCardAttachment["id"]) => void) | null;
  readonly className?: string;
}) {
  const images = props.attachments.filter((attachment) => attachment.type === "image");
  const stagedImages = props.state.staged.filter((row) => row.type === "image");
  if (images.length === 0 && stagedImages.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-2.5", props.className)}>
      {props.cardId !== null
        ? images.map((attachment) => (
            <PersistedImageThumb
              attachment={attachment}
              cardId={props.cardId as BoardCardId}
              environmentId={props.environmentId}
              key={attachment.id}
              onDetach={props.editable ? props.onDetach : null}
            />
          ))
        : null}
      {stagedImages.map((row) => (
        <StagedImageThumb
          key={row.id}
          onRemove={props.state.removeStaged}
          onRetry={props.state.retry}
          row={row}
        />
      ))}
    </div>
  );
}

function Chip(props: {
  readonly icon?: ReactNode;
  readonly name: string;
  readonly size: string;
  readonly href?: string | null;
  readonly failed?: boolean;
  readonly hint?: string | null;
  readonly progress?: number | null;
  readonly onRetry?: (() => void) | undefined;
  readonly onRemove: (() => void) | null;
}) {
  const label = (
    <>
      <FileIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-[12px] text-foreground">{props.name}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">{props.size}</span>
    </>
  );
  return (
    <span
      className={cn(
        "relative inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-[7px] border border-border bg-popover pr-1.5 pl-1.5 shadow-xs",
        props.failed && "border-destructive/60",
      )}
    >
      {props.href ? (
        <BoardHint label={props.hint ?? `Download ${props.name}`}>
          <a
            className="flex min-w-0 items-center gap-1.5 hover:underline"
            href={props.href}
            rel="noreferrer"
            target="_blank"
          >
            {label}
          </a>
        </BoardHint>
      ) : (
        <BoardHint label={props.hint ?? null}>
          <span className="flex min-w-0 items-center gap-1.5">{label}</span>
        </BoardHint>
      )}
      {props.progress !== null && props.progress !== undefined ? (
        <span className="absolute inset-x-1 bottom-0 h-0.5 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full bg-primary transition-[width]"
            style={{ width: `${Math.round(props.progress * 100)}%` }}
          />
        </span>
      ) : null}
      {props.failed && props.onRetry ? (
        <button
          className="shrink-0 text-[11px] font-medium text-destructive-foreground hover:underline"
          onClick={props.onRetry}
          type="button"
        >
          Retry
        </button>
      ) : null}
      {props.onRemove ? (
        <BoardHint label="Remove">
          <button
            aria-label={`Remove ${props.name}`}
            className="inline-flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={props.onRemove}
            type="button"
          >
            <XIcon className="size-2.5" />
          </button>
        </BoardHint>
      ) : null}
    </span>
  );
}

function PersistedFileChip(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly attachment: BoardCardAttachment;
  readonly onDetach: ((attachmentId: BoardCardAttachment["id"]) => void) | null;
}) {
  const url = useAssetUrl(props.environmentId, {
    _tag: "board-attachment",
    cardId: props.cardId,
    fileName: props.attachment.name,
    mimeType: props.attachment.mimeType,
  });
  return (
    <Chip
      href={url}
      name={props.attachment.name}
      onRemove={props.onDetach ? () => props.onDetach?.(props.attachment.id) : null}
      size={formatBoardAttachmentSize(props.attachment.sizeBytes)}
    />
  );
}

/** The attach row (K9): dashed paperclip button, then every non-image file
    as a chip — persisted first, staged after. A drop target in its own right. */
export function BoardBriefAttachRow(props: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId | null;
  readonly attachments: ReadonlyArray<BoardCardAttachment>;
  readonly state: BoardBriefAttachmentsState;
  readonly editable: boolean;
  readonly onDetach: ((attachmentId: BoardCardAttachment["id"]) => void) | null;
  readonly className?: string;
}) {
  const { state } = props;
  const files = props.attachments.filter((attachment) => attachment.type !== "image");
  const stagedFiles = state.staged.filter((row) => row.type !== "image");
  const disabled = !props.editable || !state.limits.enabled;
  const disabledReason = !state.limits.known
    ? "Waiting for the server"
    : state.limits.enabled
      ? null
      : "This server does not accept attachments";
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-[9px] border pt-2.5 transition-colors",
        boardBriefDropClass(state.dropZone === "row"),
        props.className,
      )}
      onDragLeave={state.handlers.onDragLeave}
      onDragOver={state.handlers.onRowDragOver}
      onDrop={state.handlers.onDrop}
    >
      {props.editable ? (
        <BoardHint label={disabled ? disabledReason : null}>
          <button
            className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border border-dashed border-input px-2.5 text-[12px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled}
            onClick={state.openPicker}
            type="button"
          >
            <PaperclipIcon className="size-3" />
            Attach files
          </button>
        </BoardHint>
      ) : null}
      {props.editable ? state.fileInput : null}
      {props.cardId !== null
        ? files.map((attachment) => (
            <PersistedFileChip
              attachment={attachment}
              cardId={props.cardId as BoardCardId}
              environmentId={props.environmentId}
              key={attachment.id}
              onDetach={props.editable ? props.onDetach : null}
            />
          ))
        : null}
      {stagedFiles.map((row) => (
        <Chip
          failed={row.status === "failed"}
          hint={row.error}
          key={row.id}
          name={row.name}
          onRemove={() => state.removeStaged(row.id)}
          onRetry={row.status === "failed" ? () => state.retry(row.id) : undefined}
          progress={
            row.status === "uploading" || row.status === "preparing" || row.status === "attaching"
              ? row.progress
              : null
          }
          size={formatBoardAttachmentSize(row.sizeBytes)}
        />
      ))}
      {state.notice !== null ? (
        <span className="basis-full text-[11.5px] text-destructive-foreground">{state.notice}</span>
      ) : null}
    </div>
  );
}

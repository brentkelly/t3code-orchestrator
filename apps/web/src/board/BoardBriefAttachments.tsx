/**
 * Brief attachments shared by the create dialog and the card modal. A pasted image
 * becomes an attachment, never inline. `onUploaded` decides what landed bytes do:
 * the modal attaches at once ("consumed"), the dialog keeps the row until Create ("keep").
 */
import type {
  AssetResource,
  BoardCardAttachment,
  BoardCardId,
  EnvironmentId,
} from "@t3tools/contracts";
import { FileIcon, PaperclipIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from "react";

import { useAssetUrls, useAssetUrlState } from "../assets/assetUrls";
import { ExpandedImageDialog } from "../components/chat/ExpandedImageDialog";
import {
  expandedImageKey,
  type ExpandedImagePreview,
} from "../components/chat/ExpandedImagePreview";
import { useStableCallback } from "../hooks/useStableCallback";
import { cn, randomUUID } from "../lib/utils";
import { usePreparedConnection } from "../state/session";
import { BoardHint } from "./BoardHint";
import { stagedRowsFromUploads, type BoardCardDraftAttachment } from "./boardCardDraft";
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
  /** Epoch millis the upload landed, null until it has. The draft
      ages each reference against this, not against its own save clock. */
  readonly uploadedAt: number | null;
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { environmentId, limits, onUploaded } = input;
  // Keeps the prepared-connection atom mounted while an attach surface is
  // open: the upload's readPreparedConnection() is a one-shot registry read,
  // and board surfaces — unlike chat — have no other subscriber, so without
  // this every upload fails its resolve-url step with "Not connected".
  usePreparedConnection(environmentId);
  const capacityLeft = Math.max(0, input.maxAttachments - input.persistedCount - staged.length);

  const update = (id: string, patch: Partial<BoardStagedAttachment>) => {
    setStaged((rows) => rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  /** Drop a row the card has taken over: its `blob:` preview is released
      here, since the persisted thumbnail loads through a signed URL. */
  const dropConsumed = useStableCallback((id: string) => {
    const row = staged.find((candidate) => candidate.id === id);
    if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
    runtimes.current.delete(id);
    setStaged((rows) => rows.filter((candidate) => candidate.id !== id));
  });

  const run = async (id: string, file: File, type: BoardCardAttachment["type"]) => {
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
    update(id, {
      status: "attaching",
      progress: 1,
      upload: outcome.upload,
      uploadedAt: Date.now(),
    });
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
  };

  const addFiles = (files: ReadonlyArray<File>) => {
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
          uploadedAt: null,
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
          mimeType: prepared.file.type.toLowerCase() || "application/octet-stream",
          sizeBytes: prepared.file.size,
        });
        void run(id, prepared.file, prepared.type);
      });
    }
  };

  const removeStaged = useStableCallback((id: string) => {
    const runtime = runtimes.current.get(id);
    if (runtime) {
      runtime.cancelled = true;
      runtime.abort?.();
      runtimes.current.delete(id);
    }
    const row = staged.find((candidate) => candidate.id === id);
    if (row?.previewUrl) URL.revokeObjectURL(row.previewUrl);
    if (row?.upload && row.status !== "attaching") {
      releaseBoardPendingUpload(environmentId, row.upload.pendingAttachmentId);
    }
    setStaged((rows) => rows.filter((candidate) => candidate.id !== id));
  });

  const retry = (id: string) => {
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
  };

  const revokePreviews = useStableCallback(() => {
    for (const row of staged) if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- object URLs are process-wide; revokes the staged blob: previews on unmount
  useEffect(() => () => revokePreviews(), [revokePreviews]);

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
      Discard draft, Start fresh and the dialog's reset. `release: false` is
      for a create that has just claimed those uploads onto the card: the ids
      are the card's now, and releasing them would delete its files. */
  const clear = useStableCallback((options?: { readonly release?: boolean }) => {
    const release = options?.release ?? true;
    for (const row of staged) {
      const runtime = runtimes.current.get(row.id);
      if (runtime) {
        runtime.cancelled = true;
        runtime.abort?.();
      }
      if (row.previewUrl) URL.revokeObjectURL(row.previewUrl);
      if (release && row.upload) {
        releaseBoardPendingUpload(environmentId, row.upload.pendingAttachmentId);
      }
    }
    runtimes.current.clear();
    setStaged([]);
    setNotice(null);
  });

  /** Seed rows from a restored draft's references. A no-op when
      rows are already staged: those are this session's, and still hold their
      real bytes, live previews and in-flight uploads. */
  const hydrate = useStableCallback((attachments: ReadonlyArray<BoardCardDraftAttachment>) => {
    if (attachments.length === 0) return;
    setStaged((rows) => (rows.length > 0 ? rows : stagedRowsFromUploads(attachments)));
  });

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
    hydrate,
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

/** A minted asset URL, or null while it loads or when minting failed. */
function useBoardAssetUrl(environmentId: EnvironmentId, resource: AssetResource): string | null {
  const state = useAssetUrlState(environmentId, resource);
  return state._tag === "Success" ? state.url : null;
}

const THUMB_CLASS =
  "size-14 shrink-0 rounded-board-9 border border-border bg-muted bg-cover bg-center shadow-xs";

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

/** Opens the thumbnail in the same lightbox the chat composer uses. */
function ImageThumbButton(props: {
  readonly name: string;
  readonly url: string | null;
  readonly failed?: boolean;
  readonly onExpand: (() => void) | null;
  readonly children?: ReactNode;
}) {
  return (
    <BoardHint label={props.name}>
      <button
        aria-label={`Preview ${props.name}`}
        className={cn(
          THUMB_CLASS,
          "relative block",
          props.onExpand !== null && "cursor-zoom-in",
          props.failed && "ring-2 ring-destructive/60",
        )}
        disabled={props.onExpand === null}
        onClick={() => props.onExpand?.()}
        onMouseDown={(event) => event.preventDefault()}
        style={props.url ? { backgroundImage: `url("${props.url}")` } : undefined}
        type="button"
      >
        {props.children}
      </button>
    </BoardHint>
  );
}

function StagedImageThumb(props: {
  readonly row: BoardStagedAttachment;
  readonly onExpand: (() => void) | null;
  readonly onRemove: (id: string) => void;
  readonly onRetry: (id: string) => void;
}) {
  const { row } = props;
  return (
    <div className="relative shrink-0">
      <ImageThumbButton
        failed={row.status === "failed"}
        name={row.error ?? row.name}
        onExpand={props.onExpand}
        url={row.previewUrl}
      >
        {row.status === "uploading" || row.status === "preparing" || row.status === "attaching" ? (
          <div className="absolute inset-x-1 bottom-1 h-1 overflow-hidden rounded-full bg-background/70">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${Math.round(row.progress * 100)}%` }}
            />
          </div>
        ) : null}
      </ImageThumbButton>
      {row.status === "failed" ? (
        <button
          className="absolute inset-0 rounded-board-9 bg-background/60 text-board-10 font-medium text-destructive-foreground"
          onClick={() => props.onRetry(row.id)}
          type="button"
        >
          Retry
        </button>
      ) : null}
      <RemoveBadge label="Remove" onClick={() => props.onRemove(row.id)} />
    </div>
  );
}

/** A staged row that lost its local bytes to a reload: all it has
    left is the pending upload the thumbnail renders from. */
type BoardHydratedAttachment = BoardStagedAttachment & { readonly upload: BoardPendingUpload };

function isHydratedRow(row: BoardStagedAttachment): row is BoardHydratedAttachment {
  return row.file === null && row.previewUrl === null && row.upload !== null;
}

/** Images: persisted from the card, then staged, as 56×56 tiles. Renders
    nothing when there are none, so the editor sits flush. A restored draft
    row has no local bytes, so it renders from its pending upload's signed URL
    and offers no retry. */
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
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const { cardId } = props;
  const images =
    cardId === null ? [] : props.attachments.filter((attachment) => attachment.type === "image");
  const stagedImages = props.state.staged.filter((row) => row.type === "image");
  const resources: Array<AssetResource> = [
    ...images.map((attachment): AssetResource => ({
      _tag: "board-attachment",
      cardId: cardId as BoardCardId,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
    })),
    ...stagedImages.filter(isHydratedRow).map((row): AssetResource => ({
      _tag: "attachment",
      attachmentId: row.upload.pendingAttachmentId,
      fileName: row.name,
      mimeType: row.mimeType,
    })),
  ];
  const resourceUrls = useAssetUrls(props.environmentId, resources);
  let hydratedIndex = images.length;
  const tiles = [
    ...images.map((attachment, index) => ({
      id: attachment.id as string,
      name: attachment.name,
      mimeType: attachment.mimeType,
      url: resourceUrls[index] ?? null,
      persisted: attachment,
      staged: null,
    })),
    ...stagedImages.map((row) => ({
      id: row.id,
      name: row.name,
      mimeType: row.mimeType,
      url: isHydratedRow(row) ? (resourceUrls[hydratedIndex++] ?? null) : row.previewUrl,
      persisted: null,
      staged: row,
    })),
  ];
  if (tiles.length === 0) return null;
  const viewable = tiles.filter((tile) => tile.url !== null);
  const expand = (id: string) => {
    const index = viewable.findIndex((tile) => tile.id === id);
    if (index < 0) return;
    setPreview({
      images: viewable.map((tile) => ({
        src: tile.url,
        name: tile.name,
        mimeType: tile.mimeType,
      })),
      index,
    });
  };
  return (
    <div className={cn("flex flex-wrap gap-2.5", props.className)}>
      {tiles.map((tile) => {
        const onExpand = tile.url === null ? null : () => expand(tile.id);
        if (tile.persisted !== null) {
          const attachment = tile.persisted;
          return (
            <div className="relative shrink-0" key={tile.id}>
              <ImageThumbButton name={tile.name} onExpand={onExpand} url={tile.url} />
              {props.editable && props.onDetach ? (
                <RemoveBadge label="Remove" onClick={() => props.onDetach?.(attachment.id)} />
              ) : null}
            </div>
          );
        }
        const row = tile.staged;
        if (row === null) return null;
        return isHydratedRow(row) ? (
          <div className="relative shrink-0" key={tile.id}>
            <ImageThumbButton name={tile.name} onExpand={onExpand} url={tile.url} />
            <RemoveBadge label="Remove" onClick={() => props.state.removeStaged(row.id)} />
          </div>
        ) : (
          <StagedImageThumb
            key={tile.id}
            onExpand={onExpand}
            onRemove={props.state.removeStaged}
            onRetry={props.state.retry}
            row={row}
          />
        );
      })}
      {preview !== null ? (
        <ExpandedImageDialog
          key={expandedImageKey(preview)}
          onClose={() => setPreview(null)}
          preview={preview}
        />
      ) : null}
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
      <span className="min-w-0 truncate text-board-12 text-foreground">{props.name}</span>
      <span className="shrink-0 font-mono text-board-10-5 text-muted-foreground">{props.size}</span>
    </>
  );
  return (
    <span
      className={cn(
        "relative inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-board-7 border border-border bg-popover pr-1.5 pl-1.5 shadow-xs",
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
          className="shrink-0 text-board-11 font-medium text-destructive-foreground hover:underline"
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
  const url = useBoardAssetUrl(props.environmentId, {
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
        "flex flex-wrap items-center gap-1.5 rounded-board-9 border pt-2.5 transition-colors",
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
            className="inline-flex h-[26px] items-center gap-1.5 rounded-board-7 border border-dashed border-input px-2.5 text-board-12 font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
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
        <span className="basis-full text-board-11-5 text-destructive-foreground">
          {state.notice}
        </span>
      ) : null}
    </div>
  );
}

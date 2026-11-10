/**
 * A CI step's log on the client (T3O-60): `board.readCiLog` folded into what
 * the log viewer renders, and the whole file for Download.
 *
 * The viewer keeps at most about 2 MiB of the log, in blocks of lines so a
 * long log renders as a few hundred stable `<pre>` blocks rather than one
 * huge node; past the limit the oldest blocks are dropped. A dropped
 * connection resumes the read from the last byte received.
 */
import {
  BOARD_WS_METHODS,
  type BoardCiLogItem,
  type BoardReadCiLogInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { subscribeDynamic } from "../rpc/client.ts";

/** Lines per rendered block. */
export const BOARD_CI_LOG_BLOCK_LINES = 200;
/** About how much of a log the viewer keeps. */
const BOARD_CI_LOG_VIEW_BYTES = 2 * 1024 * 1024;

export interface BoardCiLogBlock {
  /** Stable across appends, for React keys. */
  readonly id: number;
  readonly lines: ReadonlyArray<string>;
  /** Each line's byte offset in the log file. */
  readonly offsets: ReadonlyArray<number>;
  readonly bytes: number;
}

export interface BoardCiLogView {
  /** `loading` until the first item; `live` while text may still come. */
  readonly status: "loading" | "live" | "ended" | "missing";
  readonly missingReason: string | null;
  readonly blocks: ReadonlyArray<BoardCiLogBlock>;
  /** The text after the last newline, still being written. */
  readonly partial: string;
  readonly partialOffset: number;
  /** Lines loaded, the unfinished one included. */
  readonly lineCount: number;
  /** Lines dropped from the start to stay within the limit. */
  readonly droppedLines: number;
  /** Bytes the blocks and the partial line hold. */
  readonly bytes: number;
  /** Older output was dropped to stay within the limit. */
  readonly truncated: boolean;
  /** The byte just past what's loaded, or null before any text. */
  readonly nextOffset: number | null;
}

export interface BoardCiLogRequest extends BoardReadCiLogInput {
  /** Drop text up to the first newline, when `fromOffset` may sit mid-line. */
  readonly alignStart?: boolean;
}

export const EMPTY_BOARD_CI_LOG_VIEW: BoardCiLogView = {
  status: "loading",
  missingReason: null,
  blocks: [],
  partial: "",
  partialOffset: 0,
  lineCount: 0,
  droppedLines: 0,
  bytes: 0,
  truncated: false,
  nextOffset: null,
};

/** The UTF-8 size of `text`, without encoding it. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

let nextBlockId = 0;

/** Fold one `board.readCiLog` item into the view. */
export function applyBoardCiLogItem(
  view: BoardCiLogView,
  item: BoardCiLogItem,
  options: { readonly maxBytes?: number; readonly alignStart?: boolean } = {},
): BoardCiLogView {
  if (item._tag === "missing") {
    return { ...view, status: "missing", missingReason: item.reason };
  }
  if (item._tag === "end") return { ...view, status: "ended" };

  let text = item.text;
  let offset = item.offset;
  if (options.alignStart === true && view.nextOffset === null && offset > 0) {
    const newline = text.indexOf("\n");
    if (newline === -1) {
      return { ...view, status: "live", nextOffset: item.end };
    }
    offset += utf8ByteLength(text.slice(0, newline + 1));
    text = text.slice(newline + 1);
  }
  const start = view.nextOffset === null ? offset : view.partialOffset;
  const combined = (view.nextOffset === null ? "" : view.partial) + text;
  const parts = combined.split("\n");
  const partial = parts.pop()!;

  const blocks = [...view.blocks];
  let last = blocks.at(-1);
  if (last !== undefined && last.lines.length >= BOARD_CI_LOG_BLOCK_LINES) last = undefined;
  else if (last !== undefined) blocks.pop();
  let lines = last === undefined ? [] : [...last.lines];
  let offsets = last === undefined ? [] : [...last.offsets];
  let blockBytes = last?.bytes ?? 0;
  let blockId = last?.id ?? nextBlockId++;
  let position = start;
  let added = 0;
  for (const part of parts) {
    const size = utf8ByteLength(part) + 1;
    lines.push(part.endsWith("\r") ? part.slice(0, -1) : part);
    offsets.push(position);
    position += size;
    blockBytes += size;
    added += size;
    if (lines.length >= BOARD_CI_LOG_BLOCK_LINES) {
      blocks.push({ id: blockId, lines, offsets, bytes: blockBytes });
      lines = [];
      offsets = [];
      blockBytes = 0;
      blockId = nextBlockId++;
    }
  }
  if (lines.length > 0) blocks.push({ id: blockId, lines, offsets, bytes: blockBytes });

  const partialBytes = utf8ByteLength(partial);
  let bytes = view.bytes - utf8ByteLength(view.nextOffset === null ? "" : view.partial) + added;
  let truncated = view.truncated;
  let droppedLines = view.droppedLines;
  const maxBytes = options.maxBytes ?? BOARD_CI_LOG_VIEW_BYTES;
  while (blocks.length > 1 && bytes + partialBytes > maxBytes) {
    const dropped = blocks.shift()!;
    bytes -= dropped.bytes;
    droppedLines += dropped.lines.length;
    truncated = true;
  }
  bytes += partialBytes;
  return {
    status: "live",
    missingReason: null,
    blocks,
    partial,
    // The file's own end, not the text's: an invalid byte decoded to U+FFFD.
    partialOffset: Math.max(start, item.end - partialBytes),
    lineCount: blocks.reduce((total, block) => total + block.lines.length, 0) + (partial ? 1 : 0),
    droppedLines,
    bytes,
    truncated,
    nextOffset: item.end,
  };
}

/** Every loaded line, for Copy. */
export function boardCiLogText(view: BoardCiLogView): string {
  const lines = view.blocks.flatMap((block) => block.lines);
  if (view.partial.length > 0) lines.push(view.partial);
  return lines.join("\n");
}

/** The block and line holding byte `offset`, for "show in log". */
export function boardCiLogLineAt(
  view: BoardCiLogView,
  offset: number,
): { readonly blockId: number; readonly line: number } | null {
  for (const block of view.blocks) {
    const last = block.offsets.length - 1;
    if (last < 0 || offset < block.offsets[0]!) continue;
    if (offset >= block.offsets[last]! + utf8ByteLength(block.lines[last]!) + 1) continue;
    let line = 0;
    while (line < last && block.offsets[line + 1]! <= offset) line++;
    return { blockId: block.id, line };
  }
  return null;
}

/** The read, resumed from the last byte received when the connection comes
    back, ending at the log's end or when it's missing. */
const readCiLogItems = (request: BoardCiLogRequest) => {
  let next: number | undefined = request.fromOffset;
  return subscribeDynamic(BOARD_WS_METHODS.readCiLog, () =>
    Effect.sync(() => ({
      cardId: request.cardId,
      runId: request.runId,
      index: request.index,
      ...(request.follow === undefined ? {} : { follow: request.follow }),
      ...(next === undefined ? {} : { fromOffset: next }),
    })),
  ).pipe(
    Stream.tap((item) =>
      Effect.sync(() => {
        if (item._tag === "chunk") next = item.end;
      }),
    ),
    Stream.takeUntil((item) => item._tag !== "chunk"),
  );
};

/** The viewer's stream: the log folded into a view. */
export const boardCiLogViewStream = (request: BoardCiLogRequest) =>
  readCiLogItems(request).pipe(
    Stream.scan(
      (): BoardCiLogView => EMPTY_BOARD_CI_LOG_VIEW,
      (view, item) => applyBoardCiLogItem(view, item, { alignStart: request.alignStart === true }),
    ),
  );

export interface BoardCiLogDownload {
  readonly status: "loading" | "ended" | "missing";
  readonly parts: ReadonlyArray<string>;
  readonly missingReason: string | null;
}

/** Download's stream: the whole file, from its first byte. */
export const boardCiLogDownloadStream = (
  request: Pick<BoardReadCiLogInput, "cardId" | "runId" | "index">,
) =>
  readCiLogItems({ ...request, fromOffset: 0, follow: false }).pipe(
    Stream.scan(
      (): BoardCiLogDownload => ({ status: "loading", parts: [], missingReason: null }),
      (download, item): BoardCiLogDownload =>
        item._tag === "chunk"
          ? { ...download, parts: [...download.parts, item.text] }
          : item._tag === "end"
            ? { ...download, status: "ended" }
            : { ...download, status: "missing", missingReason: item.reason },
    ),
  );

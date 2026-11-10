/**
 * The CI log viewer (T3O-60, prototype notes 11–12): one script step's log in
 * a modal over the card, following new output while the step runs. Scrolling
 * up pauses following; "jump to latest" or the header toggle resumes it.
 *
 * It holds about the last 2 MiB of a log, rendered in blocks of lines so only
 * the newest block re-renders as output arrives; Download fetches the whole
 * file. `openAt` opens it paused at a byte offset with that line marked.
 */
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  type BoardCiLogBlock,
  type BoardCiLogRequest,
  type BoardCiLogView,
  boardCiLogLineAt,
  boardCiLogText,
} from "@t3tools/client-runtime/state/boardCiLog";
import {
  parseBoardCiProgressLine,
  type BoardCardId,
  type BoardCiPass,
  type EnvironmentId,
} from "@t3tools/contracts";
import { ArrowDownIcon, CopyIcon, DownloadIcon } from "lucide-react";
import { AsyncResult } from "effect/reactivity";
import { memo, useContext, useEffect, useRef, useState } from "react";

import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { toastManager } from "../components/ui/toast";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { observeResize } from "../lib/observeResize";
import { cn } from "../lib/utils";
import { boardEnvironment } from "../state/board";
import {
  BOARD_CI_ANSI_RESET,
  ansiToSegments,
  type BoardCiAnsiSegment,
  type BoardCiAnsiState,
} from "./boardCiAnsi";
import { boardCiLogFileName, boardCiProgressFraction, boardCiProgressLabel } from "./boardCi";

const HEADER_BUTTON_CLASS =
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover px-2 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground disabled:opacity-60";

/** How far before an `openAt` offset the viewer starts reading. */
const OPEN_AT_CONTEXT_BYTES = 64 * 1024;

/** Pixels from the bottom that still count as "at the latest". */
const AT_BOTTOM_PX = 24;

function LogLine({
  segments,
  highlighted,
}: {
  readonly segments: ReadonlyArray<BoardCiAnsiSegment>;
  readonly highlighted: boolean;
}) {
  return (
    <span
      className={cn(highlighted && "bg-warning/20")}
      data-log-target={highlighted ? "" : undefined}
    >
      {segments.map((segment, index) =>
        segment.className === null ? (
          segment.text
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- ANSI segments of one immutable line keep their order
          <span className={segment.className} key={index}>
            {segment.text}
          </span>
        ),
      )}
      {"\n"}
    </span>
  );
}

interface ParsedBlock {
  readonly start: BoardCiAnsiState;
  readonly lines: ReadonlyArray<ReadonlyArray<BoardCiAnsiSegment>>;
  readonly end: BoardCiAnsiState;
}

/** A block's parse, kept per lines array: only the last block's changes as
    output arrives, so the rest are parsed once per starting colour. */
const parsedBlocks = new WeakMap<ReadonlyArray<string>, ParsedBlock>();

/** Each line's segments, a colour running on from one line to the next. */
function blockSegments(lines: ReadonlyArray<string>, start: BoardCiAnsiState): ParsedBlock {
  const cached = parsedBlocks.get(lines);
  if (cached !== undefined && cached.start.fg === start.fg && cached.start.bold === start.bold) {
    return cached;
  }
  const result: Array<ReadonlyArray<BoardCiAnsiSegment>> = [];
  let state = start;
  for (const line of lines) {
    const parsed = ansiToSegments(line, state);
    state = parsed.state;
    result.push(parsed.segments);
  }
  const block = { start, lines: result, end: state };
  parsedBlocks.set(lines, block);
  return block;
}

/** One block of lines, memoized on its parse, which an append replaces only
    in the last block. */
const LogBlock = memo(function LogBlock({
  parsed,
  highlightLine,
}: {
  readonly parsed: ParsedBlock;
  readonly highlightLine: number | null;
}) {
  return (
    <pre className="m-0 font-mono text-[11.5px]/[1.6] whitespace-pre text-foreground [contain-intrinsic-size:auto_320px] [content-visibility:auto]">
      {parsed.lines.map((segments, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- a block's log lines never reorder; the log only appends
        <LogLine highlighted={index === highlightLine} key={index} segments={segments} />
      ))}
    </pre>
  );
});

/** The latest progress line in what's loaded, read from the newest end. */
function latestProgress(view: BoardCiLogView) {
  const fromPartial = view.partial.includes("::t3o-progress::")
    ? parseBoardCiProgressLine(view.partial)
    : null;
  if (fromPartial !== null) return fromPartial;
  for (let block = view.blocks.length - 1; block >= 0; block--) {
    const lines = view.blocks[block]!.lines;
    for (let line = lines.length - 1; line >= 0; line--) {
      if (!lines[line]!.includes("::t3o-progress::")) continue;
      const parsed = parseBoardCiProgressLine(lines[line]!);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function pinToBottom(element: HTMLElement) {
  element.scrollTop = element.scrollHeight;
}

function saveLog(name: string, parts: ReadonlyArray<string>) {
  const url = URL.createObjectURL(new Blob([...parts], { type: "text/plain;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface BoardCiLogTarget {
  readonly pass: BoardCiPass;
  readonly index: number;
  /** The step is running now, so its log grows. */
  readonly live: boolean;
  /** Open paused at this byte of the log, with its line marked. */
  readonly openAt?: { readonly offset: number };
}

export function BoardCiLogDialog({
  environmentId,
  cardId,
  cardKey,
  target,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly cardId: BoardCardId;
  readonly cardKey: string;
  readonly target: BoardCiLogTarget;
  readonly onClose: () => void;
}) {
  const { pass, index, live, openAt } = target;
  const step = pass.steps[index];
  const request: BoardCiLogRequest = {
    cardId,
    runId: pass.runId,
    index,
    follow: true,
    ...(openAt === undefined
      ? {}
      : { fromOffset: Math.max(0, openAt.offset - OPEN_AT_CONTEXT_BYTES), alignStart: true }),
  };
  const result = useAtomValue(boardEnvironment.ciLogAtom({ environmentId, input: request }));
  const view = AsyncResult.isSuccess(result) ? result.value : null;
  const failed = AsyncResult.isFailure(result);

  const [downloading, setDownloading] = useState(false);
  const registry = useContext(RegistryContext);
  const download = () => {
    if (downloading || step === undefined) return;
    setDownloading(true);
    const atom = boardEnvironment.ciLogDownloadAtom({
      environmentId,
      input: { cardId, runId: pass.runId, index },
    });
    const unsubscribe = registry.subscribe(
      atom,
      (next) => {
        if (AsyncResult.isFailure(next)) {
          setDownloading(false);
          queueMicrotask(() => unsubscribe());
          toastManager.add({
            type: "error",
            title: "Download failed",
            description: "The log couldn't be read. Try again.",
          });
          return;
        }
        if (!AsyncResult.isSuccess(next) || next.value.status === "loading") return;
        if (next.value.status === "ended") {
          saveLog(boardCiLogFileName(cardKey, step.name, pass.ordinal), next.value.parts);
        } else {
          toastManager.add({
            type: "error",
            title: "Download failed",
            description: next.value.missingReason ?? "The log is no longer available.",
          });
        }
        setDownloading(false);
        queueMicrotask(() => unsubscribe());
      },
      { immediate: true },
    );
  };

  return (
    <BoardCiLogDialogView
      cardKey={cardKey}
      downloading={downloading}
      failed={failed}
      live={live}
      onClose={onClose}
      onDownload={download}
      openAt={openAt}
      pass={pass}
      stepIndex={index}
      view={view}
    />
  );
}

/** The viewer itself, over a log view the caller keeps current. */
export function BoardCiLogDialogView({
  cardKey,
  pass,
  stepIndex,
  live,
  openAt,
  view,
  failed,
  downloading,
  onDownload,
  onClose,
}: {
  readonly cardKey: string;
  readonly pass: BoardCiPass;
  readonly stepIndex: number;
  readonly live: boolean;
  readonly openAt?: { readonly offset: number } | undefined;
  /** Null while the read opens. */
  readonly view: BoardCiLogView | null;
  /** The read itself failed. */
  readonly failed: boolean;
  readonly downloading: boolean;
  readonly onDownload: () => void;
  readonly onClose: () => void;
}) {
  const step = pass.steps[stepIndex];
  const [following, setFollowing] = useState(openAt === undefined);
  const [pausedAtOffset, setPausedAtOffset] = useState(0);
  // Callback refs: the popup mounts its nodes in a portal after this renders.
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const targetedRef = useRef(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "CI log" });

  const progress = view === null ? null : latestProgress(view);
  const highlight =
    openAt === undefined || view === null ? null : boardCiLogLineAt(view, openAt.offset);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes the log content's size to keep the scroller pinned to the newest output while following
  useEffect(() => {
    if (!following || scroller === null || content === null) return;
    pinToBottom(scroller);
    return observeResize(content, () => pinToBottom(scroller));
  }, [following, scroller, content]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM once to the line `openAt` marks, when it has loaded
  useEffect(() => {
    if (highlight === null || content === null || targetedRef.current) return;
    targetedRef.current = true;
    content.querySelector("[data-log-target]")?.scrollIntoView({ block: "center" });
  }, [highlight, content]);

  const lineCount = view?.lineCount ?? 0;
  const totalLines = lineCount + (view?.droppedLines ?? 0);
  const nextOffset = view?.nextOffset ?? 0;
  // Bytes, not lines: past the size limit the loaded line count stops growing.
  const hasNewOutput = !following && nextOffset > pausedAtOffset;
  const missing = view?.status === "missing" || failed;
  const stillLive = live && view?.status !== "ended" && !missing;

  const pause = () => {
    setFollowing(false);
    setPausedAtOffset(nextOffset);
  };
  const jumpToLatest = () => setFollowing(true);
  const onScroll = () => {
    const element = scroller;
    if (element === null || !following) return;
    const atBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight <= AT_BOTTOM_PX;
    if (!atBottom) pause();
  };

  const fraction = progress === null ? null : boardCiProgressFraction(progress);
  const progressCount = progress === null ? null : boardCiProgressLabel(progress);

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogPopup
        bottomStickOnMobile={false}
        className="h-[min(82vh,900px)] max-w-[min(1100px,96vw)] overflow-hidden p-0"
        showCloseButton
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-border py-2.5 pr-12 pl-4">
          <span className="shrink-0 font-mono text-[12px] text-muted-foreground">›_</span>
          <div className="flex min-w-0 flex-1 flex-col gap-px">
            <DialogTitle className="truncate text-[13px] font-semibold">
              {step?.name ?? "CI step"}
            </DialogTitle>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {step?.command}
            </span>
            <span className="truncate text-[11px] text-muted-foreground">
              {cardKey} · pass {pass.ordinal}
              {stillLive
                ? following
                  ? " · live, following output"
                  : " · live, paused"
                : missing
                  ? ""
                  : " · finished"}
            </span>
          </div>
          {stillLive ? (
            <button
              aria-pressed={following}
              className={cn(
                HEADER_BUTTON_CLASS,
                following && "border-info/40 text-info-foreground",
              )}
              onClick={() => (following ? pause() : jumpToLatest())}
              type="button"
            >
              <ArrowDownIcon className="size-3" />
              {following ? "Following" : "Follow"}
            </button>
          ) : null}
          <button
            className={HEADER_BUTTON_CLASS}
            disabled={view === null || lineCount === 0}
            onClick={() => view !== null && copyToClipboard(boardCiLogText(view), undefined)}
            type="button"
          >
            <CopyIcon className="size-3" />
            {isCopied ? "Copied" : "Copy"}
          </button>
          <button
            className={HEADER_BUTTON_CLASS}
            disabled={downloading || missing}
            onClick={onDownload}
            type="button"
          >
            <DownloadIcon className="size-3" />
            {downloading ? "Downloading…" : "Download"}
          </button>
        </div>
        {progress !== null && (progressCount !== null || progress.message !== null) ? (
          <div className="flex shrink-0 items-center gap-2.5 border-b border-border px-4 py-1.5 text-[11.5px]">
            <span className="min-w-0 truncate text-foreground">{progress.message ?? ""}</span>
            <span className="flex-1" />
            {progressCount === null || progress.done === null ? null : (
              <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
                {progressCount}
              </span>
            )}
            {fraction === null ? null : (
              <span className="h-1 w-32 shrink-0 overflow-hidden rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-info"
                  style={{ width: `${Math.round(fraction * 100)}%` }}
                />
              </span>
            )}
          </div>
        ) : null}
        <div className="relative flex min-h-0 flex-1 flex-col bg-muted/40">
          {missing ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
              <span className="text-[13px] font-semibold text-foreground">
                Log no longer available
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {view?.missingReason ?? "The log couldn't be read."}
              </span>
            </div>
          ) : (
            <div
              aria-label={`${step?.name ?? "CI step"} log`}
              className="min-h-0 flex-1 overflow-auto px-4 py-3"
              onScroll={onScroll}
              ref={setScroller}
              role="log"
            >
              <div ref={setContent}>
                {view?.truncated ? (
                  <div className="mb-2 text-[11px] text-muted-foreground">
                    Older output isn&apos;t shown here. Download for the full log.
                  </div>
                ) : null}
                {view === null || view.status === "loading" ? (
                  <span className="text-[11.5px] text-muted-foreground">Loading the log…</span>
                ) : (
                  <LogBlocks highlight={highlight} view={view} />
                )}
              </div>
            </div>
          )}
          {hasNewOutput ? (
            <button
              className="absolute bottom-3 left-1/2 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-info/40 bg-popover px-3 text-[11.5px] font-medium text-info-foreground shadow-md hover:bg-accent"
              onClick={jumpToLatest}
              type="button"
            >
              ↓ New output · jump to latest
            </button>
          ) : null}
        </div>
        <div className="shrink-0 border-t border-border px-4 py-1.5 text-[11px] text-muted-foreground">
          {totalLines} {totalLines === 1 ? "line" : "lines"}
          {stillLive && following ? " · scroll up to pause following" : ""}
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** Every block's parse, a colour set in one running on into the next and
    into the partial line. */
function parseView(view: BoardCiLogView) {
  let state = BOARD_CI_ANSI_RESET;
  const parsed: Array<{ readonly block: BoardCiLogBlock; readonly result: ParsedBlock }> = [];
  for (const block of view.blocks) {
    const result = blockSegments(block.lines, state);
    state = result.end;
    parsed.push({ block, result });
  }
  return { parsed, partial: blockSegments([view.partial], state) };
}

function LogBlocks({
  view,
  highlight,
}: {
  readonly view: BoardCiLogView;
  readonly highlight: { readonly blockId: number; readonly line: number } | null;
}) {
  const { parsed, partial } = parseView(view);
  return (
    <>
      {parsed.map(({ block, result }) => (
        <LogBlock
          highlightLine={highlight?.blockId === block.id ? highlight.line : null}
          key={block.id}
          parsed={result}
        />
      ))}
      {view.partial.length === 0 ? null : <LogBlock highlightLine={null} parsed={partial} />}
    </>
  );
}

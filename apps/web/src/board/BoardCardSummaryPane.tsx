/**
 * The card modal's read-only Summary pane (Build Summary v3): an overview that
 * answers what happened, whether it is safe, what it cost and what was not done,
 * then collapsed sections to drill into. Actions stay on the rail; this pane only
 * links into View PR, the Review pane and split-parent children.
 */
import type { BoardBuildSummaryCheckStatus, BoardBuildSummaryNoteKind } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Fragment, useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { cn } from "../lib/utils";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import { BoardDecisionLog } from "./BoardDecisionLog";
import { BoardHint } from "./BoardHint";
import type { BoardCardWorkSummary, BoardCardWorkSummaryTone } from "./boardCardWorkSummary";
import type { BoardDecisionLogView } from "./boardDecisionLog";
import {
  deriveBoardSummaryOverview,
  type BoardSummaryChip,
  type BoardSummaryFill,
  type BoardSummarySection,
  type BoardSummarySectionId,
  type BoardSummaryTile,
  type BoardSummaryTone,
} from "./boardSummaryOverview";
import { BoardCardUsageSection } from "./usage/BoardCardUsageSection";
import type { BoardUsageBreakdown } from "./usage/boardUsageBreakdown";
import { boardUsageStageShade } from "./usage/boardUsageFormat";

const TONE_CLASS: Record<BoardCardWorkSummaryTone, string> = {
  success: "bg-success/14 text-success-foreground",
  info: "bg-info/12 text-info-foreground",
  attention: "bg-attention/12 text-attention-foreground",
  warning: "bg-warning/8 text-warning-foreground",
  muted: "bg-muted text-muted-foreground",
};

const CHIP_CLASS: Record<BoardSummaryChip["tone"], string> = {
  success: "bg-success/12 text-success-foreground",
  info: "bg-info/10 text-info-foreground",
  attention: "bg-attention/12 text-attention-foreground",
  warning: "bg-warning/12 text-warning-foreground",
  neutral: "bg-accent text-muted-foreground",
};

const DOT_CLASS: Record<BoardSummaryTone, string | null> = {
  success: "bg-success",
  info: "bg-info",
  attention: "bg-attention",
  warning: "bg-warning",
  none: null,
};

const FILL_CLASS: Record<Exclude<BoardSummaryFill, { readonly shade: number }>, string> = {
  success: "bg-success",
  info: "bg-info",
  attention: "bg-attention",
  warning: "bg-warning",
  neutral: "bg-foreground/14",
};

/** The tile row: up to four tiles, two to a row when the pane itself is narrow. */
const TILE_GRID: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-2 @lg:grid-cols-3",
  4: "grid-cols-2 @lg:grid-cols-4",
};

/** Heads-up tags follow docs/t3o/status-colours.md: a plan change waits on a
    human's read (violet), unfinished work is amber, and a shortcut is neutral —
    blue would claim it is running. */
const NOTE_TAG: Record<BoardBuildSummaryNoteKind, { label: string; className: string }> = {
  plan_change: { label: "Plan change", className: "bg-attention/12 text-attention-foreground" },
  not_done: { label: "Not done", className: "bg-warning/12 text-warning-foreground" },
  shortcut: { label: "Shortcut", className: "bg-accent text-muted-foreground" },
};

/** Failing checks are amber, never red (status-colours.md). */
const CHECK_STYLE: Record<
  BoardBuildSummaryCheckStatus,
  { glyph: string; text: string; verdict: string; flagged: boolean }
> = {
  pass: { glyph: "✓", text: "text-success-foreground", verdict: "Passed", flagged: false },
  fail_preexisting: {
    glyph: "!",
    text: "text-warning-foreground",
    verdict: "Not from this card",
    flagged: true,
  },
  fail: { glyph: "!", text: "text-warning-foreground", verdict: "Failed", flagged: true },
  not_run: { glyph: "–", text: "text-muted-foreground", verdict: "Skipped", flagged: false },
};

const LOOP_GLYPH: Record<BoardCardWorkSummaryTone, { glyph: string; text: string }> = {
  success: { glyph: "✓", text: "text-success-foreground" },
  warning: { glyph: "!", text: "text-warning-foreground" },
  attention: { glyph: "•", text: "text-attention-foreground" },
  info: { glyph: "•", text: "text-info-foreground" },
  muted: { glyph: "–", text: "text-muted-foreground" },
};

const CODE_CLASS =
  "rounded-sm bg-accent px-1 py-px font-mono text-board-12 font-medium wrap-anywhere";

/** Backtick-delimited identifiers as inline code chips; everything else as
    plain text. Deliberately not markdown: the payload asks for backticks and
    nothing more. An unpaired trailing backtick stays literal rather than
    turning the rest of the line into code. */
function InlineCode({ text }: { readonly text: string }) {
  const parts = text.split("`");
  if (parts.length % 2 === 0) {
    const tail = parts.pop();
    parts[parts.length - 1] += `\`${tail}`;
  }
  return (
    <>
      {parts.map((part, index) =>
        part.length === 0 ? null : index % 2 === 1 ? (
          // oxlint-disable-next-line react/no-array-index-key -- split parts of one immutable string keep their order
          <code className={CODE_CLASS} key={index}>
            {part}
          </code>
        ) : (
          // oxlint-disable-next-line react/no-array-index-key -- split parts of one immutable string keep their order
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Chip({ chip }: { readonly chip: BoardSummaryChip }) {
  return (
    <span
      className={cn(
        "whitespace-nowrap rounded-md px-1.75 py-0.5 text-board-11 font-medium",
        CHIP_CLASS[chip.tone],
      )}
    >
      {chip.label}
    </span>
  );
}

function Tile({
  tile,
  onOpen,
}: {
  readonly tile: BoardSummaryTile;
  readonly onOpen: (section: BoardSummarySectionId) => void;
}) {
  const dot = tile.available ? DOT_CLASS[tile.tone] : null;
  const value = (
    <span
      className={cn(
        "text-board-17 font-semibold tabular-nums tracking-board-n1",
        tile.available ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {tile.value}
      {tile.suffix === null ? null : (
        <span className="ml-1.5 text-board-12 font-medium text-muted-foreground">
          {tile.suffix}
        </span>
      )}
    </span>
  );
  return (
    <button
      aria-label={tile.ariaLabel}
      className={cn(
        "flex min-w-0 flex-col items-start gap-1.5 rounded-board-10 border bg-card px-3 pb-3 pt-2.75 text-left",
        tile.available ? "hover:bg-accent" : "cursor-default",
        tile.available && tile.tone === "warning" ? "border-warning/40" : "border-border",
      )}
      data-summary-tile={tile.section}
      disabled={!tile.available}
      onClick={() => onOpen(tile.section)}
      type="button"
    >
      <span className="flex w-full items-center gap-1.5 text-board-10-5 font-semibold uppercase tracking-board-7 text-muted-foreground">
        {tile.label}
        <span className="flex-1" />
        {dot === null ? null : (
          <span aria-hidden="true" className={cn("size-1.75 shrink-0 rounded-full", dot)} />
        )}
      </span>
      {tile.tooltip === null ? value : <BoardHint label={tile.tooltip}>{value}</BoardHint>}
      <span aria-hidden="true" className="flex h-1 w-full gap-0.5">
        {tile.bar.length === 0 ? (
          <span className="flex-1 rounded-xs bg-foreground/6" />
        ) : (
          tile.bar.map((segment, index) => (
            <BoardHint
              // oxlint-disable-next-line react/no-array-index-key -- segments of one tile keep their order
              key={index}
              label={segment.tip}
            >
              <span
                className={cn(
                  "min-w-0.75 rounded-xs",
                  typeof segment.fill === "string" ? FILL_CLASS[segment.fill] : null,
                )}
                style={{
                  flex: `${segment.weight} 1 0`,
                  ...(typeof segment.fill === "string"
                    ? {}
                    : { background: boardUsageStageShade(segment.fill.shade) }),
                }}
              />
            </BoardHint>
          ))
        )}
      </span>
      <span className="w-full min-w-0 truncate text-board-11-5 text-muted-foreground">
        {tile.sub}
      </span>
    </button>
  );
}

function NoteRow({
  kind,
  text,
  detail,
}: {
  readonly kind: BoardBuildSummaryNoteKind;
  readonly text: string;
  readonly detail?: string | undefined;
}) {
  const tag = NOTE_TAG[kind];
  return (
    <li className="grid grid-cols-[92px_minmax(0,1fr)] items-baseline gap-2.5">
      <span
        className={cn(
          "self-start justify-self-start whitespace-nowrap rounded-md px-1.75 py-0.5 text-board-11-5 font-medium",
          tag.className,
        )}
      >
        {tag.label}
      </span>
      <div className="flex min-w-0 flex-col gap-0.75">
        <div className="text-board-13 leading-board-1-55 text-pretty text-foreground">
          <InlineCode text={text} />
        </div>
        {detail !== undefined && detail.trim().length > 0 ? (
          <div className="text-board-12-5/normal text-pretty text-muted-foreground">
            <InlineCode text={detail} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function CheckRow({
  glyph,
  glyphClass,
  name,
  detail,
  verdict,
  flagged,
}: {
  readonly glyph: string;
  readonly glyphClass: string;
  readonly name: React.ReactNode;
  readonly detail: React.ReactNode;
  readonly verdict: string;
  readonly flagged: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-border px-3 py-2.25 first:border-t-0",
        flagged ? "bg-board-warning-tile" : "bg-card",
      )}
    >
      <span
        aria-hidden="true"
        className={cn("pt-px text-center text-board-12 font-bold", glyphClass)}
      >
        {glyph}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-board-12-5 leading-board-1-45 font-medium text-pretty text-foreground">
          {name}
        </span>
        {detail === null ? null : (
          <span className="text-board-12 leading-board-1-45 text-pretty text-muted-foreground">
            {detail}
          </span>
        )}
      </div>
      <span className={cn("whitespace-nowrap pt-0.5 text-board-11 font-medium", glyphClass)}>
        {verdict}
      </span>
    </div>
  );
}

export function BoardCardSummaryPane({
  summary,
  onBackToThread,
  onOpenPullRequest,
  onSelectReview,
  onOpenChild,
  decisionLog = null,
  onSendBack,
  onFollowUp,
  usage = null,
  buildPending = false,
  pastBuild = false,
  integrates = true,
  initialOpen = [],
  savedOpen = null,
  onOpenChange,
}: {
  readonly summary: BoardCardWorkSummary;
  /** The card's usage, when anything about it is known (T3O-77). */
  readonly usage?: BoardUsageBreakdown | null | undefined;
  /** The card's decision log, when it has one. */
  readonly decisionLog?: BoardDecisionLogView | null | undefined;
  readonly onSendBack?: (() => void) | undefined;
  readonly onFollowUp?: (() => void) | undefined;
  /** No build has finished yet: the pane is here for the decision log or usage. */
  readonly buildPending?: boolean;
  /** The card is past the build-role stage: Checks and Heads-up always show. */
  readonly pastBuild?: boolean;
  /** False for an inherit group, which is never reviewed. */
  readonly integrates?: boolean;
  /** Sections the opener asked for, such as Usage from a spend popover. */
  readonly initialOpen?: ReadonlyArray<BoardSummarySectionId>;
  /** Sections open when the pane last unmounted; null on the card's first visit. */
  readonly savedOpen?: ReadonlySet<BoardSummarySectionId> | null;
  readonly onOpenChange?: ((open: ReadonlySet<BoardSummarySectionId>) => void) | undefined;
  readonly onBackToThread: () => void;
  readonly onOpenPullRequest: (url: string) => void;
  readonly onSelectReview: () => void;
  readonly onOpenChild?: ((childCardId: string) => void) | undefined;
}) {
  const { verdict, review, build, pullRequest } = summary;
  const overview = deriveBoardSummaryOverview({
    summary,
    decisionLog,
    usage,
    pastBuild,
    integrates,
  });
  const [open, setOpenState] = useState<ReadonlySet<BoardSummarySectionId>>(
    () => savedOpen ?? new Set([...overview.initiallyOpen, ...initialOpen]),
  );
  const setOpen = (next: ReadonlySet<BoardSummarySectionId>) => {
    setOpenState(next);
    onOpenChange?.(next);
  };
  const columnRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<BoardSummarySectionId, HTMLButtonElement>());
  const idPrefix = useId();

  // Scrolls the pane's own column, not scrollIntoView, so the dialog around it stays put.
  const reveal = (section: BoardSummarySectionId) => {
    const column = columnRef.current;
    const row = rowRefs.current.get(section);
    if (column === null || row === undefined) return;
    row.focus({ preventScroll: true });
    const offset = row.getBoundingClientRect().top - column.getBoundingClientRect().top;
    column.scrollTo({ top: column.scrollTop + offset });
  };
  const openSection = (section: BoardSummarySectionId) => {
    flushSync(() => setOpen(new Set(open).add(section)));
    reveal(section);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM to a section the opener asked for, once on the card's first visit
  useEffect(() => {
    if (savedOpen !== null) return;
    onOpenChange?.(open);
    const first = initialOpen[0];
    if (first !== undefined) reveal(first);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- mount only: a later prop change must not yank the scroll.
  }, []);

  const toggle = (section: BoardSummarySectionId) => {
    const next = new Set(open);
    if (next.has(section)) next.delete(section);
    else next.add(section);
    setOpen(next);
  };
  const present = overview.sections.map((section) => section.id);
  const anyOpen = present.some((id) => open.has(id));

  const structured = build.structured;
  const lead = structured?.lead ?? build.summary;
  const pullRequestUrl = pullRequest.url;
  const showPullRequest =
    !pullRequest.empty && pullRequest.number !== null && pullRequestUrl !== null;
  const children = build.children !== null && build.children.total > 0 ? build.children : null;
  const notDone = overview.notDone;

  const body = (section: BoardSummarySection) => {
    switch (section.id) {
      case "notes":
        return (
          <ul className="flex flex-col gap-2.5">
            {overview.notes.map((note, index) => (
              <NoteRow
                detail={note.detail}
                // oxlint-disable-next-line react/no-array-index-key -- notes have no identity besides their position in the summary
                key={index}
                kind={note.kind}
                text={note.text}
              />
            ))}
          </ul>
        );
      case "checks": {
        const loopStyle = review.loop === null ? null : LOOP_GLYPH[review.loop.tone];
        const { raised, fixed, rejected, open: openCount, disputed, escalated } = review.counts;
        const settled = !review.empty && openCount + disputed + escalated === 0;
        return (
          <div className="flex flex-col overflow-hidden rounded-board-9 border border-border">
            {overview.checks.map((check, index) => {
              const style = CHECK_STYLE[check.status];
              return (
                <CheckRow
                  detail={
                    check.detail.trim().length > 0 ? <InlineCode text={check.detail} /> : null
                  }
                  flagged={style.flagged}
                  glyph={style.glyph}
                  glyphClass={style.text}
                  // oxlint-disable-next-line react/no-array-index-key -- checks have no identity besides their position in the summary
                  key={index}
                  name={<InlineCode text={check.name} />}
                  verdict={style.verdict}
                />
              );
            })}
            {overview.showReview ? (
              <CheckRow
                detail={[
                  `${raised} raised · ${fixed} fixed · ${rejected} rejected`,
                  ...(openCount > 0 ? [`${openCount} open`] : []),
                  ...(disputed > 0 ? [`${disputed} disputed`] : []),
                  ...(escalated > 0 ? [`${escalated} escalated`] : []),
                ].join(" · ")}
                flagged={false}
                glyph={loopStyle?.glyph ?? (settled ? "✓" : "–")}
                glyphClass={
                  loopStyle?.text ?? (settled ? "text-success-foreground" : "text-muted-foreground")
                }
                name={`Review: round ${review.empty ? 1 : review.currentRound} of ${review.maxRounds}`}
                verdict={review.loop?.label ?? (settled ? "Settled" : "Open")}
              />
            ) : null}
            {review.outstanding.map((finding) => (
              <button
                className="grid grid-cols-[12px_minmax(0,1fr)_auto] items-start gap-2.5 border-t border-border bg-card px-3 py-2.25 text-left first:border-t-0 hover:bg-accent"
                key={finding.id}
                onClick={onSelectReview}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className="pt-px text-center text-board-12 font-bold text-warning-foreground"
                >
                  •
                </span>
                <span className="min-w-0 text-board-12-5 leading-board-1-45 text-pretty text-foreground">
                  {finding.title}
                </span>
                <span className="whitespace-nowrap pt-0.5 text-board-11 font-medium text-warning-foreground">
                  Open ›
                </span>
              </button>
            ))}
          </div>
        );
      }
      case "built":
        return (
          <div className="flex flex-col gap-3.5">
            {children !== null ? (
              <div className="flex flex-col gap-1">
                <div className="text-board-12-5 font-semibold text-muted-foreground">
                  {children.done} of {children.total} {children.total === 1 ? "plan" : "plans"} done
                </div>
                <ul className="flex flex-col">
                  {children.rows.map((row) => {
                    const childId = row.cardId;
                    const openChild =
                      childId !== null && onOpenChild !== undefined
                        ? () => onOpenChild(childId)
                        : undefined;
                    const openable = openChild !== undefined;
                    return (
                      <li key={row.key}>
                        <button
                          className={cn(
                            "-mx-1.5 flex w-[calc(100%+12px)] items-center justify-between gap-2 rounded-md px-1.5 py-0.5 text-left text-board-13 leading-board-1-6",
                            openable
                              ? "text-foreground hover:bg-accent"
                              : "cursor-default text-foreground",
                          )}
                          disabled={!openable}
                          onClick={openChild}
                          type="button"
                        >
                          <span className="font-medium">{row.key}</span>
                          <span className="text-board-11-5 text-muted-foreground">
                            {row.stageLabel}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {build.areaCount > 0 ? (
              <div className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-4 gap-y-3.5">
                {structured?.areas.map((area, areaIndex) =>
                  area.items.length === 0 ? null : (
                    // oxlint-disable-next-line react/no-array-index-key -- areas have no identity besides their position in the summary
                    <Fragment key={areaIndex}>
                      <div className="flex min-w-0 flex-col gap-px pt-px">
                        <span className="text-board-12-5 font-semibold text-foreground wrap-anywhere">
                          <InlineCode text={area.name} />
                        </span>
                        <span className="text-board-11-5 text-muted-foreground">
                          {area.items.length} {area.items.length === 1 ? "change" : "changes"}
                        </span>
                      </div>
                      <ul className="flex min-w-0 flex-col gap-0.75">
                        {area.items.map((item, itemIndex) => (
                          <li
                            className="flex items-baseline gap-2.25 text-board-13 leading-board-1-55 text-foreground"
                            // oxlint-disable-next-line react/no-array-index-key -- items have no identity besides their position in the area
                            key={itemIndex}
                          >
                            <span
                              aria-hidden="true"
                              className="size-1 flex-none -translate-y-0.75 rounded-full bg-muted-foreground"
                            />
                            <span className="min-w-0 text-pretty">
                              <InlineCode text={item} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </Fragment>
                  ),
                )}
              </div>
            ) : null}
          </div>
        );
      case "decisions":
        return decisionLog === null ? null : (
          <BoardDecisionLog onFollowUp={onFollowUp} onSendBack={onSendBack} view={decisionLog} />
        );
      case "usage":
        return usage === null ? null : <BoardCardUsageSection breakdown={usage} />;
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-5.5 pr-3">
        <SectionHeading>{buildPending ? "Summary" : "Build summary"}</SectionHeading>
        <span className="flex-1" />
        <button
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-board-7 border border-input bg-popover pl-1.5 pr-2.5 text-board-11-5 font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
          onClick={onBackToThread}
          type="button"
        >
          <ChevronLeftIcon className="size-3" />
          Back to thread
        </button>
      </div>
      {/* Every child of the scroll column is shrink-0 and unclipped: a clipped
          flex child loses its automatic min-height and collapses when later
          content overflows. */}
      <div
        className="@container flex min-h-0 flex-1 flex-col overflow-y-auto text-board-13 *:shrink-0"
        data-summary-scroll
        ref={columnRef}
      >
        <div className="flex flex-col gap-4 px-5.5 pb-5 pt-5">
          <div className="flex flex-col gap-2.25">
            {lead !== null ? (
              <p className="text-board-15 leading-board-1-55 font-medium text-pretty text-foreground">
                <InlineCode text={lead} />
              </p>
            ) : buildPending ? (
              <p className="text-board-12-5/normal text-muted-foreground">
                The build summary appears here when the build finishes.
              </p>
            ) : build.empty ? (
              <p className="text-board-15/normal text-muted-foreground">No build summary</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-board-12 text-muted-foreground">
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-md px-1.75 py-0.5 text-board-11-5 font-medium",
                  TONE_CLASS[verdict.tone],
                )}
              >
                {verdict.label}
              </span>
              {showPullRequest ? (
                <>
                  <BoardHint label={pullRequest.title}>
                    <button
                      className="font-medium text-info-foreground hover:underline"
                      onClick={() => onOpenPullRequest(pullRequestUrl)}
                      type="button"
                    >
                      #{pullRequest.number}
                    </button>
                  </BoardHint>
                  {pullRequest.baseRef !== null && pullRequest.headBranch !== null ? (
                    <span className="min-w-0 font-mono text-board-11-5 wrap-anywhere">
                      {pullRequest.baseRef} ← {pullRequest.headBranch}
                    </span>
                  ) : null}
                </>
              ) : null}
            </div>
          </div>

          <div className={cn("grid gap-2", TILE_GRID[overview.tiles.length])}>
            {overview.tiles.map((tile) => (
              <Tile key={tile.label} onOpen={openSection} tile={tile} />
            ))}
          </div>

          {notDone.length > 0 ? (
            <div
              className="flex flex-col gap-1.5 rounded-board-10 border border-warning/30 bg-board-warning-tile px-3 py-2.5"
              data-summary-not-done
            >
              <div className="flex items-center gap-2">
                <span className="text-board-12 font-semibold text-warning-foreground">
                  {notDone.length === 1
                    ? "1 thing wasn't done"
                    : `${notDone.length} things weren't done`}
                </span>
                <span className="flex-1" />
                <button
                  className="h-5.5 rounded-md px-1.5 text-board-11-5 font-medium text-warning-foreground hover:bg-warning/10"
                  onClick={() => openSection("notes")}
                  type="button"
                >
                  Details ›
                </button>
              </div>
              <ul className="flex flex-col gap-0.5">
                {notDone.map((text, index) => (
                  <li
                    className="flex items-baseline gap-2 text-board-12-5 leading-board-1-55 text-foreground"
                    // oxlint-disable-next-line react/no-array-index-key -- not-done notes have no identity besides their position
                    key={index}
                  >
                    <span
                      aria-hidden="true"
                      className="size-1 flex-none -translate-y-0.5 rounded-full bg-warning-foreground"
                    />
                    <span className="min-w-0 text-pretty">
                      <InlineCode text={text} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>

        {overview.sections.length > 0 ? (
          <div className="flex items-center gap-2 border-t border-border bg-muted px-5.5 py-2">
            <span className="text-board-10-5 font-semibold uppercase tracking-board-7 text-muted-foreground">
              Details
            </span>
            <span className="flex-1" />
            <button
              className="h-5.5 rounded-md px-1.5 text-board-11-5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setOpen(anyOpen ? new Set() : new Set(present))}
              type="button"
            >
              {anyOpen ? "Collapse all" : "Expand all"}
            </button>
          </div>
        ) : null}

        {overview.sections.map((section) => {
          const isOpen = open.has(section.id);
          const bodyId = `${idPrefix}-${section.id}`;
          return (
            <div
              className="border-t border-border"
              data-summary-section={section.id}
              key={section.id}
            >
              <button
                aria-controls={isOpen ? bodyId : undefined}
                aria-expanded={isOpen}
                className={cn(
                  "flex min-h-11.5 w-full items-center gap-2.25 px-5.5 py-2 text-left hover:bg-accent",
                  isOpen && "bg-muted",
                )}
                onClick={() => toggle(section.id)}
                ref={(element) => {
                  if (element === null) rowRefs.current.delete(section.id);
                  else rowRefs.current.set(section.id, element);
                }}
                type="button"
              >
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    isOpen && "rotate-90",
                  )}
                />
                <span className="whitespace-nowrap text-board-13 font-semibold text-foreground">
                  {section.name}
                </span>
                <span className="min-w-0 truncate text-board-12 text-muted-foreground">
                  {section.count}
                </span>
                <span className="flex-1" />
                <span className="flex flex-wrap justify-end gap-1.25">
                  {section.chips.map((chip, chipIndex) => (
                    <Chip chip={chip} key={`${chipIndex}:${chip.label}`} />
                  ))}
                </span>
              </button>
              {isOpen ? (
                <div className="flex flex-col gap-3 pb-4.5 pl-11 pr-5.5 pt-0.5" id={bodyId}>
                  {body(section)}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

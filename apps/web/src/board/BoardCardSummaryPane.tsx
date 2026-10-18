/**
 * The card modal's Summary pane (T3O-5, redesigned T3O-21): a read-only recap
 * of how the work went — the build agent's lead sentence over one meta line
 * (verdict, review, PR), then Heads-up notes, open findings, check tiles and
 * what was built. Merge / Another review round / View PR stay on the rail;
 * this pane only links into View PR, the Review pane (open findings), and a
 * split-parent child (same as the Plans panel).
 */
import type { BoardBuildSummaryCheckStatus, BoardBuildSummaryNoteKind } from "@t3tools/contracts";
import { ChevronLeftIcon } from "lucide-react";
import { Fragment } from "react";

import { cn } from "../lib/utils";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import { BoardHint } from "./BoardHint";
import type { BoardCardWorkSummary, BoardCardWorkSummaryTone } from "./boardCardWorkSummary";

const TONE_CLASS: Record<BoardCardWorkSummaryTone, string> = {
  success: "bg-success/14 text-success-foreground",
  info: "bg-info/12 text-info-foreground",
  attention: "bg-attention/12 text-attention-foreground",
  warning: "bg-warning/8 text-warning-foreground",
  muted: "bg-muted text-muted-foreground",
};

/** Heads-up tags follow docs/t3o/status-colours.md: a plan change waits on a
    human's read (violet), unfinished work is amber, and a shortcut is neutral —
    blue would claim it is running. */
const NOTE_TAG: Record<BoardBuildSummaryNoteKind | "open", { label: string; className: string }> = {
  plan_change: { label: "Plan change", className: "bg-attention/12 text-attention-foreground" },
  not_done: { label: "Not done", className: "bg-warning/12 text-warning-foreground" },
  shortcut: { label: "Shortcut", className: "bg-foreground/6 text-muted-foreground" },
  open: { label: "Open", className: "bg-warning/12 text-warning-foreground" },
};

/** Failing checks are amber, never red (status-colours.md). */
const CHECK_STYLE: Record<
  BoardBuildSummaryCheckStatus,
  { glyph: string; icon: string; tile: string }
> = {
  pass: { glyph: "✓", icon: "text-success-foreground", tile: "border-border bg-card" },
  not_run: { glyph: "–", icon: "text-muted-foreground", tile: "border-border bg-card" },
  fail_preexisting: {
    glyph: "!",
    icon: "text-warning-foreground",
    tile: "border-border bg-[color-mix(in_srgb,var(--warning)_7%,var(--card))]",
  },
  fail: {
    glyph: "!",
    icon: "text-warning-foreground",
    tile: "border-warning/55 bg-[color-mix(in_srgb,var(--warning)_7%,var(--card))]",
  },
};

const CODE_CLASS = "rounded-[4px] bg-accent px-1 py-px font-mono text-[12px] font-medium";

/** Backtick-delimited identifiers as inline code chips; everything else as
    plain text. Deliberately not markdown: the payload asks for backticks and
    nothing more. */
function InlineCode({ text }: { readonly text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        part.length === 0 ? null : index % 2 === 1 ? (
          <code className={CODE_CLASS} key={index}>
            {part}
          </code>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Heading({ children }: { readonly children: React.ReactNode }) {
  return <h4 className="text-[12px] font-semibold text-foreground">{children}</h4>;
}

function NoteRow({
  kind,
  children,
  detail,
}: {
  readonly kind: BoardBuildSummaryNoteKind | "open";
  readonly children: React.ReactNode;
  readonly detail?: string | undefined;
}) {
  const tag = NOTE_TAG[kind];
  return (
    <li className="grid grid-cols-[96px_minmax(0,1fr)] items-baseline gap-2.5">
      <span
        className={cn(
          "self-start justify-self-start whitespace-nowrap rounded-md px-[7px] py-0.5 text-[11.5px] font-medium",
          tag.className,
        )}
      >
        {tag.label}
      </span>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <div className="text-[13px]/[1.55] text-pretty text-foreground">{children}</div>
        {detail !== undefined && detail.trim().length > 0 ? (
          <div className="text-[12.5px]/[1.5] text-muted-foreground">{detail}</div>
        ) : null}
      </div>
    </li>
  );
}

function Separator() {
  return <span aria-hidden="true">·</span>;
}

export function BoardCardSummaryPane({
  summary,
  onBackToThread,
  onOpenPullRequest,
  onSelectReview,
  onOpenChild,
}: {
  readonly summary: BoardCardWorkSummary;
  readonly onBackToThread: () => void;
  readonly onOpenPullRequest: (url: string) => void;
  readonly onSelectReview: () => void;
  readonly onOpenChild?: ((childCardId: string) => void) | undefined;
}) {
  const { verdict, review, build, pullRequest } = summary;
  const structured = build.structured;
  const lead = structured?.lead ?? build.summary;
  const pullRequestUrl = pullRequest.url;
  const showPullRequest =
    !pullRequest.empty && pullRequest.number !== null && pullRequestUrl !== null;
  const children = build.children !== null && build.children.total > 0 ? build.children : null;
  const showBuilt = children !== null || build.areaCount > 0;
  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-[22px] pr-3">
        <SectionHeading>Build summary</SectionHeading>
        <span className="flex-1" />
        <button
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover pl-1.5 pr-2.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
          onClick={onBackToThread}
          type="button"
        >
          <ChevronLeftIcon className="size-3" />
          Back to thread
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-[22px] pb-8 pt-5 text-[13px]">
        <div className="flex flex-col gap-2.5">
          {lead !== null ? (
            <p className="text-[15px]/[1.5] font-medium text-pretty text-foreground">
              <InlineCode text={lead} />
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <span
              className={cn(
                "inline-flex shrink-0 items-center rounded-md px-[7px] py-0.5 text-[11.5px] font-medium",
                TONE_CLASS[verdict.tone],
              )}
            >
              {verdict.label}
            </span>
            {review.empty ? null : (
              <>
                <span>
                  Review round {review.currentRound} of {review.maxRounds}
                </span>
                <Separator />
                <span>
                  {review.counts.raised} raised · {review.counts.fixed} fixed ·{" "}
                  {review.counts.rejected} rejected
                  {review.counts.open > 0 ? ` · ${review.counts.open} open` : ""}
                  {review.counts.disputed > 0 ? ` · ${review.counts.disputed} disputed` : ""}
                </span>
              </>
            )}
            {showPullRequest ? (
              <>
                {review.empty ? null : <Separator />}
                <BoardHint label={pullRequest.title}>
                  <button
                    className="text-info-foreground hover:underline"
                    onClick={() => onOpenPullRequest(pullRequestUrl)}
                    type="button"
                  >
                    #{pullRequest.number}
                  </button>
                </BoardHint>
                {pullRequest.baseRef !== null && pullRequest.headBranch !== null ? (
                  <span className="font-mono text-[11.5px]">
                    {pullRequest.baseRef} ← {pullRequest.headBranch}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        {structured !== null && structured.notes.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <Heading>Heads-up</Heading>
            <ul className="flex flex-col gap-2.5">
              {structured.notes.map((note, index) => (
                <NoteRow detail={note.detail} key={index} kind={note.kind}>
                  <InlineCode text={note.text} />
                </NoteRow>
              ))}
            </ul>
          </div>
        ) : null}

        {review.outstanding.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <Heading>Open findings</Heading>
            <ul className="flex flex-col gap-1.5">
              {review.outstanding.map((finding) => (
                <NoteRow key={finding.id} kind="open">
                  <button
                    className="w-full text-left hover:underline"
                    onClick={onSelectReview}
                    type="button"
                  >
                    {finding.title}
                  </button>
                </NoteRow>
              ))}
            </ul>
          </div>
        ) : null}

        {structured !== null && structured.checks.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            <Heading>Checks</Heading>
            <ul className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-2">
              {structured.checks.map((check, index) => {
                const style = CHECK_STYLE[check.status];
                return (
                  <li
                    className={cn(
                      "flex flex-col gap-[3px] rounded-lg border px-[11px] py-[9px]",
                      style.tile,
                    )}
                    key={index}
                  >
                    <div className="flex items-baseline gap-[7px]">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "w-3 flex-none text-center text-[12px] font-bold",
                          style.icon,
                        )}
                      >
                        {style.glyph}
                      </span>
                      <span className="text-[12.5px]/[1.4] font-medium text-foreground">
                        <InlineCode text={check.name} />
                      </span>
                    </div>
                    {check.detail.trim().length > 0 ? (
                      <div className="pl-[19px] text-[12px]/[1.45] text-pretty text-muted-foreground">
                        {check.detail}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {showBuilt ? (
          <div className="flex flex-col gap-3.5">
            <div className="flex items-baseline gap-2">
              <Heading>What was built</Heading>
              {build.areaCount > 0 ? (
                <span className="text-[12px] text-muted-foreground">
                  {build.changeCount} {build.changeCount === 1 ? "change" : "changes"} across{" "}
                  {build.areaCount} {build.areaCount === 1 ? "area" : "areas"}
                </span>
              ) : null}
            </div>
            {children !== null ? (
              <div className="flex flex-col gap-1">
                <div className="text-[12.5px] font-semibold text-muted-foreground">
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
                            "-mx-1.5 flex w-[calc(100%+12px)] items-center justify-between gap-2 rounded-md px-1.5 py-0.5 text-left text-[13px]/[1.6]",
                            openable
                              ? "text-foreground hover:bg-accent"
                              : "cursor-default text-foreground",
                          )}
                          disabled={!openable}
                          onClick={openChild}
                          type="button"
                        >
                          <span className="font-medium">{row.key}</span>
                          <span className="text-[11.5px] text-muted-foreground">
                            {row.stageLabel}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {structured?.areas.map((area, areaIndex) =>
              area.items.length === 0 ? null : (
                <div className="flex flex-col gap-1" key={areaIndex}>
                  <div className="text-[12.5px] font-semibold text-muted-foreground">
                    <InlineCode text={area.name} />
                  </div>
                  <ul className="flex flex-col">
                    {area.items.map((item, itemIndex) => (
                      <li
                        className="flex items-baseline gap-[9px] text-[13px]/[1.6] text-foreground"
                        key={itemIndex}
                      >
                        <span
                          aria-hidden="true"
                          className="size-1 flex-none -translate-y-[3px] rounded-full bg-muted-foreground"
                        />
                        <span className="text-pretty">
                          <InlineCode text={item} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

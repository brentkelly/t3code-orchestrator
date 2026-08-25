/**
 * The card modal's Review pane (t3o-16, D9): the adversarial review loop,
 * rendered from the prototype's design (`.plans/prototype/t3o.dc.html`,
 * `reviewVm`) over the card's real step completions — the same opaque
 * payloads the agents write, folded by `deriveBoardReviewLoop`.
 *
 * The shipped loop has three phases (review / triage / adjudicate); the
 * prototype's separate "reviewer re-assessment" step was folded into
 * adjudication before the contracts landed, so the pane shows three.
 *
 * Lazy, like the plan pane — a card that never reaches review pays nothing.
 */
import {
  BOARD_REVIEW_PHASE_IDS,
  type BoardReviewPhaseId,
  type BoardStepCompletion,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronLeftIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import {
  deriveBoardReviewLoop,
  type BoardReviewLoop,
  type BoardReviewLoopRound,
  type BoardReviewLoopFinding,
  type BoardReviewPhaseStatus,
} from "./boardReviewLoop";

const PHASE_NAMES: Record<BoardReviewPhaseId, string> = {
  review: "Fresh-eyes review",
  triage: "Triage & respond",
  adjudicate: "Adjudication",
};

const SEVERITY_STYLES: Record<BoardReviewLoopFinding["finding"]["severity"], string> = {
  critical: "bg-destructive/12 text-destructive-foreground",
  improvement: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
  nitpick: "bg-muted text-muted-foreground",
};

const RESOLUTION_LABELS: Record<BoardReviewLoopFinding["resolution"], string> = {
  open: "open",
  fixed: "fixed",
  rejected: "rejected",
  disputed: "disputed",
};

const RESOLUTION_STYLES: Record<BoardReviewLoopFinding["resolution"], string> = {
  open: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  fixed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  rejected: "border-border bg-muted text-muted-foreground",
  disputed: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
};

/** A finding's row: severity chip, title and file, then where it stands. */
function FindingRow({ entry }: { readonly entry: BoardReviewLoopFinding }) {
  const { finding } = entry;
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 -mx-2">
      <span
        className={cn(
          "mt-px inline-flex h-4 shrink-0 items-center rounded-[5px] px-1.5 text-[10px] font-medium uppercase tracking-[.03em]",
          SEVERITY_STYLES[finding.severity],
        )}
      >
        {finding.severity}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12.5px]/[1.45] text-pretty text-foreground">{finding.title}</span>
        {finding.file !== null ? (
          <span className="truncate font-mono text-[10.5px] text-muted-foreground">
            {finding.file}
            {finding.line !== null ? `:${finding.line}` : ""}
          </span>
        ) : null}
        {entry.dispositionNote.trim().length > 0 || entry.verdictNote.trim().length > 0 ? (
          <span className="text-[11px]/[1.4] text-muted-foreground">
            {entry.verdictNote.trim().length > 0 ? entry.verdictNote : entry.dispositionNote}
          </span>
        ) : null}
      </div>
      <span
        className={cn(
          "inline-flex h-[18px] shrink-0 items-center rounded-md border px-[7px] text-[10.5px] font-medium",
          RESOLUTION_STYLES[entry.resolution],
        )}
      >
        {RESOLUTION_LABELS[entry.resolution]}
      </span>
    </div>
  );
}

/** The step marker: a numbered dot at rest, a spinner while the phase runs. */
function PhaseMarker({
  index,
  status,
}: {
  readonly index: number;
  readonly status: BoardReviewPhaseStatus;
}) {
  if (status === "running") {
    return (
      <span
        className="size-5 shrink-0 animate-spin rounded-full border-2 border-foreground/15 border-t-foreground"
        title="Running now"
      />
    );
  }
  return (
    <span
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
        status === "done"
          ? "bg-foreground/8 text-foreground"
          : "text-muted-foreground/70 shadow-[inset_0_0_0_1px_var(--border)]",
      )}
    >
      {index}
    </span>
  );
}

/** The per-phase prose, written from the round's actual numbers. */
function phaseNote(
  round: BoardReviewLoopRound,
  phase: BoardReviewPhaseId,
  status: BoardReviewPhaseStatus,
): string {
  const { counts, severities, findings } = round;
  const blocking = severities.critical + severities.improvement;
  if (phase === "review") {
    if (status === "running") return "A fresh thread is reading the diff with no history of it.";
    if (status === "done") {
      if (round.reviewMalformed) return "Recorded a payload nothing can read.";
      if (findings.length === 0) return "No findings — nothing blocks.";
      return `${findings.length} ${findings.length === 1 ? "issue" : "issues"} recorded, ${blocking} blocking.`;
    }
    return "Not started.";
  }
  if (phase === "triage") {
    if (status === "skipped") return "Nothing to triage — the review came back clean.";
    if (status === "running")
      return `${counts.fixed} fixed, ${counts.rejected} rejected, ${counts.open} still being worked.`;
    if (status === "done")
      return `${counts.fixed} fixed, ${counts.rejected} rejected with a written rationale.`;
    return "Not started.";
  }
  if (status === "skipped") return "Only runs when a finding blocks the round.";
  if (status === "running") return "An independent adjudicator is checking the fixes.";
  if (status === "done")
    return counts.disputed > 0
      ? `${counts.disputed} ${counts.disputed === 1 ? "response" : "responses"} disputed — the next round re-reads them.`
      : "Every response held up.";
  return "Not started.";
}

function roundBadge(round: BoardReviewLoopRound): { label: string; className: string } {
  switch (round.outcome) {
    case "in-progress":
      return { label: "In progress", className: "border-border bg-muted text-muted-foreground" };
    case "clean":
      return {
        label: "Clean",
        className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      };
    case "changes-requested":
      return {
        label: "Changes requested",
        className: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
      };
    case "unreadable":
      return {
        label: "Unreadable",
        className: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
      };
  }
}

function roundSummary(round: BoardReviewLoopRound): string {
  if (round.reviewMalformed) return "reviewer payload unreadable";
  if (round.findings.length === 0) return round.outcome === "in-progress" ? "" : "no findings";
  const parts = [`${round.counts.fixed} fixed`, `${round.counts.rejected} rejected`];
  if (round.counts.open > 0) parts.push(`${round.counts.open} open`);
  if (round.counts.disputed > 0) parts.push(`${round.counts.disputed} disputed`);
  return parts.join(" · ");
}

function Round({
  round,
  open,
  onToggle,
  onOpenThread,
}: {
  readonly round: BoardReviewLoopRound;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: ((threadId: ThreadId) => void) | undefined;
}) {
  const badge = roundBadge(round);
  const tally = `${round.severities.critical} / ${round.severities.improvement} / ${round.severities.nitpick}`;
  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      <button
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2.5 text-left",
          round.outcome === "in-progress" ? "bg-foreground/2" : "",
        )}
        onClick={onToggle}
        type="button"
      >
        <span className="shrink-0 text-[12.5px] font-semibold text-foreground">
          Round {round.round}
        </span>
        <span
          className={cn(
            "inline-flex h-[18px] shrink-0 items-center rounded-md border px-[7px] text-[10.5px] font-medium",
            badge.className,
          )}
        >
          {badge.label}
        </span>
        {round.findings.length > 0 ? (
          <span
            className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-foreground/6 px-1.5 font-mono text-[10.5px] font-medium tracking-[.02em] text-muted-foreground"
            title={`${round.severities.critical} critical · ${round.severities.improvement} improvement · ${round.severities.nitpick} nitpick`}
          >
            {tally}
          </span>
        ) : null}
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {roundSummary(round)}
        </span>
        <span className="flex-1" />
        {round.completedAt !== null ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {formatRelativeTimeLabel(round.completedAt)}
          </span>
        ) : null}
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open ? "rotate-180" : "",
          )}
        />
      </button>
      {open ? (
        <div className="flex flex-col">
          {BOARD_REVIEW_PHASE_IDS.map((phaseId, index) => {
            const phase = round.phases.find((p) => p.phase === phaseId);
            if (phase === undefined) return null;
            return (
              <div key={phaseId} className="border-t border-border">
                <div className="flex items-start gap-2.5 px-3 py-2.5">
                  <PhaseMarker index={index + 1} status={phase.status} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-[12.5px] font-medium text-foreground">
                      {PHASE_NAMES[phaseId]}
                    </span>
                    <span className="text-[11.5px]/[1.5] text-pretty text-muted-foreground">
                      {phaseNote(round, phaseId, phase.status)}
                    </span>
                  </div>
                  {phase.threadId !== null && onOpenThread !== undefined ? (
                    <button
                      className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[7px] border border-input bg-popover px-2 text-[11.5px] font-medium text-foreground shadow-xs hover:bg-accent"
                      onClick={() => onOpenThread(phase.threadId as ThreadId)}
                      title="Open this phase's thread"
                      type="button"
                    >
                      <MessageSquareIcon className="size-3" />
                      Thread
                    </button>
                  ) : null}
                </div>
                {phaseId === "review" && round.findings.length > 0 ? (
                  <div className="flex flex-col gap-0.5 pb-3 pl-[42px] pr-3 pt-0.5">
                    {round.findings.map((entry) => (
                      <FindingRow key={entry.finding.id} entry={entry} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function statusPill(
  loop: BoardReviewLoop,
  live: boolean,
): { label: string; spinning: boolean; className: string } {
  switch (loop.status) {
    case "running": {
      const phase = loop.next === null ? "Review" : PHASE_NAMES[loop.next.phase];
      return live
        ? {
            label: `${phase} · running now`,
            spinning: true,
            className: "bg-accent text-foreground",
          }
        : {
            label: `${phase} · waiting to run`,
            spinning: false,
            className: "bg-accent text-muted-foreground",
          };
    }
    case "converged":
      return {
        label: "Loop settled — nothing blocking",
        spinning: false,
        className: "bg-emerald-500/14 text-emerald-700 dark:text-emerald-300",
      };
    case "round-cap":
      return {
        label: "Loop ended at the round cap — findings still open",
        spinning: false,
        className: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
      };
    case "unreadable":
      return {
        label: "Reviewer payload unreadable",
        spinning: false,
        className: "bg-destructive/12 text-destructive-foreground",
      };
  }
}

function footerNote(loop: BoardReviewLoop): string {
  switch (loop.status) {
    case "running":
      return `Round ${loop.currentRound} of ${loop.maxRounds} · the loop stops early once a round closes clean.`;
    case "converged":
      return "A round closed with nothing blocking, so the loop is settled.";
    case "round-cap":
      return "Every round ran without a clean pass, so the loop ended at its cap — the open findings above ride along to the next stage.";
    case "unreadable":
      return "A review phase recorded a payload nothing can read, so the loop halted here.";
  }
}

export function BoardCardReviewPane({
  completions,
  maxRounds,
  live,
  onBackToThread,
  onOpenThread,
}: {
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  /** The configured round cap (the review stage's `rounds`). */
  readonly maxRounds: number;
  /** Whether the card's active thread is working — the difference between a
      due phase spinning "running now" and resting "waiting to run". */
  readonly live: boolean;
  readonly onBackToThread: () => void;
  /** Deep-link into a phase's thread; absent when the pane has no thread pane
      to hand off to. */
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const loop = deriveBoardReviewLoop(completions, maxRounds);
  const [openRound, setOpenRound] = useState<number | null>(null);
  const shownRound = openRound ?? loop.currentRound;
  const pill = statusPill(loop, live);
  const counts = [
    `${loop.totals.raised} raised`,
    `${loop.totals.fixed} fixed`,
    `${loop.totals.rejected} rejected`,
    ...(loop.totals.open > 0 ? [`${loop.totals.open} open`] : []),
    ...(loop.totals.disputed > 0 ? [`${loop.totals.disputed} disputed`] : []),
  ].join(" · ");

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3.5 pr-3">
        <SectionHeading>Adversarial review</SectionHeading>
        <span className="text-[11.5px] text-muted-foreground">
          Round {loop.currentRound} of {loop.maxRounds}
        </span>
        <span className="flex-1" />
        <span
          className={cn(
            "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-[7px] px-2 text-[11.5px] font-medium",
            pill.className,
          )}
        >
          {pill.spinning ? (
            <span className="size-2.5 shrink-0 animate-spin rounded-full border-[1.7px] border-foreground/20 border-t-current" />
          ) : null}
          {pill.label}
        </span>
        <button
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-input bg-popover pl-1.5 pr-2.5 text-[11.5px] font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
          onClick={onBackToThread}
          type="button"
        >
          <ChevronLeftIcon className="size-3" />
          Back to thread
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-5 pt-3.5">
        <div className="flex shrink-0 flex-col gap-1.5 rounded-xl border border-border bg-card px-3.5 py-3">
          <div className="flex gap-1">
            {Array.from({ length: loop.maxRounds }, (_, index) => {
              const n = index + 1;
              const exists = loop.rounds.some((round) => round.round === n);
              const now = n === loop.currentRound;
              return (
                <button
                  key={n}
                  className={cn(
                    "flex h-[22px] flex-1 items-center justify-center rounded-md text-[10.5px] font-medium",
                    now
                      ? "bg-foreground text-background"
                      : exists
                        ? "bg-foreground/10 text-muted-foreground"
                        : "cursor-default text-muted-foreground/50 shadow-[inset_0_0_0_1px_var(--border)]",
                    n === shownRound && exists && !now ? "shadow-[0_0_0_2px_var(--ring)]" : "",
                  )}
                  disabled={!exists}
                  onClick={() => setOpenRound(n)}
                  title={
                    exists
                      ? `Show round ${n}`
                      : `Round ${n} has not run — the loop stops early once a round closes clean`
                  }
                  type="button"
                >
                  R{n}
                </button>
              );
            })}
          </div>
          <div className="text-[11.5px] text-muted-foreground">{counts}</div>
        </div>
        {loop.rounds.toReversed().map((round) => (
          <Round
            key={round.round}
            onOpenThread={onOpenThread}
            onToggle={() => setOpenRound(shownRound === round.round ? 0 : round.round)}
            open={shownRound === round.round}
            round={round}
          />
        ))}
        <div className="flex shrink-0 items-center gap-3 rounded-xl border border-dashed border-input bg-foreground/3 px-3.5 py-3">
          <span className="min-w-0 text-[11.5px]/[1.5] text-pretty text-muted-foreground">
            {footerNote(loop)}
          </span>
        </div>
      </div>
    </section>
  );
}

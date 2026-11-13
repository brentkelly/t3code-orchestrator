/**
 * Lazy, like the plan pane — a card that never reaches review pays nothing.
 */
import {
  boardReviewRoundsStarted,
  isBoardReviewLoopHeld,
  parseReviewStepId,
  type BoardCardReviewOverrides,
  type BoardReviewCarryRuling,
  type BoardReviewFollowUpPhase,
  type BoardReviewPhaseId,
  type BoardReviewStepPhase,
  type BoardReviewRoundOverride,
  type RuntimeMode,
  type BoardStepCompletion,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronLeftIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { ModelRow } from "../components/settings/BoardModelRow";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import { BoardHint } from "./BoardHint";
import type { BoardStepBadgeState } from "./boardCi";
import { BoardShimmerText, BoardStepBadge } from "./BoardStepBadge";
import { boardReviewPhaseShownStatus } from "./boardStepRecovery";
import {
  deriveBoardReviewLoop,
  type BoardReviewLoop,
  type BoardReviewLoopRound,
  type BoardReviewLoopFinding,
  type BoardReviewPhaseStatus,
} from "./boardReviewLoop";
import { useBoardServerProviders, useBoardSettings } from "./useBoardEnvironmentId";

const PHASE_NAMES: Record<BoardReviewPhaseId | BoardReviewFollowUpPhase, string> = {
  review: "Fresh-eyes review",
  triage: "Triage & respond",
  adjudicate: "Adjudication",
  retriage: "Re-triage",
  readjudicate: "Re-adjudication",
};

/** How the pane names a phase whose payload it cannot read. Short agent nouns
    rather than `PHASE_NAMES`' step titles, because these read inside a
    sentence: "the triager reported success but…". */
const UNREADABLE_PHASE_NAMES: Record<BoardReviewStepPhase, string> = {
  review: "reviewer",
  triage: "triager",
  adjudicate: "adjudicator",
  retriage: "re-triager",
  readjudicate: "re-adjudicator",
  sync: "base sync",
};

/** The phase the loop halted `unreadable` on, or null when it halted for any
    other reason. */
function unreadablePhaseOf(loop: BoardReviewLoop): BoardReviewStepPhase | null {
  if (loop.unreadableStepId === null) return null;
  return parseReviewStepId(loop.unreadableStepId)?.phase ?? null;
}

const SEVERITY_STYLES: Record<BoardReviewLoopFinding["finding"]["severity"], string> = {
  critical: "bg-destructive/12 text-destructive-foreground",
  improvement: "bg-warning/14 text-board-amber-text",
  nitpick: "bg-muted text-muted-foreground",
};

const RESOLUTION_LABELS: Record<BoardReviewLoopFinding["resolution"], string> = {
  open: "open",
  fixed: "fixed",
  rejected: "rejected",
  disputed: "disputed",
  escalated: "escalated",
};

const RESOLUTION_STYLES: Record<BoardReviewLoopFinding["resolution"], string> = {
  open: "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  fixed: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  rejected: "border-border bg-muted text-muted-foreground",
  disputed: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
  // Violet: an escalated finding waits on a human (docs/t3o/status-colours.md).
  escalated: "border-attention/40 bg-attention/12 text-attention-foreground",
};

const VERDICT_WORDS: Record<NonNullable<BoardReviewLoopFinding["verdict"]>, string> = {
  "fix-upheld": "fix upheld",
  "fix-incomplete": "fix incomplete",
  "fix-absent": "fix absent",
  "rejection-justified": "rejection justified",
  "rejection-unjustified": "rejection unjustified",
  escalated: "escalated to you",
};

/** A finding's row: severity chip, title and file, then where it stands. The
    latest pass leads; a finding the adjudicator overruled keeps its earlier
    passes one click away. */
function FindingRow({ entry }: { readonly entry: BoardReviewLoopFinding }) {
  const { finding } = entry;
  const [showPasses, setShowPasses] = useState(false);
  const secondPass = entry.retriage !== null;
  const latestNote = [
    entry.reverdictNote,
    entry.retriageNote,
    entry.verdictNote,
    entry.dispositionNote,
  ].find((note) => note.trim().length > 0);
  return (
    <div className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 -mx-2">
      <span
        className={cn(
          "mt-px inline-flex h-4 shrink-0 items-center rounded-board-5 px-1.5 text-board-10 font-medium uppercase tracking-board-3",
          SEVERITY_STYLES[finding.severity],
          // The reviewer's rating stays visible, struck through by the adjudicator's ruling.
          entry.belowBar && "line-through opacity-55",
        )}
      >
        {finding.severity}
      </span>
      {entry.belowBar ? (
        <span className="mt-px shrink-0 text-board-10-5 text-muted-foreground">below bar</span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-board-12-5 leading-board-1-45 text-pretty text-foreground">
          {finding.title}
        </span>
        {finding.file !== null ? (
          <span className="truncate font-mono text-board-10-5 text-muted-foreground">
            {finding.file}
            {finding.line !== null ? `:${finding.line}` : ""}
          </span>
        ) : null}
        {entry.carriedFrom !== null ? (
          <span className="text-board-11 text-muted-foreground">
            Carried from round {entry.carriedFrom} · must-fix
          </span>
        ) : null}
        {latestNote === undefined ? null : (
          <span className="text-board-11 leading-board-1-4 text-muted-foreground">
            {latestNote}
          </span>
        )}
        {secondPass ? (
          <button
            className="w-fit text-board-11 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            onClick={() => setShowPasses((open) => !open)}
            type="button"
          >
            {showPasses ? "Hide the history" : "2 passes"}
          </button>
        ) : null}
        {secondPass && showPasses ? (
          <ol className="flex flex-col gap-0.5 text-board-11 leading-board-1-45 text-muted-foreground">
            <li>
              Triage: {entry.disposition ?? "no answer"}
              {entry.verdict === null ? "" : ` → ${VERDICT_WORDS[entry.verdict]}`}
            </li>
            <li>
              Re-triage: {entry.retriage === "rejected" ? "argued again" : entry.retriage}
              {entry.reverdict === null ? "" : ` → ${VERDICT_WORDS[entry.reverdict]}`}
            </li>
          </ol>
        ) : null}
      </div>
      <span
        className={cn(
          "inline-flex h-[18px] shrink-0 items-center rounded-md border px-1.75 text-board-10-5 font-medium",
          RESOLUTION_STYLES[entry.resolution],
        )}
      >
        {RESOLUTION_LABELS[entry.resolution]}
      </span>
    </div>
  );
}

/** A phase as the pane shows it: the walk's status, or `stopped` when its
    step stalled. */
type ShownPhaseStatus = BoardReviewPhaseStatus | "stopped";

/** The review phase's shared step badge. A skipped phase wears the
    cancelled dash; a stopped one stays a plain number, as amber is the pill's. */
const PHASE_BADGE: Record<ShownPhaseStatus, BoardStepBadgeState> = {
  done: "passed",
  running: "running",
  pending: "pending",
  skipped: "cancelled",
  stopped: "pending",
};

/** The per-phase prose, written from the round's actual numbers. */
function phaseNote(
  round: BoardReviewLoopRound,
  phase: BoardReviewPhaseId | BoardReviewFollowUpPhase,
  status: ShownPhaseStatus,
): string {
  // Its step stalled before it finished — or before it ever had a thread, as a
  // failed spawn leaves it — so nothing is working on it.
  if (status === "stopped") return "Stopped. Nothing is running this phase.";
  const { counts, severities, findings } = round;
  const blocking = severities.critical + severities.improvement;
  if (phase === "review") {
    if (status === "running") return "A fresh thread is reading the diff with no history of it.";
    if (status === "done") {
      if (round.reviewMalformed) return "Recorded a payload nothing can read.";
      if (findings.length === 0) return "No findings. Nothing blocks.";
      return `${findings.length} ${findings.length === 1 ? "issue" : "issues"} recorded, ${blocking} blocking.`;
    }
    return "Not started.";
  }
  if (phase === "triage") {
    if (status === "skipped") return "Nothing to triage: the review came back clean.";
    // The triage note reports what TRIAGE did — the raw dispositions — not the
    // adjudication-folded resolutions, which would erase a disputed call here.
    const fixed = findings.filter((f) => f.disposition === "fixed").length;
    const rejected = findings.filter((f) => f.disposition === "rejected").length;
    if (status === "running") {
      const open = findings.length - fixed - rejected;
      return `${fixed} fixed, ${rejected} rejected, ${open} still being worked.`;
    }
    if (status === "done") return `${fixed} fixed, ${rejected} rejected with a written rationale.`;
    return "Not started.";
  }
  if (phase === "retriage") {
    const answered = findings.filter((f) => f.retriage !== null);
    if (status === "running") return "Answering the overruled findings: fix it or argue again.";
    const fixed = answered.filter((f) => f.retriage === "fixed").length;
    const argued = answered.filter((f) => f.retriage === "rejected").length;
    // Only a legacy record can hold a re-triage escalation.
    const escalated = answered.filter((f) => f.retriage === "escalated").length;
    return `${fixed} fixed, ${argued} argued again${escalated > 0 ? `, ${escalated} escalated to you` : ""}.`;
  }
  if (phase === "readjudicate") {
    if (status === "running") return "The final ruling on what re-triage fixed or argued again.";
    const ruled = findings.filter((f) => f.reverdict !== null);
    const held = ruled.filter(
      (f) => f.reverdict === "fix-upheld" || f.reverdict === "rejection-justified",
    ).length;
    const escalated = ruled.filter((f) => f.reverdict === "escalated").length;
    const disputed = ruled.length - held - escalated;
    if (disputed === 0 && escalated === 0) return "Every re-triaged response held up.";
    const parts = [
      ...(disputed > 0 ? [`${disputed} still disputed`] : []),
      ...(escalated > 0 ? [`${escalated} escalated to you`] : []),
    ];
    return `${parts.join(", ")}. The loop holds for your call.`;
  }
  if (status === "skipped") return "Only runs when a finding blocks the round.";
  if (status === "running") return "An independent adjudicator is checking the fixes.";
  if (status === "done") {
    const overruled = findings.filter(
      (f) =>
        f.verdict === "fix-incomplete" ||
        f.verdict === "fix-absent" ||
        f.verdict === "rejection-unjustified",
    ).length;
    const escalated = findings.filter((f) => f.verdict === "escalated").length;
    const escalatedNote = escalated > 0 ? ` ${escalated} escalated to you.` : "";
    return overruled > 0
      ? `${overruled} ${overruled === 1 ? "response" : "responses"} overruled. Re-triage takes ${overruled === 1 ? "it" : "them"} in this round.${escalatedNote}`
      : escalated > 0
        ? escalatedNote.trim()
        : counts.disputed > 0
          ? `${counts.disputed} ${counts.disputed === 1 ? "response" : "responses"} disputed.`
          : "Every response held up.";
  }
  return "Not started.";
}

function roundBadge(
  round: BoardReviewLoopRound,
  offStage: boolean,
): { label: string; className: string } {
  switch (round.outcome) {
    case "in-progress":
      // Off the review stage nobody is in the round, so the badge stays neutral.
      if (offStage)
        return {
          label: round.completedAt === null ? "Not started" : "Not running",
          className: "border-border bg-muted text-muted-foreground",
        };
      return { label: "In progress", className: "border-info/40 bg-info/10 text-info-foreground" };
    case "clean":
      return {
        label: "Clean",
        className: "border-success/40 bg-success/10 text-success-foreground",
      };
    case "changes-requested":
      return {
        label: "Changes requested",
        className: "border-destructive/40 bg-destructive/10 text-destructive-foreground",
      };
    case "stuck":
      // Violet: the round waits on a human's ruling (docs/t3o/status-colours.md).
      return {
        label: "Stuck",
        className: "border-attention/40 bg-attention/12 text-attention-foreground",
      };
    case "unreadable":
      // Amber, like every other held ending (docs/t3o/status-colours.md:
      // blocked is amber). `unreadable` is a held outcome, and the column card
      // flags it amber too.
      return {
        label: "Unreadable",
        className: "border-warning/45 bg-warning/14 text-board-amber-text",
      };
  }
}

function roundSummary(round: BoardReviewLoopRound): string {
  if (round.unreadablePhase !== null)
    return `${UNREADABLE_PHASE_NAMES[round.unreadablePhase]} payload unreadable`;
  if (round.findings.length === 0) return round.outcome === "in-progress" ? "" : "no findings";
  const parts = [`${round.counts.fixed} fixed`, `${round.counts.rejected} rejected`];
  if (round.counts.open > 0) parts.push(`${round.counts.open} open`);
  if (round.counts.disputed > 0) parts.push(`${round.counts.disputed} disputed`);
  if (round.counts.escalated > 0) parts.push(`${round.counts.escalated} escalated`);
  return parts.join(" · ");
}

/** A settling round's tag. It claims a range only when the reviewer recorded what it read. */
function settlingRoundText(round: BoardReviewLoopRound): string | null {
  if (round.mode.kind !== "settling") return null;
  const scope =
    round.scope === "delta"
      ? ` · changes since ${round.mode.sinceSha.slice(0, 7)}`
      : round.scope === "branch"
        ? " · whole branch reviewed"
        : "";
  return `Settling · only critical blocks${scope}`;
}

function Round({
  round,
  offStage,
  stalled,
  open,
  onToggle,
  onOpenThread,
}: {
  readonly round: BoardReviewLoopRound;
  /** The card is not on the review stage, so no phase of this round is live. */
  readonly offStage: boolean;
  /** The card's live step stalled, so the phase the walk calls running is not. */
  readonly stalled: boolean;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onOpenThread: ((threadId: ThreadId) => void) | undefined;
}) {
  const badge = roundBadge(round, offStage);
  const settling = settlingRoundText(round);
  const tally = `${round.severities.critical} / ${round.severities.improvement} / ${round.severities.nitpick}`;
  return (
    <div className="shrink-0 overflow-hidden rounded-xl border border-border bg-card shadow-xs">
      <button
        className={cn(
          "flex w-full items-center gap-2.5 px-3 py-2.5 text-left",
          round.outcome === "in-progress" && !offStage ? "bg-foreground/2" : "",
        )}
        onClick={onToggle}
        type="button"
      >
        <span className="shrink-0 text-board-12-5 font-semibold text-foreground">
          Round {round.round}
        </span>
        <span
          className={cn(
            "inline-flex h-[18px] shrink-0 items-center rounded-md border px-1.75 text-board-10-5 font-medium",
            badge.className,
          )}
        >
          {badge.label}
        </span>
        {settling === null ? null : (
          <BoardHint label={settling}>
            <span className="inline-flex h-[18px] shrink-0 items-center rounded-md border border-border px-[7px] text-[10.5px] font-medium text-muted-foreground">
              Settling
            </span>
          </BoardHint>
        )}
        {round.findings.length > 0 ? (
          <BoardHint
            label={`${round.severities.critical} critical · ${round.severities.improvement} improvement · ${round.severities.nitpick} nitpick`}
          >
            <span className="inline-flex h-[18px] shrink-0 items-center rounded-board-5 bg-foreground/6 px-1.5 font-mono text-board-10-5 font-medium tracking-board-2 text-muted-foreground">
              {tally}
            </span>
          </BoardHint>
        ) : null}
        <span className="min-w-0 truncate text-board-11 text-muted-foreground">
          {roundSummary(round)}
        </span>
        <span className="flex-1" />
        {round.completedAt !== null ? (
          <span className="shrink-0 text-board-11 text-muted-foreground">
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
          {settling === null ? null : (
            <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
              {settling}
            </div>
          )}
          {round.carriedRuling === null ? null : (
            <div className="flex flex-col gap-1 border-t border-border bg-foreground/2 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="inline-flex h-[18px] shrink-0 items-center rounded-md border border-border bg-card px-1.75 text-board-10 font-medium uppercase tracking-board-4 text-foreground">
                  Must-fix
                </span>
                <span className="text-board-12-5 font-medium text-foreground">
                  Carried from round {round.carriedRuling.fromRound}
                </span>
              </div>
              <span className="text-pretty text-board-11-5/normal text-muted-foreground">
                You sided with the adjudicator. Triage must fix{" "}
                {round.findings.filter((f) => f.carriedFrom !== null).length === 1
                  ? "this finding"
                  : "these findings"}{" "}
                and the adjudicator checks the fix.
              </span>
              {round.carriedRuling.note === null ? null : (
                <span className="border-l-2 border-input pl-2 text-pretty text-board-11-5/normal text-foreground">
                  {round.carriedRuling.note}
                </span>
              )}
            </div>
          )}
          {round.dismissals.length === 0 ? null : (
            <div className="flex flex-col gap-0.5 border-t border-border px-3 py-2 text-board-11 text-muted-foreground">
              {round.dismissals.map((dismissal) => (
                <span key={dismissal.findingId}>
                  Dismissed by you in round {dismissal.round}: {dismissal.title}
                </span>
              ))}
            </div>
          )}
          {round.phases.map((phase, index) => {
            const phaseId = phase.phase;
            const followUp = phaseId === "retriage" || phaseId === "readjudicate";
            const status = boardReviewPhaseShownStatus(phase.status, { offStage, stalled });
            return (
              <div key={phaseId} className={cn("border-t border-border", followUp ? "pl-6" : "")}>
                <div className="flex items-start gap-2.5 px-3 py-2.5">
                  <BoardStepBadge index={index + 1} state={PHASE_BADGE[status]} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <BoardShimmerText
                      active={status === "running"}
                      className="w-fit text-board-12-5 font-medium text-foreground"
                      text={PHASE_NAMES[phaseId]}
                    />
                    <span className="text-board-11-5/normal text-pretty text-muted-foreground">
                      {phaseNote(round, phaseId, status)}
                    </span>
                  </div>
                  {phase.threadId !== null && onOpenThread !== undefined ? (
                    <BoardHint label="Open this phase's thread">
                      <button
                        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-board-7 border border-input bg-popover px-2 text-board-11-5 font-medium text-foreground shadow-xs hover:bg-accent"
                        onClick={() => onOpenThread(phase.threadId as ThreadId)}
                        type="button"
                      >
                        <MessageSquareIcon className="size-3" />
                        Thread
                      </button>
                    </BoardHint>
                  ) : null}
                </div>
                {phaseId === "review" && round.findings.length > 0 ? (
                  <div className="flex flex-col gap-0.5 pb-3 pl-10.5 pr-3 pt-0.5">
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
  offStage: boolean,
  started: boolean,
  stalled: boolean,
): { label: string; spinning: boolean; className: string } {
  switch (loop.status) {
    case "running": {
      // Off stage a non-terminal loop derives as "running", but nothing is: neutral.
      if (offStage) {
        return {
          label: started ? "Not running: card is off the review stage" : "Not started yet",
          spinning: false,
          className: "bg-muted text-muted-foreground",
        };
      }
      const phase =
        loop.next === null
          ? "Review"
          : loop.next.phase === "sync"
            ? "Sync base"
            : PHASE_NAMES[loop.next.phase];
      // A stalled step is not "waiting to run": nothing will run it until
      // someone acts. Amber, as the card's own "Needs a human" chip
      // is — a stop with no question to answer is not violet
      // (docs/t3o/status-colours.md).
      if (stalled)
        return {
          label: `${phase} · stopped`,
          spinning: false,
          className: "bg-warning/14 text-board-amber-text",
        };
      return live
        ? {
            label: `${phase} · running now`,
            spinning: true,
            className: "bg-info/12 text-info-foreground",
          }
        : {
            label: `${phase} · waiting to run`,
            spinning: false,
            className: "bg-attention/12 text-attention-foreground",
          };
    }
    case "converged":
      return {
        label:
          loop.convergedBy === "adjudicator"
            ? "Loop settled: adjudicator ruled nothing new"
            : loop.convergedBy === "settled"
              ? "Loop settled: no critical findings left"
              : loop.convergedBy === "below-bar"
                ? "Converged: remaining improvements were ruled below the bar"
                : "Loop settled: nothing blocking",
        spinning: false,
        className: "bg-success/14 text-success-foreground",
      };
    case "stuck":
      // Violet: a human's ruling is what the loop waits on.
      return {
        label: `Stuck on round ${loop.currentRound}: needs your call`,
        spinning: false,
        className: "bg-attention/12 text-attention-foreground",
      };
    case "advanced":
      // Neither a pass nor a call for a human: neutral.
      return {
        label: `Advanced past stuck round ${loop.currentRound}`,
        spinning: false,
        className: "bg-muted text-muted-foreground",
      };
    case "round-cap":
      return {
        label: "Round limit reached · no convergence",
        spinning: false,
        className: "bg-warning/14 text-board-amber-text",
      };
    case "stopped":
      return {
        label: "Stopped after this round, holding for you",
        spinning: false,
        className: "bg-warning/14 text-board-amber-text",
      };
    case "unreadable": {
      const phase = unreadablePhaseOf(loop);
      const name = phase === null ? "phase" : UNREADABLE_PHASE_NAMES[phase];
      return {
        label: `${name.charAt(0).toUpperCase()}${name.slice(1)} payload unreadable`,
        spinning: false,
        className: "bg-warning/14 text-board-amber-text",
      };
    }
  }
}

function footerNote(
  loop: BoardReviewLoop,
  offStage: boolean,
  started: boolean,
  stalled: boolean,
): string {
  switch (loop.status) {
    case "running":
      // Off the review stage the loop is not running, so the footer says what
      // it IS: a budget waiting to be spent, or a loop paused by the move.
      if (offStage)
        return started
          ? `Round ${loop.currentRound} of ${loop.maxRounds} · the loop is paused while the card sits off the review stage.`
          : `Round 1 of ${loop.maxRounds} · the loop starts when the card reaches the review stage, and stops early once a round closes clean.`;
      if (stalled)
        return `Round ${loop.currentRound} of ${loop.maxRounds} · the loop stopped. Continue it, restart the phase, or move the card on from the card's actions.`;
      return `Round ${loop.currentRound} of ${loop.maxRounds} · the loop stops early once a round closes clean.`;
    case "converged":
      if (loop.convergedBy === "settled") {
        return `A settling round left no critical finding open, so the loop is settled. Its other findings were fixed or rejected and checked by the adjudicator${loop.unreviewedFixes > 0 ? ` · ${loop.unreviewedFixes} ${loop.unreviewedFixes === 1 ? "fix" : "fixes"} verified by the adjudicator, not re-reviewed` : ""}.`;
      }
      if (loop.convergedBy === "below-bar") {
        return `Converged: remaining improvements were ruled below the bar, so the loop is settled. The reviewer's ratings stay recorded${loop.unreviewedFixes > 0 ? ` · ${loop.unreviewedFixes} ${loop.unreviewedFixes === 1 ? "fix" : "fixes"} verified by the adjudicator, not re-reviewed` : ""}.`;
      }
      return loop.convergedBy === "adjudicator"
        ? "The adjudicator ruled the last round raised nothing new beyond points already settled, and no code changed, so the loop is settled."
        : "A round closed with nothing blocking, so the loop is settled.";
    case "stuck":
      return "Triage and the adjudicator still disagree after a second pass, so the loop is holding for your call.";
    case "advanced":
      return `You advanced the card past stuck round ${loop.currentRound}${loop.unreviewedFixes > 0 ? ` · ${loop.unreviewedFixes} ${loop.unreviewedFixes === 1 ? "fix" : "fixes"} not re-reviewed` : ""}. Nothing was signed off.`;
    case "round-cap":
      return "Every round ran without a clean pass, so the loop stopped at its limit. Nothing was signed off, and the card stays here until you extend the loop or advance it yourself.";
    case "stopped":
      return "You asked the loop to hold after this round. Nothing was signed off, and the card stays here until you resume it or advance it yourself.";
    case "unreadable": {
      const phase = unreadablePhaseOf(loop);
      return `The ${phase === null ? "phase" : UNREADABLE_PHASE_NAMES[phase]} recorded a payload nothing can read, so the loop halted here.`;
    }
  }
}

/**
 * Round counts alone cannot tell a converged loop from one that ran out of road;
 * this says which.
 */
function NoConvergenceBlock({
  loop,
  onRunAnotherRound,
  onAdvance,
}: {
  readonly loop: BoardReviewLoop;
  readonly onRunAnotherRound?: (() => void) | undefined;
  readonly onAdvance?: (() => void) | undefined;
}) {
  const current = loop.rounds.find((round) => round.round === loop.currentRound);
  const unsettled = (current?.counts.open ?? 0) + (current?.counts.disputed ?? 0);
  const stopped = loop.status === "stopped";
  return (
    <div className="flex shrink-0 flex-col gap-2.75 rounded-xl border border-warning/45 bg-warning/7 px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-board-7 bg-warning/18 font-mono text-board-12 font-semibold text-board-amber-text">
          !
        </span>
        <div className="text-board-12-5 font-semibold text-foreground">
          {stopped ? "Loop stopped without convergence" : "Round limit reached without convergence"}
        </div>
      </div>
      <div className="text-pretty text-board-11-5 leading-board-1-55 text-muted-foreground">
        {stopped
          ? `You asked the loop to hold after round ${loop.currentRound}.`
          : `All ${loop.maxRounds} rounds ran and round ${loop.currentRound} still closed with ${unsettled} unsettled ${unsettled === 1 ? "issue" : "issues"}.`}{" "}
        The loop stops here and will not hand the card on by itself.
      </div>
      <div className="text-board-11 text-muted-foreground">
        {unsettled} unsettled this round · {loop.totals.disputed} disputed across the loop
      </div>
      <div className="flex items-center gap-2">
        {onRunAnotherRound === undefined ? null : (
          <button
            className="inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-primary bg-primary px-3 text-board-12-5 font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
            onClick={onRunAnotherRound}
            type="button"
          >
            Run round {loop.currentRound + 1}
          </button>
        )}
        {onAdvance === undefined ? null : (
          <button
            className="inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-input bg-popover px-3 text-board-12-5 font-medium text-foreground shadow-xs hover:bg-accent"
            onClick={onAdvance}
            type="button"
          >
            Advance anyway
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The block a STUCK loop puts above its rounds: what triage and the
 * adjudicator still disagree on, side by side, and the three rulings a human
 * can make. Every action applies to all the listed findings at once.
 */
function StuckBlock({
  loop,
  onRuling,
  onAdvance,
}: {
  readonly loop: BoardReviewLoop;
  readonly onRuling?: ((ruling: BoardReviewCarryRuling, note: string | null) => void) | undefined;
  readonly onAdvance?: (() => void) | undefined;
}) {
  const [form, setForm] = useState<BoardReviewCarryRuling | null>(null);
  const [note, setNote] = useState("");
  const findings = loop.stuckFindings;
  const allCarried = findings.length > 0 && findings.every((f) => f.carriedFrom !== null);
  const dismissLabel = allCarried ? "Accept as is" : "Reviewer is wrong";
  const next = loop.currentRound + 1;
  const submit = () => {
    if (form === null || onRuling === undefined) return;
    const trimmed = note.trim();
    onRuling(form, trimmed.length === 0 ? null : trimmed);
    setForm(null);
    setNote("");
  };
  return (
    <div className="flex shrink-0 flex-col gap-2.75 rounded-xl border border-attention/40 bg-attention/6 px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-board-7 bg-attention/16 font-mono text-board-12 font-semibold text-attention-foreground">
          !
        </span>
        <div className="text-board-12-5 font-semibold text-foreground">
          Review is stuck on round {loop.currentRound}
        </div>
      </div>
      <div className="text-pretty text-board-11-5 leading-board-1-55 text-muted-foreground">
        Round {loop.currentRound} ended with {findings.length}{" "}
        {findings.length === 1 ? "finding" : "findings"} that triage and the adjudicator still
        disagree on after a second pass. The loop is holding for your call.
      </div>
      <div className="flex flex-col gap-2">
        {findings.map((finding) => (
          <div
            key={finding.findingId}
            className="flex flex-col gap-2 rounded-board-10 border border-border bg-card px-2.75 py-2.5"
          >
            <div className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-px inline-flex h-4 shrink-0 items-center rounded-board-5 px-1.5 text-board-10 font-medium uppercase tracking-board-3",
                  SEVERITY_STYLES[finding.severity],
                )}
              >
                {finding.severity}
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-pretty text-board-12-5 leading-board-1-45 font-medium text-foreground">
                  {finding.title}
                </span>
                {finding.file === null ? null : (
                  <span className="truncate font-mono text-board-10-5 text-muted-foreground">
                    {finding.file}
                    {finding.line === null ? "" : `:${finding.line}`}
                  </span>
                )}
              </div>
              {finding.triageAction === "escalated" || finding.rulingVerdict === "escalated" ? (
                <span className="inline-flex h-[18px] shrink-0 items-center rounded-md border border-border bg-attention/12 px-1.75 text-board-10-5 font-medium text-attention-foreground">
                  {finding.rulingVerdict === "escalated" ? "adjudicator escalated" : "escalated"}
                </span>
              ) : finding.carriedFrom !== null ? (
                <span className="inline-flex h-[18px] shrink-0 items-center rounded-md border border-border bg-muted px-1.75 text-board-10-5 font-medium text-muted-foreground">
                  carried fix failed
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex flex-col gap-1 rounded-lg bg-muted px-2.25 py-2">
                <span className="text-board-10 font-semibold uppercase tracking-board-6 text-muted-foreground">
                  Triage{finding.triageAction === null ? "" : ` · ${finding.triageAction}`}
                </span>
                <span className="text-pretty text-board-11-5/normal text-foreground">
                  {finding.triageNote.trim().length > 0
                    ? finding.triageNote
                    : "No answer recorded."}
                </span>
              </div>
              <div className="flex flex-col gap-1 rounded-lg bg-muted px-2.25 py-2">
                <span className="text-board-10 font-semibold uppercase tracking-board-6 text-muted-foreground">
                  Ruling
                  {finding.rulingVerdict === null
                    ? ""
                    : ` · ${VERDICT_WORDS[finding.rulingVerdict]}`}
                </span>
                <span className="text-pretty text-board-11-5/normal text-foreground">
                  {finding.rulingNote.trim().length > 0
                    ? finding.rulingNote
                    : "No ruling recorded."}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onRuling === undefined ? null : (
          <>
            <BoardHint label={`Round ${next} must fix these`}>
              <button
                className="inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-primary bg-primary px-3 text-board-12-5 font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
                onClick={() => setForm(form === "fix" ? null : "fix")}
                type="button"
              >
                Fix it and run round {next}
              </button>
            </BoardHint>
            <BoardHint label="Settle these as not issues">
              <button
                className="inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-input bg-popover px-3 text-board-12-5 font-medium text-foreground shadow-xs hover:bg-accent"
                onClick={() => setForm(form === "dismiss" ? null : "dismiss")}
                type="button"
              >
                {dismissLabel}, run round {next}
              </button>
            </BoardHint>
          </>
        )}
        {onAdvance === undefined ? null : (
          <button
            className="inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-input bg-popover px-3 text-board-12-5 font-medium text-foreground shadow-xs hover:bg-accent"
            onClick={onAdvance}
            type="button"
          >
            Advance anyway
          </button>
        )}
      </div>
      {form === null ? null : (
        <div className="flex flex-col gap-2 rounded-board-10 border border-border bg-card px-2.75 py-2.5">
          <span className="text-board-12 font-medium text-foreground">
            {form === "fix"
              ? `Fix ${findings.length === 1 ? "this finding" : "these findings"} in round ${next}`
              : `Rule ${findings.length === 1 ? "this finding" : "these findings"} not an issue`}
          </span>
          <textarea
            className="block w-full resize-y rounded-lg border border-input bg-popover px-2.5 py-2 text-board-12/normal text-foreground"
            onChange={(event) => setNote(event.target.value)}
            placeholder={
              form === "fix" ? "Guidance for the fix, e.g. use approach X" : "Why, for the record"
            }
            rows={3}
            value={note}
          />
          <div className="flex items-center gap-2">
            <span className="text-board-11 text-muted-foreground">
              Optional ·{" "}
              {form === "fix" ? "goes to triage with the findings" : "kept with the ruling"}
            </span>
            <span className="flex-1" />
            <button
              className="h-7 shrink-0 rounded-lg px-2.5 text-board-12 font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setForm(null)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="inline-flex h-7 shrink-0 items-center rounded-lg border border-primary bg-primary px-2.75 text-board-12 font-medium text-primary-foreground shadow-xs"
              onClick={submit}
              type="button"
            >
              Run round {next}
            </button>
          </div>
        </div>
      )}
      <div className="text-pretty text-board-11/normal text-muted-foreground">
        {findings.length > 1 ? "Each action applies to all the findings above. " : ""}
        {loop.unreviewedFixes > 0
          ? `${loop.unreviewedFixes} ${loop.unreviewedFixes === 1 ? "fix" : "fixes"} from round ${loop.currentRound} ${loop.unreviewedFixes === 1 ? "has" : "have"} not been re-reviewed; advancing takes them as they stand.`
          : "Advancing takes the code as it stands."}
      </div>
    </div>
  );
}

/**
 * Reopening supersedes an unreadable phase payload, which must never be read as
 * a phase that said nothing. Separate from `NoConvergenceBlock`: an unreadable
 * payload has no findings to count.
 */
function UnreadableRoundBlock({
  round,
  phase,
  onReopen,
}: {
  readonly round: number;
  readonly phase: BoardReviewStepPhase;
  readonly onReopen?: (() => void) | undefined;
}) {
  const name = UNREADABLE_PHASE_NAMES[phase];
  return (
    <div className="flex shrink-0 flex-col gap-2.75 rounded-xl border border-warning/45 bg-warning/7 px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-board-7 bg-warning/18 font-mono text-board-12 font-semibold text-board-amber-text">
          !
        </span>
        <div className="text-board-12-5 font-semibold text-foreground">
          Round {round} recorded an unreadable result
        </div>
      </div>
      <div className="text-pretty text-board-11-5 leading-board-1-55 text-muted-foreground">
        {phase === "review"
          ? `The reviewer reported success but its findings payload did not arrive in a shape the board can read, so nothing was reviewed as far as the loop is concerned.`
          : `The ${name} reported success but its payload did not arrive in a shape the board can read, so the round is missing the result it claimed.`}{" "}
        The loop will not converge on it and it will not hand the card on.
      </div>
      {onReopen === undefined ? null : (
        <div className="flex items-center gap-2">
          <button
            className="inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-primary bg-primary px-3 text-board-12-5 font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
            onClick={onReopen}
            type="button"
          >
            {phase === "review" ? `Reopen round ${round}` : `Reopen ${name}`}
          </button>
          <span className="min-w-0 text-board-11 text-muted-foreground">
            {phase === "review"
              ? "Sends the round back and runs its review again."
              : `Sends round ${round}'s ${name} back and runs it again.`}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The override re-points the REVIEW phase alone. Access is offered only once a
 * model is picked: an override entry has nowhere to keep an access level alone.
 */
function PlannedRoundSettings({
  round,
  previousRound,
  model,
  phaseRuntimeMode,
  onChange,
  projectId,
}: {
  readonly round: number;
  readonly previousRound: number;
  readonly model: BoardReviewRoundOverride | null;
  readonly phaseRuntimeMode: RuntimeMode;
  readonly onChange: (model: BoardReviewRoundOverride | null) => void;
  readonly projectId: ProjectId | null;
}) {
  const settings = useBoardSettings();
  const serverProviders = useBoardServerProviders();
  // T3O-74: a provider turned off for the card's project shows disabled.
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(serverProviders),
      settings,
      projectId,
    ),
  );
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
      <ModelRow
        ariaLabel={`Round ${round} review model`}
        getModelOptions={(active) =>
          getCustomModelOptionsByInstance(
            settings,
            serverProviders,
            active.instanceId,
            active.model,
          )
        }
        hideRuntimeMode={model === null}
        instanceEntries={instanceEntries}
        label={`Round ${round} review model`}
        modelOptions={model?.options}
        onChange={(selection) =>
          onChange(
            selection === null
              ? null
              : {
                  ...selection,
                  ...(model?.options === undefined ? {} : { options: model.options }),
                  ...(model?.runtimeMode === undefined ? {} : { runtimeMode: model.runtimeMode }),
                },
          )
        }
        onModelOptionsChange={(options) =>
          onChange(
            model === null ? null : { ...model, ...(options === undefined ? {} : { options }) },
          )
        }
        onRuntimeModeChange={(runtimeMode) =>
          onChange(model === null ? null : { ...model, runtimeMode })
        }
        runtimeMode={model?.runtimeMode ?? phaseRuntimeMode}
        selection={model === null ? null : { instanceId: model.instanceId, model: model.model }}
      />
      <p className="text-board-11 text-muted-foreground">
        {model === null
          ? `Same as ${previousRound < 1 ? "the review stage's configured model" : `round ${previousRound}`}. Only round ${round}'s review runs on this. Triage and adjudication keep their configured models.`
          : `Only round ${round}'s review runs on this. Triage and adjudication keep their configured models.`}
      </p>
    </div>
  );
}

export function BoardCardReviewPane({
  projectId,
  completions,
  maxRounds,
  live,
  offStage,
  stalled,
  overrides,
  roundsStarted,
  stepActive,
  onResume,
  onSetRounds,
  onSetRoundModel,
  phaseRuntimeMode,
  onAdvance,
  onRuling,
  onReopenStep,
  onBackToThread,
  onOpenThread,
}: {
  /** The card's project, for which providers its round pickers offer (T3O-74). */
  readonly projectId?: ProjectId | undefined;
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  /** The EFFECTIVE round budget — the card's override when it has one, else the
      review stage's `rounds`. Resolved by the caller, which is the only layer
      that can see both. */
  readonly maxRounds: number;
  /** Whether the card's active thread is working — the difference between a
      due phase spinning "running now" and resting "waiting to run". */
  readonly live: boolean;
  /** The card is not ON the review stage, so the loop cannot be live: ahead
      of it the pane is a planning surface, past it (or dragged back off it)
      a record — either way a non-terminal loop's pill must not claim to be
      running or waiting. */
  readonly offStage?: boolean | undefined;
  /** The card's live step has stalled: the walk's next phase is owed
      but nothing is running it, so it must not read as running or waiting. */
  readonly stalled?: boolean | undefined;
  /** The card's own review-loop settings, or null. */
  readonly overrides?: BoardCardReviewOverrides | null | undefined;
  /** The highest round the loop has STARTED, resolved by the caller — which is
      the only layer that can see the card's live step. The `−` button's floor,
      and it must equal the decider's or the button offers a write the server
      refuses. Falls back to the ledger alone when absent. */
  readonly roundsStarted?: number | undefined;
  /** Whether the executor is driving the card right now — running, or queued
      for a concurrency slot. The `−` floor needs it because the decider counts
      a live step of ANY status, and the ledger alone cannot see one. */
  readonly stepActive?: boolean | undefined;
  /** Run one more review round. Distinct from `onSetRounds`: the
      round it buys is resolved server-side from the ledger, so resuming can
      neither shrink a budget the user already raised nor leave the stop it
      would otherwise terminate on again. */
  readonly onResume?: (() => void) | undefined;
  /** Set the card's round budget. Absent leaves the loop read-only — the pane
      still reports a stalled loop, it just cannot offer to restart it. */
  readonly onSetRounds?: ((rounds: number) => void) | undefined;
  /** Set (or clear, with null) a future round's review model and access level. */
  readonly onSetRoundModel?:
    | ((round: number, model: BoardReviewRoundOverride | null) => void)
    | undefined;
  /** The review phase's EFFECTIVE access level, resolved by the caller — what
      a round without its own shows and inherits. */
  readonly phaseRuntimeMode?: RuntimeMode | undefined;
  /** Move the card on despite a loop that never converged. */
  readonly onAdvance?: (() => void) | undefined;
  /** Rule on a stuck loop's findings and run another round. */
  readonly onRuling?: ((ruling: BoardReviewCarryRuling, note: string | null) => void) | undefined;
  /** Send a round's review back because its recorded payload cannot be read.
      Absent leaves the halt visible but unfixable from here. */
  readonly onReopenStep?: ((stepId: string) => void) | undefined;
  readonly onBackToThread: () => void;
  /** Deep-link into a phase's thread; absent when the pane has no thread pane
      to hand off to. */
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const loop = deriveBoardReviewLoop(
    completions,
    maxRounds,
    overrides?.stopAfterRound ?? null,
    overrides?.runThroughRound ?? null,
    {
      carriedFindings: overrides?.carriedFindings ?? {},
      stuckWaivedThrough: overrides?.stuckWaivedThrough ?? null,
      roundModes: overrides?.roundModes ?? {},
    },
  );
  const stuck = loop.status === "stuck";
  // Which FUTURE round's settings drawer is open. Separate from `openRound`,
  // which expands a round that has run: a round with history is something to
  // read, one without is something to configure.
  const [plannedRound, setPlannedRound] = useState<number | null>(null);
  // Which round is expanded: a round number the user picked, "collapsed" after
  // they closed the open one, or null — never touched — which follows the
  // loop's current round.
  const [openRound, setOpenRound] = useState<number | "collapsed" | null>(null);
  const shownRound = openRound === "collapsed" ? null : (openRound ?? loop.currentRound);
  // The highest round the ledger has recorded anything for — 0 means the loop
  // has never run. Also `plannable`'s floor below; derived here because the
  // pill needs it too (an empty loop still derives a synthetic round 1, so
  // `loop.rounds` cannot say whether anything actually started).
  const ledgerFloor = roundsStarted ?? boardReviewRoundsStarted({ completions, liveStepId: null });
  const pill = statusPill(loop, live, offStage === true, ledgerFloor > 0, stalled === true);
  // A loop that ended without a clean pass. The distinction the whole spec
  // turns on: these carry a converged loop's round counts and the opposite
  // meaning, so the pane must never let them read as a pass.
  const held = isBoardReviewLoopHeld(loop.status);
  // The one broken record the recovery block names and reopens.
  const unreadableStepId = loop.unreadableStepId;
  const unreadablePhase = unreadablePhaseOf(loop);
  // A started round can never be removed. A control gate only, never fed back
  // into the budget; a live step counts, matching the decider.
  const startedFloor = Math.max(
    ledgerFloor,
    stepActive === true && loop.status === "running" ? loop.currentRound : 0,
  );
  const budgetFloor = Math.max(1, startedFloor);
  /**
   * Plannable only when genuinely ahead of the started rounds: the dispatched
   * round has recorded nothing, but its model is already frozen on the run row.
   */
  const plannable = (n: number) => onSetRoundModel !== undefined && n > startedFloor;
  const counts = [
    `${loop.totals.raised} raised`,
    `${loop.totals.fixed} fixed`,
    `${loop.totals.rejected} rejected`,
    ...(loop.totals.open > 0 ? [`${loop.totals.open} open`] : []),
    ...(loop.totals.disputed > 0 ? [`${loop.totals.disputed} disputed`] : []),
    ...(loop.totals.escalated > 0 ? [`${loop.totals.escalated} escalated`] : []),
  ].join(" · ");

  return (
    <section className="flex min-h-0 min-w-0 flex-col border-r border-border bg-muted/55">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border pl-3.5 pr-3">
        <SectionHeading>Adversarial review</SectionHeading>
        <span className="text-board-11-5 text-muted-foreground">
          Round {loop.currentRound} of {loop.maxRounds}
        </span>
        <span className="flex-1" />
        <span
          className={cn(
            "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-board-7 px-2 text-board-11-5 font-medium",
            pill.className,
          )}
        >
          <BoardShimmerText active={pill.spinning} text={pill.label} />
        </span>
        <button
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-board-7 border border-input bg-popover pl-1.5 pr-2.5 text-board-11-5 font-medium text-muted-foreground shadow-xs hover:bg-accent hover:text-foreground"
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
                <BoardHint
                  key={n}
                  label={
                    exists
                      ? `Show round ${n}`
                      : plannable(n)
                        ? `Set the review model for round ${n}`
                        : `Round ${n} is already in flight. Its model was frozen when the step was dispatched`
                  }
                >
                  <button
                    className={cn(
                      "flex h-[22px] flex-1 items-center justify-center rounded-md text-board-10-5 font-medium",
                      now
                        ? "bg-foreground text-background"
                        : exists
                          ? "bg-foreground/10 text-muted-foreground"
                          : "cursor-default text-muted-foreground/50 shadow-board-inset-border",
                      n === shownRound && exists && !now ? "shadow-board-ring-focus" : "",
                    )}
                    disabled={!exists && !plannable(n)}
                    onClick={() =>
                      exists
                        ? setOpenRound(n)
                        : setPlannedRound((current) => (current === n ? null : n))
                    }
                    type="button"
                  >
                    R{n}
                  </button>
                </BoardHint>
              );
            })}
            {/* A stuck loop takes a ruling, not a budget. */}
            {onSetRounds === undefined || stuck ? null : (
              <span className="ml-1 flex shrink-0 items-center">
                <BoardHint
                  label={
                    loop.maxRounds <= budgetFloor
                      ? `Round ${budgetFloor} has already started and cannot be removed`
                      : `Drop the budget to ${loop.maxRounds - 1} rounds`
                  }
                >
                  <button
                    aria-label="Remove a round"
                    className="inline-flex h-5 w-[19px] items-center justify-center rounded-board-5 text-board-13 font-medium text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/45"
                    disabled={loop.maxRounds <= budgetFloor}
                    onClick={() => onSetRounds(loop.maxRounds - 1)}
                    type="button"
                  >
                    −
                  </button>
                </BoardHint>
                {/* No ceiling: denying a user a round they are
                    deliberately asking for buys nothing, and the board-wide
                    stage setting was never capped either. */}
                <BoardHint label={`Allow ${loop.maxRounds + 1} rounds`}>
                  <button
                    aria-label="Add a round"
                    className="inline-flex h-5 w-[19px] items-center justify-center rounded-board-5 text-board-13 font-medium text-foreground"
                    onClick={() => onSetRounds(loop.maxRounds + 1)}
                    type="button"
                  >
                    +
                  </button>
                </BoardHint>
              </span>
            )}
          </div>
          {plannedRound === null || !plannable(plannedRound) ? null : (
            <PlannedRoundSettings
              model={overrides?.roundModels[String(plannedRound)] ?? null}
              onChange={(model) => onSetRoundModel?.(plannedRound, model)}
              phaseRuntimeMode={phaseRuntimeMode ?? "auto"}
              previousRound={plannedRound - 1}
              projectId={projectId ?? null}
              round={plannedRound}
            />
          )}
          <div className="text-board-11-5 text-muted-foreground">{counts}</div>
        </div>
        {loop.status === "unreadable" && unreadableStepId !== null && unreadablePhase !== null ? (
          <UnreadableRoundBlock
            onReopen={onReopenStep === undefined ? undefined : () => onReopenStep(unreadableStepId)}
            phase={unreadablePhase}
            round={loop.currentRound}
          />
        ) : stuck ? (
          <StuckBlock loop={loop} onAdvance={onAdvance} onRuling={onRuling} />
        ) : held ? (
          <NoConvergenceBlock loop={loop} onAdvance={onAdvance} onRunAnotherRound={onResume} />
        ) : null}
        {loop.rounds.toReversed().map((round) => (
          <Round
            key={round.round}
            offStage={offStage === true}
            stalled={stalled === true}
            onOpenThread={onOpenThread}
            onToggle={() => setOpenRound(shownRound === round.round ? "collapsed" : round.round)}
            open={shownRound === round.round}
            round={round}
          />
        ))}
        <div className="flex shrink-0 items-center gap-3 rounded-xl border border-dashed border-input bg-foreground/3 px-3.5 py-3">
          <span className="min-w-0 text-board-11-5/normal text-pretty text-muted-foreground">
            {footerNote(loop, offStage === true, ledgerFloor > 0, stalled === true)}
          </span>
        </div>
      </div>
    </section>
  );
}

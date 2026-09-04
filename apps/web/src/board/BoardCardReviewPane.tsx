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
  BOARD_REVIEW_MAX_ROUNDS,
  BOARD_REVIEW_PHASE_IDS,
  boardReviewRoundsStarted,
  isBoardReviewLoopHeld,
  type BoardCardReviewOverrides,
  type BoardReviewPhaseId,
  type BoardReviewRoundOverride,
  type RuntimeMode,
  type BoardStepCompletion,
  type ThreadId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, ChevronLeftIcon, MessageSquareIcon } from "lucide-react";
import { useState } from "react";

import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { primaryServerProvidersAtom } from "../state/server";
import { usePrimarySettings } from "../hooks/useSettings";
import { ModelRow } from "../components/settings/BoardModelRow";
import { cn } from "../lib/utils";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { BoardSectionHeading as SectionHeading } from "./BoardCardFields";
import { BoardHint } from "./BoardHint";
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
      <BoardHint label="Running now">
        <span
          aria-label="Running now"
          role="img"
          className="size-5 shrink-0 animate-spin rounded-full border-2 border-[color-mix(in_srgb,var(--info)_25%,transparent)] border-t-info-foreground"
        />
      </BoardHint>
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
          <BoardHint
            label={`${round.severities.critical} critical · ${round.severities.improvement} improvement · ${round.severities.nitpick} nitpick`}
          >
            <span className="inline-flex h-[18px] shrink-0 items-center rounded-[5px] bg-foreground/6 px-1.5 font-mono text-[10.5px] font-medium tracking-[.02em] text-muted-foreground">
              {tally}
            </span>
          </BoardHint>
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
                    <BoardHint label="Open this phase's thread">
                      <button
                        className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-[7px] border border-input bg-popover px-2 text-[11.5px] font-medium text-foreground shadow-xs hover:bg-accent"
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
  offStage: boolean,
  started: boolean,
): { label: string; spinning: boolean; className: string } {
  switch (loop.status) {
    case "running": {
      // Off the review stage a non-terminal loop derives as "running" — but
      // nothing is running and nobody is waited on, so the pill stays
      // neutral (docs/t3o/status-colours.md: no colour without a claim):
      // "not started" ahead of the loop, "not running" for a card dragged
      // off mid-loop.
      if (offStage) {
        return {
          label: started ? "Not running — card is off the review stage" : "Not started yet",
          spinning: false,
          className: "bg-muted text-muted-foreground",
        };
      }
      const phase = loop.next === null ? "Review" : PHASE_NAMES[loop.next.phase];
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
        label: "Loop settled — nothing blocking",
        spinning: false,
        className: "bg-success/14 text-success-foreground",
      };
    case "round-cap":
      return {
        label: "Round limit reached · no convergence",
        spinning: false,
        className: "bg-amber-500/14 text-amber-700 dark:text-amber-300",
      };
    case "stopped":
      return {
        label: "Stopped after this round — holding for you",
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
      return "Every round ran without a clean pass, so the loop stopped at its limit. Nothing was signed off, and the card stays here until you extend the loop or advance it yourself.";
    case "stopped":
      return "You asked the loop to hold after this round. Nothing was signed off, and the card stays here until you resume it or advance it yourself.";
    case "unreadable":
      return "A review phase recorded a payload nothing can read, so the loop halted here.";
  }
}

/**
 * The block a loop that ended WITHOUT converging puts above its rounds
 * (t3o-22, D8).
 *
 * It exists because the round counts alone cannot tell the two endings apart:
 * "5 of 5, 12 raised, 7 fixed" describes a loop that passed and a loop that ran
 * out of road identically. This says which, in words, and offers the only two
 * things a human can usefully do next — buy another round, or take
 * responsibility for moving the card on.
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
    <div className="flex shrink-0 flex-col gap-[11px] rounded-xl border border-amber-500/45 bg-amber-500/7 px-3.5 py-3">
      <div className="flex items-center gap-2.5">
        <span className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-amber-500/18 font-mono text-[12px] font-semibold text-amber-700 dark:text-amber-300">
          !
        </span>
        <div className="text-[12.5px] font-semibold text-foreground">
          {stopped ? "Loop stopped without convergence" : "Round limit reached without convergence"}
        </div>
      </div>
      <div className="text-pretty text-[11.5px]/[1.55] text-muted-foreground">
        {stopped
          ? `You asked the loop to hold after round ${loop.currentRound}.`
          : `All ${loop.maxRounds} rounds ran and round ${loop.currentRound} still closed with ${unsettled} unsettled ${unsettled === 1 ? "issue" : "issues"}.`}{" "}
        The loop stops here and will not hand the card on by itself.
      </div>
      <div className="text-[11px] text-muted-foreground">
        {unsettled} unsettled this round · {loop.totals.disputed} disputed across the loop
      </div>
      <div className="flex items-center gap-2">
        {onRunAnotherRound === undefined ? null : (
          <button
            className="inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-primary bg-primary px-3 text-[12.5px] font-medium text-primary-foreground shadow-xs hover:bg-primary/90"
            onClick={onRunAnotherRound}
            type="button"
          >
            Run round {loop.currentRound + 1}
          </button>
        )}
        {onAdvance === undefined ? null : (
          <button
            className="inline-flex h-[30px] shrink-0 items-center justify-center gap-1.5 rounded-lg border border-input bg-popover px-3 text-[12.5px] font-medium text-foreground shadow-xs hover:bg-accent"
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
 * The settings drawer a FUTURE round opens (t3o-22, D4).
 *
 * The same combined controls menu as the chat composer: model, reasoning,
 * whatever else the model supports, and the access level. The override
 * re-points the REVIEW phase alone, because escalating the reviewer and
 * re-modelling the author who fixes the code are different calls. Access
 * shows the review phase's configured level until the round sets its own,
 * and is offered only once a model is picked: an override entry is a model
 * plus what it changes, and has nowhere to keep an access level alone.
 */
function PlannedRoundSettings({
  round,
  previousRound,
  model,
  phaseRuntimeMode,
  onChange,
}: {
  readonly round: number;
  readonly previousRound: number;
  readonly model: BoardReviewRoundOverride | null;
  readonly phaseRuntimeMode: RuntimeMode;
  readonly onChange: (model: BoardReviewRoundOverride | null) => void;
}) {
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
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
      <p className="text-[11px] text-muted-foreground">
        {model === null
          ? `Same as ${previousRound < 1 ? "the review stage's configured model" : `round ${previousRound}`}. Only round ${round}'s review runs on this — triage and adjudication keep their configured models.`
          : `Only round ${round}'s review runs on this — triage and adjudication keep their configured models.`}
      </p>
    </div>
  );
}

export function BoardCardReviewPane({
  completions,
  maxRounds,
  live,
  offStage,
  overrides,
  roundsStarted,
  stepActive,
  onResume,
  onSetRounds,
  onSetRoundModel,
  phaseRuntimeMode,
  onAdvance,
  onBackToThread,
  onOpenThread,
}: {
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
  /** The card's own review-loop settings (t3o-22, D2), or null. */
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
  /** Resume a held loop at `round`. Distinct from `onSetRounds`: resuming must
      never shrink a budget the user already raised, and must clear the stop it
      would otherwise terminate on again. */
  readonly onResume?: ((round: number) => void) | undefined;
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
  /** Move the card on despite a loop that never converged (D8). */
  readonly onAdvance?: (() => void) | undefined;
  readonly onBackToThread: () => void;
  /** Deep-link into a phase's thread; absent when the pane has no thread pane
      to hand off to. */
  readonly onOpenThread?: ((threadId: ThreadId) => void) | undefined;
}) {
  const loop = deriveBoardReviewLoop(completions, maxRounds, overrides?.stopAfterRound ?? null);
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
  const pill = statusPill(loop, live, offStage === true, ledgerFloor > 0);
  // A loop that ended without a clean pass. The distinction the whole spec
  // turns on: these carry a converged loop's round counts and the opposite
  // meaning, so the pane must never let them read as a pass.
  const held = isBoardReviewLoopHeld(loop.status);
  // The floor the − button obeys (t3o-22, D3): a round that has STARTED can
  // never be removed. Strictly a CONTROL gate — never fed back into the budget,
  // which is the caller's and is floored on the ledger alone. While a step is
  // live the round the walk sits on has started, so it counts; the decider
  // counts a live step of any status, so this matches it wherever the shell can
  // see one.
  const startedFloor = Math.max(
    ledgerFloor,
    stepActive === true && loop.status === "running" ? loop.currentRound : 0,
  );
  const budgetFloor = Math.max(1, startedFloor);
  /**
   * Whether round `n`'s settings can still be chosen.
   *
   * "Has no completion yet" is not the same as "is in the future": the round
   * the executor has already dispatched has recorded nothing either, and its
   * model was frozen onto the run row at `select-step`. Offering a picker there
   * writes an override nothing will ever read. A round is plannable only when
   * it is genuinely ahead of the started rounds — NOT the `−` button's floor,
   * which never drops below 1 because a budget can't: before the loop starts,
   * round 1 itself is still free to plan — and only when there is somewhere to
   * write it, so a read-only pane never takes an edit and drops it.
   */
  const plannable = (n: number) => onSetRoundModel !== undefined && n > startedFloor;
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
            <span className="size-2.5 shrink-0 animate-spin rounded-full border-[1.7px] border-[color-mix(in_srgb,var(--info)_25%,transparent)] border-t-current" />
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
                <BoardHint
                  key={n}
                  label={
                    exists
                      ? `Show round ${n}`
                      : plannable(n)
                        ? `Set the review model for round ${n}`
                        : `Round ${n} is already in flight — its model was frozen when the step was dispatched`
                  }
                >
                  <button
                    className={cn(
                      "flex h-[22px] flex-1 items-center justify-center rounded-md text-[10.5px] font-medium",
                      now
                        ? "bg-foreground text-background"
                        : exists
                          ? "bg-foreground/10 text-muted-foreground"
                          : "cursor-default text-muted-foreground/50 shadow-[inset_0_0_0_1px_var(--border)]",
                      n === shownRound && exists && !now ? "shadow-[0_0_0_2px_var(--ring)]" : "",
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
            {onSetRounds === undefined ? null : (
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
                    className="inline-flex h-5 w-[19px] items-center justify-center rounded-[5px] text-[13px] font-medium text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/45"
                    disabled={loop.maxRounds <= budgetFloor}
                    onClick={() => onSetRounds(loop.maxRounds - 1)}
                    type="button"
                  >
                    −
                  </button>
                </BoardHint>
                <BoardHint
                  label={
                    loop.maxRounds >= BOARD_REVIEW_MAX_ROUNDS
                      ? `${BOARD_REVIEW_MAX_ROUNDS} rounds is the ceiling`
                      : `Allow ${loop.maxRounds + 1} rounds`
                  }
                >
                  <button
                    aria-label="Add a round"
                    className="inline-flex h-5 w-[19px] items-center justify-center rounded-[5px] text-[13px] font-medium text-foreground disabled:cursor-not-allowed disabled:text-muted-foreground/45"
                    disabled={loop.maxRounds >= BOARD_REVIEW_MAX_ROUNDS}
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
              round={plannedRound}
            />
          )}
          <div className="text-[11.5px] text-muted-foreground">{counts}</div>
        </div>
        {held ? (
          <NoConvergenceBlock
            loop={loop}
            onAdvance={onAdvance}
            onRunAnotherRound={
              // Gated at the ceiling exactly as the `+` button is: at 10 rounds
              // `onResume(11)` is a write the decider refuses, so the button
              // must not offer it as a live affordance.
              onResume === undefined || loop.currentRound + 1 > BOARD_REVIEW_MAX_ROUNDS
                ? undefined
                : () => onResume(loop.currentRound + 1)
            }
          />
        ) : null}
        {loop.rounds.toReversed().map((round) => (
          <Round
            key={round.round}
            onOpenThread={onOpenThread}
            onToggle={() => setOpenRound(shownRound === round.round ? "collapsed" : round.round)}
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

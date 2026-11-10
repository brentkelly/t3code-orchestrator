/**
 * T3o Continuous integration on the client (T3O-44): what the card face, the
 * card view's CI tab and its banner say about a card's CI runs. Pure, over the
 * shell's compact `ci` entry and the detail's pass records.
 *
 * Colours follow `docs/t3o/status-colours.md`: running and fixing are blue, a
 * passed step green, a terminal failure or a stopped pass amber, cancelled grey.
 */
import {
  BOARD_CI_STOPPED_BY_YOU_REASON,
  BOARD_CI_TAIL_LINES,
  boardCiFixIssueOutcomes,
  boardCiFixIssues,
  boardCiFixStepId,
  decodeBoardCiFixPayload,
  isBoardCiStepFailure,
  parseBoardCiFixStepId,
  type BoardCiFixIssueStatus,
  type BoardCardCi,
  type BoardStepCompletion,
  type BoardCardCiLastOutcome,
  type BoardCiPass,
  type BoardCiHeadline,
  type BoardCiPassOutcome,
  type BoardCiProgress,
  type BoardCiStepStatus,
} from "@t3tools/contracts";

/** The shared step badge's states, for CI steps and review phases alike. */
export type BoardStepBadgeState =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "fixing"
  | "cancelled";

/** A CI step's badge: a failure a fix agent is working on is blue, not amber. */
export function boardCiStepBadgeState(
  status: BoardCiStepStatus,
  fixing: boolean,
): BoardStepBadgeState {
  if (status === "failed" || status === "timed-out") return fixing ? "fixing" : "failed";
  return status;
}

export interface BoardCiSegment {
  readonly name: string;
  readonly state: BoardStepBadgeState;
  readonly tooltip: string;
}

const SEGMENT_WORD: Record<BoardStepBadgeState, string> = {
  pending: "pending",
  running: "running",
  passed: "passed",
  failed: "failed",
  fixing: "being fixed",
  cancelled: "cancelled",
};

/** One progress segment per step of the entry's current pass. */
export function boardCiSegments(ci: BoardCardCi): ReadonlyArray<BoardCiSegment> {
  const fixing = ci.phase === "fixing";
  return ci.steps.map((step) => {
    const state = boardCiStepBadgeState(step.status, fixing);
    return { name: step.name, state, tooltip: `${step.name} · ${SEGMENT_WORD[state]}` };
  });
}

export type BoardCiChipTone = "info" | "success" | "neutral" | "warning" | "attention";

/** The fix segment after the last step (T3O-57): outlined while a failed
    pass still runs, blue while fixing, violet once stopped for a human. */
export type BoardCiFixSegmentState = "pending" | "fixing" | "stopped";

export interface BoardCiFace {
  readonly chip: { readonly label: string; readonly tone: BoardCiChipTone };
  readonly segments: ReadonlyArray<BoardCiSegment>;
  /** Shown once any step failed, or while fixing or stopped; null otherwise. */
  readonly fixSegment: BoardCiFixSegmentState | null;
  /** Steps passed over steps in the pass, `2/3`. */
  readonly count: string;
  readonly detail: string;
  /** A held pass's detail is amber (T3O-61): it says what is blocking it. */
  readonly detailTone?: "warning";
  readonly tooltip: string;
}

/** What failed and why, as one line (T3O-61). */
function boardCiHeadlineText(headline: { readonly what: string; readonly why: string }) {
  return `${headline.what}: ${headline.why}`;
}

const failWord = (status: BoardCiStepStatus) => (status === "timed-out" ? "timed out" : "failed");

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function boardCiFixSegment(ci: BoardCardCi): BoardCiFixSegmentState | null {
  if (ci.phase === "fixing") return "fixing";
  if (ci.phase === "stopped") return "stopped";
  if (ci.phase === "running" && ci.steps.some((step) => isBoardCiStepFailure(step.status))) {
    return "pending";
  }
  return null;
}

/** The attempt a running fix is on. The shell counts attempts begun. */
function fixAttemptNumber(ci: BoardCardCi): number {
  return Math.max(1, ci.fixAttempts);
}

/**
 * The card face while the card is in CI. Whole minutes only: the face is
 * repainted at most once a minute (`useNowMinute`), and nothing on it animates.
 */
/** A held pass's chip: a machine problem, a human's Stop, or a pass CI
    couldn't run (T3O-59). */
function boardCiHeldLabel(ci: Pick<BoardCardCi, "machine" | "stopReason">): string {
  if (ci.machine === true) return "Machine problem";
  return ci.stopReason === BOARD_CI_STOPPED_BY_YOU_REASON ? "Stopped" : "Can't run";
}

export function boardCiFace(ci: BoardCardCi, nowMs: number): BoardCiFace {
  const segments = boardCiSegments(ci);
  const fixSegment = boardCiFixSegment(ci);
  const total = ci.steps.length;
  const failedCount = ci.steps.filter((step) => isBoardCiStepFailure(step.status)).length;
  const passed = ci.steps.filter((step) => step.status === "passed").length;
  const running = ci.steps.find((step) => step.status === "running");
  const failed = ci.steps.find((step) => isBoardCiStepFailure(step.status));
  const count = `${passed}/${total}`;
  switch (ci.phase) {
    case "queued":
      return {
        chip: { label: "Queued", tone: "neutral" },
        segments,
        fixSegment,
        count,
        detail: "Waiting for a CI slot",
        tooltip: "CI starts as soon as a slot is free",
      };
    case "passed":
      return {
        chip: { label: "Passed", tone: "success" },
        segments,
        fixSegment,
        count,
        detail: "Every step passed",
        tooltip: "CI passed; the card moves on",
      };
    // T3O-59: held says why, and a machine problem says so.
    // A machine hold leads with the problem; any other hold with why it was held.
    case "held": {
      const headline = ci.machine === true ? ci.headline : undefined;
      return {
        chip: { label: boardCiHeldLabel(ci), tone: "warning" },
        segments,
        fixSegment,
        count,
        detail:
          headline === undefined
            ? (ci.stopReason ?? "CI couldn't finish this pass")
            : boardCiHeadlineText(headline),
        detailTone: "warning",
        tooltip:
          headline !== undefined && ci.stopReason !== undefined
            ? ci.stopReason
            : "Retry CI to run it again, or Skip CI",
      };
    }
    // T3O-49/57: fix attempts used up, a fix the agent couldn't make, or a
    // conflict CI couldn't resolve.
    case "stopped":
      return {
        chip: { label: "Needs you", tone: "attention" },
        segments,
        fixSegment,
        count,
        detail: ci.stopReason ?? "CI stopped for a human",
        tooltip: "Retry CI, send the card back to review anyway, or Skip CI",
      };
    case "fixing": {
      const attempt = `fix ${fixAttemptNumber(ci)} of ${ci.maxFixAttempts}`;
      return {
        chip: { label: "Fixing", tone: "info" },
        segments,
        fixSegment,
        count,
        detail:
          ci.fixIssues !== undefined
            ? `Fix ${fixAttemptNumber(ci)} of ${ci.maxFixAttempts} · ${plural(ci.fixIssues, "issue", "issues")}`
            : ci.headline !== undefined
              ? `${attempt} · ${boardCiHeadlineText(ci.headline)}`
              : failed === undefined
                ? `Check failed · ${attempt}`
                : `${failed.name} ${failWord(failed.status)} · ${attempt}`,
        tooltip:
          "A fix agent is working on every failure. Every step re-runs from the top after the fix.",
      };
    }
    case "running": {
      if (running === undefined) {
        return {
          chip: { label: "Running", tone: "info" },
          segments,
          fixSegment,
          count,
          detail:
            failed === undefined
              ? "Starting"
              : ci.headline !== undefined
                ? boardCiHeadlineText(ci.headline)
                : `${failed.name} ${failWord(failed.status)}`,
          tooltip: `CI over ${total} ${total === 1 ? "step" : "steps"}`,
        };
      }
      const index = ci.steps.indexOf(running);
      // T3O-60: a script reporting progress shows how far it got, not a timer.
      const progress =
        running.progress === undefined ? null : boardCiProgressLabel(running.progress);
      const minutes = boardCiElapsedMinutes(running.startedAt, nowMs);
      const elapsed = progress ?? (minutes < 1 ? "under 1m" : `${minutes}m`);
      return {
        chip: { label: "Running", tone: "info" },
        segments,
        fixSegment,
        count,
        // T3O-57: with Stop on failure off, failures so far lead the line.
        detail:
          failedCount > 0
            ? `${failedCount} failed · running ${running.name} · ${elapsed}`
            : `${running.name} · ${elapsed}`,
        tooltip: `Step ${index + 1} of ${total} running${
          progress === null || running.progress?.message == null
            ? ""
            : ` · ${running.progress.message}`
        }`,
      };
    }
  }
}

/** How a card that left CI other than by passing says so on its face, or
    null. Only outside CI: the server clears it when the card re-enters. */
export type BoardCiLastOutcomeFace =
  | { readonly kind: "sent-back"; readonly line: string; readonly tooltip: string }
  | { readonly kind: "skipped"; readonly label: string; readonly tooltip: string };

function sentBackLine(outcome: BoardCardCiLastOutcome): string {
  const step = outcome.stepName ?? "A step";
  const used = outcome.fixAttemptsUsed ?? 0;
  if (used === 0) return `${step} failed`;
  return `${step} still failing after ${used} fix ${used === 1 ? "attempt" : "attempts"}`;
}

export function boardCiLastOutcomeFace(input: {
  readonly inCi: boolean;
  readonly outcome: BoardCardCiLastOutcome | null | undefined;
}): BoardCiLastOutcomeFace | null {
  const outcome = input.outcome;
  if (input.inCi || outcome == null) return null;
  if (outcome.kind === "skipped") {
    return {
      kind: "skipped",
      label: `CI skipped by ${outcome.actor ?? "someone"}`,
      tooltip: "Moved past CI without a passing run",
    };
  }
  return {
    kind: "sent-back",
    line: sentBackLine(outcome),
    tooltip: "Sent back to Code review from CI. The failure went with it as a must-fix finding.",
  };
}

/** The card view's banner for a card CI sent back, or null. */
export function boardCiSentBackBanner(input: {
  readonly inCi: boolean;
  readonly outcome: BoardCardCiLastOutcome | null | undefined;
}): { readonly title: string; readonly reason: string; readonly meta: string } | null {
  const outcome = input.outcome;
  if (input.inCi || outcome == null || outcome.kind !== "sent-back") return null;
  const used = outcome.fixAttemptsUsed ?? 0;
  return {
    title: `Sent back from CI · ${sentBackLine(outcome)}`,
    reason: outcome.finding ?? "",
    meta: `${used} fix ${used === 1 ? "attempt" : "attempts"} used · the failure is a must-fix finding in this review round`,
  };
}

const BOARD_CI_PASS_OUTCOME_LABEL: Record<BoardCiPassOutcome, string> = {
  passed: "Passed",
  "fixed-in-place": "Fixed in place",
  "sent-back": "Sent back to review",
  skipped: "Skipped",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
  stopped: "Stopped for you",
};

/** A pass's outcome chip. A pass with no outcome is the live one. */
export function boardCiPassOutcomeChip(
  pass: Pick<BoardCiPass, "runId" | "outcome">,
  ci: Pick<BoardCardCi, "runId" | "phase"> | null | undefined,
): { readonly label: string; readonly tone: BoardCiChipTone } {
  if (pass.outcome !== null) {
    return {
      label: BOARD_CI_PASS_OUTCOME_LABEL[pass.outcome],
      tone: pass.outcome === "passed" ? "success" : "neutral",
    };
  }
  const live = ci != null && ci.runId === pass.runId ? ci.phase : null;
  if (live === "fixing") return { label: "Fixing", tone: "info" };
  if (live === "queued") return { label: "Queued", tone: "neutral" };
  if (live === "passed") return { label: "Passed", tone: "success" };
  if (live === "running") return { label: "Running", tone: "info" };
  return { label: "Not finished", tone: "neutral" };
}

/** The collapsed pass header's one-liner: the failing step, how many failed
    when more than one did (T3O-57), or the skip. */
export function boardCiPassSummary(pass: Pick<BoardCiPass, "outcome" | "steps">): string {
  const failures = pass.steps.filter((step) => isBoardCiStepFailure(step.status));
  if (failures.length > 1) return `${failures.length} of ${pass.steps.length} steps failed`;
  const failed = failures[0];
  if (failed !== undefined) return `${failed.name} ${failWord(failed.status)}`;
  if (pass.outcome === "skipped") return "Skipped by a human";
  return "";
}

/** The CI tab header's status chip. */
export function boardCiPaneStatus(input: {
  readonly ci: BoardCardCi | null | undefined;
  readonly lastOutcome: BoardCardCiLastOutcome | null | undefined;
  readonly lastPass: Pick<BoardCiPass, "outcome"> | undefined;
}): { readonly label: string; readonly tone: BoardCiChipTone } | null {
  const { ci } = input;
  if (ci != null) {
    if (ci.phase === "fixing") {
      const failed = ci.steps.find((step) => isBoardCiStepFailure(step.status));
      return { label: `Fixing ${failed?.name ?? "a step"}`, tone: "info" };
    }
    if (ci.phase === "queued") return { label: "Queued", tone: "neutral" };
    if (ci.phase === "passed") return { label: "Passed", tone: "success" };
    if (ci.phase === "held") {
      return { label: boardCiHeldLabel(ci), tone: "warning" };
    }
    if (ci.phase === "stopped") return { label: "Needs you", tone: "attention" };
    const index = ci.steps.findIndex((step) => step.status === "running");
    return {
      label: index < 0 ? "Running" : `Step ${index + 1} of ${ci.steps.length}`,
      tone: "info",
    };
  }
  if (input.lastOutcome?.kind === "sent-back")
    return { label: "Sent back to review", tone: "neutral" };
  if (input.lastOutcome?.kind === "skipped") return { label: "Skipped", tone: "neutral" };
  const outcome = input.lastPass?.outcome ?? null;
  if (outcome === null) return null;
  return {
    label: BOARD_CI_PASS_OUTCOME_LABEL[outcome],
    tone: outcome === "passed" ? "success" : "neutral",
  };
}

/** Whether the card's CI is live, which lights the tab's blue dot. */
export function isBoardCiLive(ci: BoardCardCi | null | undefined): boolean {
  return ci != null && (ci.phase === "running" || ci.phase === "fixing");
}

/** A finished step's duration: `46s`, `2m 04s`, `1h 03m`. */
export function formatBoardCiDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The running step's per-second timer: `0:14`, `1:12`, `1:02:03`. */
export function formatBoardCiTimer(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const s = String(seconds % 60).padStart(2, "0");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}:${s}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${s}`;
}

/** The header over a step's output tail. */
export function boardCiTailMeta(tail: string): string {
  const lines = tail.length === 0 ? 0 : tail.replace(/\n$/, "").split("\n").length;
  return `Output tail · last ${BOARD_CI_TAIL_LINES} lines${
    lines < BOARD_CI_TAIL_LINES ? ` (${lines} captured)` : ""
  }`;
}

/**
 * A failed pass's "Fix failures" row (T3O-57): the fix as the pass's last
 * step, with one row per issue. A pass's ordinal is not its fix attempt (a held
 * or restarted pass takes an ordinal without a fix), so the fix's completion is
 * the one from the pass's recorded fix thread, or the live attempt while the
 * card is still fixing this pass. There is no live per-issue progress.
 */
export interface BoardCiFixRow {
  readonly state: "running" | "reported" | "after-pass" | "not-run";
  readonly badge: BoardStepBadgeState;
  readonly headline: string;
  readonly issues: ReadonlyArray<{
    readonly id: string;
    readonly stepName: string;
    readonly title: string;
    readonly where: string | null;
    readonly status: BoardCiFixIssueStatus;
    readonly note: string | null;
  }>;
  readonly fixedSha: string | null;
}

export function boardCiFixRow(input: {
  readonly pass: Pick<BoardCiPass, "runId" | "entry" | "steps" | "fixThreadId">;
  readonly completions: ReadonlyArray<Pick<BoardStepCompletion, "stepId" | "payload" | "threadId">>;
  readonly ci: Pick<BoardCardCi, "runId" | "phase" | "fixAttempts" | "maxFixAttempts"> | null;
}): BoardCiFixRow | null {
  const issues = boardCiFixIssues(input.pass.steps);
  if (issues.length === 0) return null;
  const fixingNow =
    input.ci !== null && input.ci.runId === input.pass.runId && input.ci.phase === "fixing";
  const { entry, fixThreadId } = input.pass;
  const liveStepId =
    fixingNow && input.ci !== null ? boardCiFixStepId(entry, input.ci.fixAttempts) : null;
  const completion = input.completions.findLast((candidate) =>
    fixThreadId === null
      ? candidate.stepId === liveStepId
      : candidate.threadId === fixThreadId &&
        parseBoardCiFixStepId(candidate.stepId)?.entry === entry,
  );
  const payload = completion === undefined ? null : decodeBoardCiFixPayload(completion.payload);
  const outcomes = boardCiFixIssueOutcomes(issues, payload).map((outcome) => ({
    id: outcome.issue.id,
    stepName: outcome.issue.stepName,
    title: outcome.issue.title,
    where:
      outcome.issue.file === undefined
        ? null
        : `${outcome.issue.file}${outcome.issue.line === undefined ? "" : `:${outcome.issue.line}`}`,
    status: outcome.status,
    note: outcome.note,
  }));
  const count = plural(issues.length, "issue", "issues");
  if (completion === undefined && fixingNow && input.ci !== null) {
    return {
      state: "running",
      badge: "fixing",
      headline: `Fix ${Math.max(1, input.ci.fixAttempts)} of ${input.ci.maxFixAttempts} · ${count}`,
      issues: outcomes,
      fixedSha: null,
    };
  }
  const passLive =
    input.ci !== null &&
    input.ci.runId === input.pass.runId &&
    (input.ci.phase === "running" || input.ci.phase === "queued");
  if (completion === undefined && passLive) {
    return {
      state: "after-pass",
      badge: "pending",
      headline: `After the pass · ${count}`,
      issues: outcomes,
      fixedSha: null,
    };
  }
  if (completion === undefined) {
    return {
      state: "not-run",
      badge: "pending",
      headline: "Not run",
      issues: outcomes,
      fixedSha: null,
    };
  }
  const resolved = outcomes.filter((outcome) => outcome.status === "resolved").length;
  return {
    state: "reported",
    badge: resolved === outcomes.length ? "passed" : "failed",
    headline: `${resolved} of ${outcomes.length} resolved`,
    issues: outcomes,
    fixedSha: payload?.fixedSha ?? null,
  };
}

/** Whole minutes since `startedAt`, never negative. */
function boardCiElapsedMinutes(startedAt: string | null, nowMs: number): number {
  const startedMs = startedAt === null ? Number.NaN : Date.parse(startedAt);
  return Number.isNaN(startedMs) ? 0 : Math.max(0, Math.floor((nowMs - startedMs) / 60_000));
}

/** A running step's time against its limit (T3O-60): `12 / 60 min`, and
    whether it is over. */
export function boardCiStepLimit(
  step: { readonly startedAt: string | null; readonly timeoutMinutes: number },
  nowMs: number,
): { readonly elapsed: number; readonly limit: number; readonly over: boolean } {
  const elapsed = boardCiElapsedMinutes(step.startedAt, nowMs);
  return { elapsed, limit: step.timeoutMinutes, over: elapsed > step.timeoutMinutes };
}

/** How far a progress line says a step got, 0 to 1, or null with no total. */
export function boardCiProgressFraction(
  progress: Pick<BoardCiProgress, "done" | "total">,
): number | null {
  if (progress.done === null || progress.total === null || progress.total <= 0) return null;
  return Math.min(1, progress.done / progress.total);
}

/** The progress count, `128 / 212` (or the message when there's no count),
    or null when the line said nothing showable. */
export function boardCiProgressLabel(
  progress: Pick<BoardCiProgress, "done" | "total" | "message">,
): string | null {
  if (progress.done !== null && progress.total !== null) {
    return `${progress.done} / ${progress.total}`;
  }
  if (progress.done !== null) return String(progress.done);
  return progress.message;
}

/** "No output for N min" on a silent running step (T3O-60), or null. */
export function boardCiSilenceLabel(silentSince: string | undefined, nowMs: number): string | null {
  if (silentSince === undefined) return null;
  return `No output for ${boardCiElapsedMinutes(silentSince, nowMs)} min`;
}

/** Download's file name: `<card>-<step>-pass<N>.log`. */
export function boardCiLogFileName(cardKey: string, stepName: string, ordinal: number): string {
  const step = stepName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${cardKey}-${step.length === 0 ? "step" : step}-pass${ordinal}.log`;
}

/** The CI pane's headline (T3O-61): the pass's first failing step that says
    what failed and why, with its index for "Show in log". A live pass held
    before its step's row landed falls back to the card's headline. */
export function boardCiPaneHeadline(input: {
  readonly pass: BoardCiPass | undefined;
  readonly ci: BoardCardCi | null | undefined;
  readonly live: boolean;
}): { readonly headline: BoardCiHeadline; readonly index: number | null } | null {
  const steps = input.pass?.steps ?? [];
  const index = steps.findIndex(
    (step) => isBoardCiStepFailure(step.status) && step.headline !== undefined,
  );
  const step = index === -1 ? undefined : steps[index];
  if (step?.headline !== undefined) return { headline: step.headline, index };
  const fallback = input.live ? input.ci?.headline : undefined;
  return fallback === undefined ? null : { headline: fallback, index: null };
}

/**
 * T3o Continuous integration on the client (T3O-44): what the card face, the
 * card view's CI tab and its banner say about a card's CI runs. Pure, over the
 * shell's compact `ci` entry and the detail's pass records.
 *
 * Colours follow `docs/t3o/status-colours.md`: running and fixing are blue, a
 * passed step green, a terminal failure or a stopped pass amber, cancelled grey.
 */
import {
  BOARD_CI_TAIL_LINES,
  boardCiFixIssueOutcomes,
  boardCiFixIssues,
  boardCiFixStepId,
  decodeBoardCiFixPayload,
  isBoardCiStepFailure,
  type BoardCiFixIssueStatus,
  type BoardCardCi,
  type BoardStepCompletion,
  type BoardCardCiLastOutcome,
  type BoardCiPass,
  type BoardCiPassOutcome,
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
  readonly tooltip: string;
}

const failWord = (status: BoardCiStepStatus) => (status === "timed-out" ? "timed out" : "failed");

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function boardCiFixSegment(ci: BoardCardCi): BoardCiFixSegmentState | null {
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
    case "held":
      return {
        chip: { label: "Can't run", tone: "warning" },
        segments,
        fixSegment,
        count,
        detail: "CI couldn't finish this pass",
        tooltip: "Retry CI to run it again, or Skip CI",
      };
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
          detail: failed === undefined ? "Starting" : `${failed.name} ${failWord(failed.status)}`,
          tooltip: `CI over ${total} ${total === 1 ? "step" : "steps"}`,
        };
      }
      const startedMs = running.startedAt === null ? Number.NaN : Date.parse(running.startedAt);
      const minutes = Number.isNaN(startedMs)
        ? 0
        : Math.max(0, Math.floor((nowMs - startedMs) / 60_000));
      const index = ci.steps.indexOf(running);
      const elapsed = minutes < 1 ? "under 1m" : `${minutes}m`;
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
        tooltip: `Step ${index + 1} of ${total} running`,
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
    if (ci.phase === "held") return { label: "Can't run", tone: "warning" };
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
 * step, with one row per issue. Pass N of an entry is followed by fix N, so
 * the fix's completion is found by `boardCiFixStepId(entry, ordinal)`.
 * Outcomes show once the fix has reported; there is no live progress.
 */
export interface BoardCiFixRow {
  readonly state: "running" | "reported" | "not-run";
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
  readonly pass: Pick<BoardCiPass, "runId" | "entry" | "ordinal" | "steps">;
  readonly completions: ReadonlyArray<Pick<BoardStepCompletion, "stepId" | "payload">>;
  readonly ci: Pick<BoardCardCi, "runId" | "phase" | "fixAttempts" | "maxFixAttempts"> | null;
}): BoardCiFixRow | null {
  const issues = boardCiFixIssues(input.pass.steps);
  if (issues.length === 0) return null;
  const stepId = boardCiFixStepId(input.pass.entry, input.pass.ordinal);
  const completion = input.completions.findLast((candidate) => candidate.stepId === stepId);
  const fixingNow =
    input.ci !== null && input.ci.runId === input.pass.runId && input.ci.phase === "fixing";
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

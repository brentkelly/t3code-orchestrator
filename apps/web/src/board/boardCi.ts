/**
 * T3o Continuous integration on the client (T3O-44): what the card face, the
 * card view's CI tab and its banner say about a card's CI runs. Pure, over the
 * shell's compact `ci` entry and the detail's pass records.
 *
 * Colours follow `docs/t3o/status-colours.md`: running and fixing are blue, a
 * passed step green, a terminal failure amber, cancelled grey.
 */
import {
  BOARD_CI_TAIL_LINES,
  isBoardCiStepFailure,
  type BoardCardCi,
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

export type BoardCiChipTone = "info" | "success" | "neutral";

export interface BoardCiFace {
  readonly chip: { readonly label: string; readonly tone: BoardCiChipTone };
  readonly segments: ReadonlyArray<BoardCiSegment>;
  /** Steps passed over steps in the pass, `2/3`. */
  readonly count: string;
  readonly detail: string;
  readonly tooltip: string;
}

const failWord = (status: BoardCiStepStatus) => (status === "timed-out" ? "timed out" : "failed");

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
  const total = ci.steps.length;
  const passed = ci.steps.filter((step) => step.status === "passed").length;
  const running = ci.steps.find((step) => step.status === "running");
  const failed = ci.steps.find((step) => isBoardCiStepFailure(step.status));
  const count = `${passed}/${total}`;
  switch (ci.phase) {
    case "queued":
      return {
        chip: { label: "Queued", tone: "neutral" },
        segments,
        count,
        detail: "Waiting for a CI slot",
        tooltip: "CI starts as soon as a slot is free",
      };
    case "passed":
      return {
        chip: { label: "Passed", tone: "success" },
        segments,
        count,
        detail: "Every step passed",
        tooltip: "CI passed; the card moves on",
      };
    case "fixing": {
      const attempt = `fix ${fixAttemptNumber(ci)} of ${ci.maxFixAttempts}`;
      return {
        chip: { label: "Fixing", tone: "info" },
        segments,
        count,
        detail:
          failed === undefined
            ? `Check failed · ${attempt}`
            : `${failed.name} ${failWord(failed.status)} · ${attempt}`,
        tooltip:
          "A fix agent is working on the failed step. Every step re-runs from the top after the fix.",
      };
    }
    case "running": {
      if (running === undefined) {
        return {
          chip: { label: "Running", tone: "info" },
          segments,
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
      return {
        chip: { label: "Running", tone: "info" },
        segments,
        count,
        detail: `${running.name} · ${minutes < 1 ? "under 1m" : `${minutes}m`}`,
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
    tooltip:
      "CI sent this card back to Code review. The failure went with it as a must-fix finding.",
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

export const BOARD_CI_PASS_OUTCOME_LABEL: Record<BoardCiPassOutcome, string> = {
  passed: "Passed",
  "fixed-in-place": "Fixed in place",
  "sent-back": "Sent back to review",
  skipped: "Skipped",
  interrupted: "Interrupted",
  cancelled: "Cancelled",
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

/** The collapsed pass header's one-liner: the failing step, or the skip. */
export function boardCiPassSummary(pass: Pick<BoardCiPass, "outcome" | "steps">): string {
  const failed = pass.steps.find((step) => isBoardCiStepFailure(step.status));
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

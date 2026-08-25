/**
 * The Review pane's read of the code-review loop (t3o-16, D9). Pure functions
 * over a card's step completions — the SAME opaque payloads the agents write —
 * mirroring `ReviewLoopExecutor`'s decision rules so the pane's "where the
 * loop is up to" can never disagree with what the server will actually run
 * next:
 *
 * - a round with no findings at all converges immediately;
 * - a round with only nitpicks runs one triage pass, then converges without
 *   adjudication or another round;
 * - a round with blocking findings runs triage, then adjudication, then the
 *   next round's review;
 * - a malformed review payload halts the loop (never read as "no findings");
 * - running out of rounds ends the loop like a converged one — the card moves
 *   on — with the open findings still recorded here.
 *
 * The executor itself lives server-side (it also owns prompts, models and
 * step dispatch); what is mirrored here is only the pure phase-order walk.
 */
import {
  BOARD_REVIEW_PHASE_IDS,
  BoardAdjudicatePayload,
  BoardReviewPayload,
  BoardTriagePayload,
  isBoardReviewBlockingSeverity,
  parseReviewStepId,
  type BoardReviewFinding,
  type BoardReviewPhaseId,
  type BoardReviewTriageAction,
  type BoardReviewVerdict,
  type BoardStepCompletion,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeReviewPayload = Schema.decodeUnknownOption(BoardReviewPayload);
const decodeTriagePayload = Schema.decodeUnknownOption(BoardTriagePayload);
const decodeAdjudicatePayload = Schema.decodeUnknownOption(BoardAdjudicatePayload);

function parsePayloadJson(payload: string | null): unknown {
  if (payload === null) return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/** How a finding stands right now, folding its triage disposition and its
    adjudication verdict into the one word the row shows. A disposition the
    adjudicator struck down ("fix-incomplete", "fix-absent",
    "rejection-unjustified") reads `disputed` — the claim did not hold. */
export type BoardReviewFindingResolution = "open" | "fixed" | "rejected" | "disputed";

export interface BoardReviewLoopFinding {
  readonly finding: BoardReviewFinding;
  readonly resolution: BoardReviewFindingResolution;
  /** The triage phase's raw call, before any adjudication verdict folds into
      `resolution` — what the triage step itself did with the finding. */
  readonly disposition: BoardReviewTriageAction | null;
  readonly dispositionNote: string;
  readonly verdict: BoardReviewVerdict | null;
  readonly verdictNote: string;
}

export type BoardReviewPhaseStatus = "done" | "running" | "pending" | "skipped";

export interface BoardReviewLoopPhase {
  readonly phase: BoardReviewPhaseId;
  readonly status: BoardReviewPhaseStatus;
  /** The completed phase's thread, so the pane can deep-link into it. */
  readonly threadId: ThreadId | null;
  readonly completedAt: string | null;
}

export type BoardReviewRoundOutcome =
  /** The loop is still inside this round. */
  | "in-progress"
  /** The round's review raised no blocking finding. */
  | "clean"
  /** The round raised blocking findings and ran its full phase sequence. */
  | "changes-requested"
  /** The round's review recorded a payload nothing can read. */
  | "unreadable";

export interface BoardReviewLoopRound {
  readonly round: number;
  readonly outcome: BoardReviewRoundOutcome;
  readonly reviewMalformed: boolean;
  readonly findings: ReadonlyArray<BoardReviewLoopFinding>;
  readonly severities: {
    readonly critical: number;
    readonly improvement: number;
    readonly nitpick: number;
  };
  readonly counts: {
    readonly fixed: number;
    readonly rejected: number;
    readonly open: number;
    readonly disputed: number;
  };
  readonly phases: ReadonlyArray<BoardReviewLoopPhase>;
  /** The round's most recent phase completion, for the head's timestamp. */
  readonly completedAt: string | null;
}

export type BoardReviewLoopStatus =
  /** A phase is due (running when the card's thread is live, else waiting). */
  | "running"
  /** A round closed with nothing blocking — the loop is settled. */
  | "converged"
  /** Every round ran without a clean pass; the loop ended at the cap (the
      card moves on) with its open findings still recorded. */
  | "round-cap"
  /** A review phase recorded an unreadable payload; the loop halted. */
  | "unreadable";

export interface BoardReviewLoop {
  readonly rounds: ReadonlyArray<BoardReviewLoopRound>;
  readonly maxRounds: number;
  /** The round the loop is in (or ended on). At least 1. */
  readonly currentRound: number;
  /** The phase the loop runs next, while it still runs. */
  readonly next: { readonly phase: BoardReviewPhaseId; readonly round: number } | null;
  readonly status: BoardReviewLoopStatus;
  readonly totals: {
    readonly raised: number;
    readonly fixed: number;
    readonly rejected: number;
    readonly open: number;
    readonly disputed: number;
  };
}

/** Whether any of a card's completions belong to the review loop — the pane
    (and its tab) exist exactly when this, or the review stage itself, does. */
export function hasBoardReviewSteps(completions: ReadonlyArray<BoardStepCompletion>): boolean {
  return completions.some((completion) => parseReviewStepId(completion.stepId) !== null);
}

function resolutionOf(
  disposition: { readonly action: "fixed" | "rejected"; readonly note: string } | undefined,
  verdict: { readonly verdict: BoardReviewVerdict; readonly note: string } | undefined,
): BoardReviewFindingResolution {
  if (disposition === undefined) return "open";
  if (verdict !== undefined) {
    if (verdict.verdict === "fix-upheld") return "fixed";
    if (verdict.verdict === "rejection-justified") return "rejected";
    return "disputed";
  }
  return disposition.action;
}

/**
 * Fold a card's completions into the loop's full state. Only `succeeded`
 * completions count, exactly as the executor's `succeededReviewSteps` — a
 * failed phase is the reactor's to retry, not a phase that happened.
 */
export function deriveBoardReviewLoop(
  completions: ReadonlyArray<BoardStepCompletion>,
  maxRounds: number,
): BoardReviewLoop {
  const byStep = new Map<string, BoardStepCompletion>();
  let highestRound = 0;
  for (const completion of completions) {
    const parsed = parseReviewStepId(completion.stepId);
    if (parsed === null || completion.outcome !== "succeeded") continue;
    byStep.set(completion.stepId, completion);
    highestRound = Math.max(highestRound, parsed.round);
  }

  // The executor's walk (reviewLoopDecision), verbatim in miniature: find the
  // phase due next, or how the loop ended. The walk is bounded by the
  // CONFIGURED cap exactly as the executor's is — a recorded round beyond a
  // since-lowered cap is history the executor will never re-enter, so it is
  // rendered below but never treated as "the loop is still running".
  interface Walk {
    readonly next: { readonly phase: BoardReviewPhaseId; readonly round: number } | null;
    readonly status: BoardReviewLoopStatus;
    readonly currentRound: number;
  }
  const walk = (): Walk => {
    for (let round = 1; round <= maxRounds; round++) {
      const review = byStep.get(`review@${round}`);
      if (review === undefined) {
        return { next: { phase: "review", round }, status: "running", currentRound: round };
      }
      const payload = decodeReviewPayload(parsePayloadJson(review.payload));
      if (Option.isNone(payload)) {
        return { next: null, status: "unreadable", currentRound: round };
      }
      const findings = payload.value.findings;
      const blocking = findings.some((f) => isBoardReviewBlockingSeverity(f.severity));
      if (findings.length > 0 && byStep.get(`triage@${round}`) === undefined) {
        return { next: { phase: "triage", round }, status: "running", currentRound: round };
      }
      if (blocking && byStep.get(`adjudicate@${round}`) === undefined) {
        return { next: { phase: "adjudicate", round }, status: "running", currentRound: round };
      }
      // The loop check, the executor's alone: another round only when this one
      // raised a blocking finding AND rounds remain.
      if (!blocking) {
        return { next: null, status: "converged", currentRound: round };
      }
    }
    return { next: null, status: "round-cap", currentRound: maxRounds };
  };
  const { next, status, currentRound } = walk();

  const roundModels: BoardReviewLoopRound[] = [];
  // Recorded rounds beyond the walk (a since-lowered cap) still render.
  const shownRounds = Math.max(currentRound, highestRound);
  for (let round = 1; round <= shownRounds; round++) {
    const review = byStep.get(`review@${round}`);
    const triage = byStep.get(`triage@${round}`);
    const adjudicate = byStep.get(`adjudicate@${round}`);
    if (review === undefined && triage === undefined && adjudicate === undefined) {
      // The round exists only as "the loop is about to run its review".
      if (next === null || next.round !== round) continue;
    }

    const reviewPayload = review
      ? decodeReviewPayload(parsePayloadJson(review.payload))
      : Option.none();
    const triagePayload = triage
      ? decodeTriagePayload(parsePayloadJson(triage.payload))
      : Option.none();
    const adjudicatePayload = adjudicate
      ? decodeAdjudicatePayload(parsePayloadJson(adjudicate.payload))
      : Option.none();
    const reviewMalformed = review !== undefined && Option.isNone(reviewPayload);

    const rawFindings = Option.isSome(reviewPayload) ? reviewPayload.value.findings : [];
    const dispositions = new Map(
      (Option.isSome(triagePayload) ? triagePayload.value.dispositions : []).map((d) => [
        d.findingId,
        d,
      ]),
    );
    const verdicts = new Map(
      (Option.isSome(adjudicatePayload) ? adjudicatePayload.value.verdicts : []).map((v) => [
        v.findingId,
        v,
      ]),
    );
    const findings: BoardReviewLoopFinding[] = rawFindings.map((finding) => {
      const disposition = dispositions.get(finding.id);
      const verdict = verdicts.get(finding.id);
      return {
        finding,
        resolution: resolutionOf(disposition, verdict),
        disposition: disposition?.action ?? null,
        dispositionNote: disposition?.note ?? "",
        verdict: verdict?.verdict ?? null,
        verdictNote: verdict?.note ?? "",
      };
    });

    const blocking = rawFindings.filter((f) => isBoardReviewBlockingSeverity(f.severity)).length;
    const phaseStatus = (phase: BoardReviewPhaseId): BoardReviewPhaseStatus => {
      const completion = phase === "review" ? review : phase === "triage" ? triage : adjudicate;
      if (completion !== undefined) return "done";
      if (next !== null && next.round === round && next.phase === phase) return "running";
      if (review === undefined || reviewMalformed) return "pending";
      // The review has spoken: phases its findings never summon are skipped,
      // matching the executor — no triage for a clean round, no adjudication
      // without a blocking finding.
      if (phase === "triage") return rawFindings.length === 0 ? "skipped" : "pending";
      return blocking === 0 ? "skipped" : "pending";
    };
    const phases: BoardReviewLoopPhase[] = BOARD_REVIEW_PHASE_IDS.map((phase) => {
      const completion = phase === "review" ? review : phase === "triage" ? triage : adjudicate;
      return {
        phase,
        status: phaseStatus(phase),
        threadId: completion?.threadId ?? null,
        completedAt: completion?.completedAt ?? null,
      };
    });

    const stamps = [review, triage, adjudicate]
      .filter((completion) => completion !== undefined)
      .map((completion) => completion.completedAt)
      .sort();
    const roundDone =
      review !== undefined && !reviewMalformed && (next === null || next.round !== round);
    roundModels.push({
      round,
      outcome: reviewMalformed
        ? "unreadable"
        : !roundDone
          ? "in-progress"
          : blocking > 0
            ? "changes-requested"
            : "clean",
      reviewMalformed,
      findings,
      severities: {
        critical: rawFindings.filter((f) => f.severity === "critical").length,
        improvement: rawFindings.filter((f) => f.severity === "improvement").length,
        nitpick: rawFindings.filter((f) => f.severity === "nitpick").length,
      },
      counts: {
        fixed: findings.filter((f) => f.resolution === "fixed").length,
        rejected: findings.filter((f) => f.resolution === "rejected").length,
        open: findings.filter((f) => f.resolution === "open").length,
        disputed: findings.filter((f) => f.resolution === "disputed").length,
      },
      phases,
      completedAt: stamps.length > 0 ? (stamps[stamps.length - 1] ?? null) : null,
    });
  }

  const all = roundModels.flatMap((round) => round.findings);
  return {
    rounds: roundModels,
    // The segment bar's width: the cap, stretched only to fit recorded history.
    maxRounds: Math.max(maxRounds, highestRound),
    currentRound,
    next,
    status,
    totals: {
      raised: all.length,
      fixed: all.filter((f) => f.resolution === "fixed").length,
      rejected: all.filter((f) => f.resolution === "rejected").length,
      open: all.filter((f) => f.resolution === "open").length,
      disputed: all.filter((f) => f.resolution === "disputed").length,
    },
  };
}

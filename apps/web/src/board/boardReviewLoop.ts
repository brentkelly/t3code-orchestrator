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
  boardReviewFindingResolution,
  boardReviewLoopWalk,
  BoardTriagePayload,
  isBoardReviewBlockingSeverity,
  parseReviewStepId,
  type BoardReviewFinding,
  type BoardReviewFindingResolution,
  type BoardReviewLoopOutcome,
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

/** Re-exported from contracts, where the folding rule now lives so the pane
    and the column card's summary agree on what "fixed" means. */
export type { BoardReviewFindingResolution };

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

/**
 * Where the loop stands. The vocabulary is `BoardReviewLoopOutcome` from
 * contracts, shared with the column card's summary so the two surfaces cannot
 * describe the same loop differently:
 *
 *  - `running`    — a phase is due (spinning when the card's thread is live).
 *  - `converged`  — a round closed with nothing blocking; the loop passed.
 *  - `round-cap`  — every round ran without a clean pass. The card does NOT
 *                   move on (t3o-22, D1): nothing was signed off.
 *  - `stopped`    — the user held the loop after a round, budget remaining.
 *  - `unreadable` — a review phase recorded a payload nothing can read.
 */
export type BoardReviewLoopStatus = BoardReviewLoopOutcome;

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

/**
 * Fold a card's completions into the loop's full state. Only `succeeded`
 * completions count, exactly as the executor's `succeededReviewSteps` — a
 * failed phase is the reactor's to retry, not a phase that happened.
 */
export function deriveBoardReviewLoop(
  completions: ReadonlyArray<BoardStepCompletion>,
  maxRounds: number,
  /** The card's stop-after-round, if it set one (t3o-22, D5). */
  stopAfterRound: number | null = null,
): BoardReviewLoop {
  const byStep = new Map<string, BoardStepCompletion>();
  let highestRound = 0;
  for (const completion of completions) {
    const parsed = parseReviewStepId(completion.stepId);
    if (parsed === null || completion.outcome !== "succeeded") continue;
    byStep.set(completion.stepId, completion);
    highestRound = Math.max(highestRound, parsed.round);
  }

  // The executor's walk, from contracts (t3o-22, D7) so the pane, the column
  // card's cached summary and the executor cannot drift on where the loop is.
  // It is bounded by the EFFECTIVE cap exactly as the executor's is — a round
  // recorded beyond a since-lowered cap is history the executor will never
  // re-enter, so it is rendered below but never treated as "still running".
  const { next, status, currentRound } = boardReviewLoopWalk({
    completions,
    maxRounds,
    stopAfterRound,
  });

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
        resolution: boardReviewFindingResolution(disposition, verdict),
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
      // A round beyond the walk (recorded before the cap was lowered) will
      // never run its remaining phases — skipped, not forever pending.
      if (round > currentRound) return "skipped";
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

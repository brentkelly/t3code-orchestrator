/**
 * The Review pane's read of the review loop: pure functions over the card's step
 * completions that mirror `ReviewLoopExecutor`'s phase-order walk, so the pane
 * cannot disagree with what the server runs next.
 */
import {
  BOARD_REVIEW_PHASE_IDS,
  BoardAdjudicatePayload,
  BoardRetriagePayload,
  BoardReviewPayload,
  boardReviewCarriedFixFindings,
  boardReviewDismissals,
  boardReviewFindingResolution,
  boardReviewLoopWalk,
  BoardTriagePayload,
  type BoardReviewCarry,
  type BoardReviewFollowUpPhase,
  type BoardReviewRetriageAction,
  type BoardReviewStuckFinding,
  isBoardReviewBlockingSeverity,
  parseBoardStepPayloadJson,
  parseReviewStepId,
  type BoardReviewFinding,
  type BoardReviewFindingResolution,
  type BoardReviewLoopOutcome,
  type BoardReviewPhaseId,
  type BoardReviewStepPhase,
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
const decodeRetriagePayload = Schema.decodeUnknownOption(BoardRetriagePayload);

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
  /** The second pass, when the adjudicator overruled triage (T3O-51). */
  readonly retriage: BoardReviewRetriageAction | null;
  readonly retriageNote: string;
  readonly reverdict: BoardReviewVerdict | null;
  readonly reverdictNote: string;
  /** The round this finding was first raised in, when a human carried it in
      as must-fix; null for the reviewer's own. */
  readonly carriedFrom: number | null;
}

/** A finding a human ruled not an issue, at or before this round (T3O-51). */
export interface BoardReviewLoopDismissal {
  readonly findingId: string;
  readonly title: string;
  readonly round: number;
}

export type BoardReviewPhaseStatus = "done" | "running" | "pending" | "skipped";

export interface BoardReviewLoopPhase {
  readonly phase: BoardReviewPhaseId | BoardReviewFollowUpPhase;
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
  /** One of the round's phases recorded a payload nothing can read. */
  | "unreadable"
  /** A dispute survived the round's second pass (T3O-51). */
  | "stuck";

export interface BoardReviewLoopRound {
  readonly round: number;
  readonly outcome: BoardReviewRoundOutcome;
  readonly reviewMalformed: boolean;
  /** The human's ruling carried INTO this round (T3O-51): `fix` opens it
      with must-fix findings. */
  readonly carriedRuling: { readonly fromRound: number; readonly note: string | null } | null;
  /** Findings a human dismissed by this round. */
  readonly dismissals: ReadonlyArray<BoardReviewLoopDismissal>;
  /** The round's phase whose payload the board cannot read, when the loop
      halted on it — what the Reopen affordance names and repairs (T3O-14).
      `reviewMalformed` stays beside it because a broken REVIEW is the one that
      also leaves the round's later phases unsummoned. */
  readonly unreadablePhase: BoardReviewStepPhase | null;
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
    readonly escalated: number;
  };
  /** The round's phases in order. The follow-ups appear only when they ran or
      are due (T3O-51). */
  readonly phases: ReadonlyArray<BoardReviewLoopPhase>;
  /** The round's most recent phase completion, for the head's timestamp. */
  readonly completedAt: string | null;
}

/**
 * Where the loop stands, in `BoardReviewLoopOutcome`'s vocabulary (shared with
 * the column card). `round-cap` never moves the card on: nothing was signed off.
 */
export type BoardReviewLoopStatus = BoardReviewLoopOutcome;

export interface BoardReviewLoop {
  readonly rounds: ReadonlyArray<BoardReviewLoopRound>;
  readonly maxRounds: number;
  /** The round the loop is in (or ended on). At least 1. */
  readonly currentRound: number;
  /** The phase the loop runs next, while it still runs. */
  readonly next: { readonly phase: BoardReviewStepPhase; readonly round: number } | null;
  readonly status: BoardReviewLoopStatus;
  /** What a stuck loop stopped on (T3O-51); empty otherwise. */
  readonly stuckFindings: ReadonlyArray<BoardReviewStuckFinding>;
  /** The stuck (or advanced-past) round's fixes no review has read. */
  readonly unreviewedFixes: number;
  /** Set when the adjudicator ended the loop: nothing new was raised. */
  readonly convergedBy: "adjudicator" | null;
  /** The step id the loop halted `unreadable` on, null otherwise — the record
      the pane's Reopen sends back (T3O-14). */
  readonly unreadableStepId: string | null;
  readonly totals: {
    readonly raised: number;
    readonly fixed: number;
    readonly rejected: number;
    readonly open: number;
    readonly disputed: number;
    readonly escalated: number;
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
  /** The card's run-through-round, if a human asked a settled loop for one
      more pass (T3O-39, D13). Without it the pane reports `converged` while
      the executor is dispatching round N+1. */
  runThroughRound: number | null = null,
  /** The card's server-written carry fields (T3O-51). */
  carry: {
    readonly carriedFindings: Readonly<Record<string, BoardReviewCarry>>;
    readonly stuckWaivedThrough: number | null;
  } = { carriedFindings: {}, stuckWaivedThrough: null },
): BoardReviewLoop {
  const byStep = new Map<string, BoardStepCompletion>();
  let highestRound = 0;
  for (const completion of completions) {
    const parsed = parseReviewStepId(completion.stepId);
    if (parsed === null || completion.outcome !== "succeeded") continue;
    byStep.set(completion.stepId, completion);
    highestRound = Math.max(highestRound, parsed.round);
  }

  // The executor's walk from contracts, bounded by the effective cap: rounds
  // beyond a since-lowered cap render as history, never as still running.
  const walk = boardReviewLoopWalk({
    completions,
    maxRounds,
    stopAfterRound,
    runThroughRound,
    carriedFindings: carry.carriedFindings,
    stuckWaivedThrough: carry.stuckWaivedThrough,
  });
  const { next, status, currentRound, unreadableStepId } = walk;
  const unreadable = unreadableStepId === null ? null : parseReviewStepId(unreadableStepId);

  const roundModels: BoardReviewLoopRound[] = [];
  // Recorded rounds beyond the walk (a since-lowered cap) still render.
  const shownRounds = Math.max(currentRound, highestRound);
  for (let round = 1; round <= shownRounds; round++) {
    const review = byStep.get(`review@${round}`);
    const triage = byStep.get(`triage@${round}`);
    const adjudicate = byStep.get(`adjudicate@${round}`);
    const retriage = byStep.get(`retriage@${round}`);
    const readjudicate = byStep.get(`readjudicate@${round}`);
    if (review === undefined && triage === undefined && adjudicate === undefined) {
      // The round exists only as "the loop is about to run its review".
      if (next === null || next.round !== round) continue;
    }

    const decodeOf = <A>(
      completion: BoardStepCompletion | undefined,
      decode: (value: unknown) => Option.Option<A>,
    ): A | null =>
      completion === undefined
        ? null
        : Option.getOrNull(decode(parseBoardStepPayloadJson(completion.payload)));
    const reviewPayload = decodeOf(review, decodeReviewPayload);
    const triagePayload = decodeOf(triage, decodeTriagePayload);
    const adjudicatePayload = decodeOf(adjudicate, decodeAdjudicatePayload);
    const retriagePayload = decodeOf(retriage, decodeRetriagePayload);
    const readjudicatePayload = decodeOf(readjudicate, decodeAdjudicatePayload);
    const reviewMalformed = review !== undefined && reviewPayload === null;

    // A human's Fix it carries findings into this round as must-fix; the board
    // adds them itself, so they join the round whatever the reviewer said.
    const carryEntry = carry.carriedFindings[String(round)];
    const carried = boardReviewCarriedFixFindings(carry.carriedFindings, round);
    const carriedIds = new Set(carried.map((entry) => entry.findingId));
    const rawFindings: ReadonlyArray<BoardReviewFinding & { readonly carriedFrom: number | null }> =
      reviewPayload === null
        ? []
        : [
            ...reviewPayload.findings
              .filter((finding) => !carriedIds.has(finding.id))
              .map((finding) => ({ ...finding, carriedFrom: null })),
            ...carried.map((entry) => ({
              id: entry.findingId,
              severity: entry.severity,
              file: entry.file,
              line: entry.line,
              title: entry.title,
              detail: entry.detail,
              carriedFrom: entry.origRound,
            })),
          ];
    const byId = <T extends { readonly findingId: string }>(list: ReadonlyArray<T> | undefined) =>
      new Map((list ?? []).map((item) => [item.findingId, item]));
    const dispositions = byId(triagePayload?.dispositions);
    const verdicts = byId(adjudicatePayload?.verdicts);
    const redispositions = byId(retriagePayload?.dispositions);
    const reverdicts = byId(readjudicatePayload?.verdicts);
    const findings: BoardReviewLoopFinding[] = rawFindings.map(({ carriedFrom, ...finding }) => {
      const disposition = dispositions.get(finding.id);
      const verdict = verdicts.get(finding.id);
      const redisposition = redispositions.get(finding.id);
      const reverdict = reverdicts.get(finding.id);
      return {
        finding,
        // The latest pass decides where the finding stands.
        resolution: boardReviewFindingResolution(
          redisposition ?? disposition,
          reverdict ?? verdict,
        ),
        disposition: disposition?.action ?? null,
        dispositionNote: disposition?.note ?? "",
        verdict: verdict?.verdict ?? null,
        verdictNote: verdict?.note ?? "",
        retriage: redisposition?.action ?? null,
        retriageNote: redisposition?.note ?? "",
        reverdict: reverdict?.verdict ?? null,
        reverdictNote: reverdict?.note ?? "",
        carriedFrom,
      };
    });

    const blocking = rawFindings.filter(
      (f) => f.carriedFrom !== null || isBoardReviewBlockingSeverity(f.severity),
    ).length;
    const completionOf = (phase: BoardReviewPhaseId | BoardReviewFollowUpPhase) =>
      phase === "review"
        ? review
        : phase === "triage"
          ? triage
          : phase === "adjudicate"
            ? adjudicate
            : phase === "retriage"
              ? retriage
              : readjudicate;
    const phaseStatus = (phase: BoardReviewPhaseId): BoardReviewPhaseStatus => {
      const completion = completionOf(phase);
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
    const phaseOf = (
      phase: BoardReviewPhaseId | BoardReviewFollowUpPhase,
      status: BoardReviewPhaseStatus,
    ): BoardReviewLoopPhase => {
      const completion = completionOf(phase);
      return {
        phase,
        status,
        threadId: completion?.threadId ?? null,
        completedAt: completion?.completedAt ?? null,
      };
    };
    // The follow-ups show only once they ran or are due: most rounds never
    // summon them.
    const followUps = (["retriage", "readjudicate"] as const).flatMap((phase) => {
      if (completionOf(phase) !== undefined) return [phaseOf(phase, "done")];
      if (next !== null && next.round === round && next.phase === phase) {
        return [phaseOf(phase, "running")];
      }
      return [];
    });
    const phases: BoardReviewLoopPhase[] = [
      ...BOARD_REVIEW_PHASE_IDS.map((phase) => phaseOf(phase, phaseStatus(phase))),
      ...followUps,
    ];

    const stamps = [review, triage, adjudicate, retriage, readjudicate]
      .filter((completion) => completion !== undefined)
      .map((completion) => completion.completedAt)
      .sort();
    const roundDone =
      review !== undefined && !reviewMalformed && (next === null || next.round !== round);
    const unreadablePhase =
      unreadable !== null && unreadable.round === round ? unreadable.phase : null;
    roundModels.push({
      round,
      outcome:
        unreadablePhase !== null
          ? "unreadable"
          : !roundDone
            ? "in-progress"
            : status === "stuck" && currentRound === round
              ? "stuck"
              : blocking > 0
                ? "changes-requested"
                : "clean",
      reviewMalformed,
      carriedRuling:
        carryEntry?.ruling === "fix" ? { fromRound: round - 1, note: carryEntry.note } : null,
      dismissals: boardReviewDismissals(carry.carriedFindings, round).map((dismissal) => ({
        findingId: dismissal.findingId,
        title: dismissal.title,
        round: dismissal.round - 1,
      })),
      unreadablePhase,
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
        escalated: findings.filter((f) => f.resolution === "escalated").length,
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
    unreadableStepId,
    stuckFindings: walk.stuckFindings ?? [],
    unreviewedFixes: walk.unreviewedFixes ?? 0,
    convergedBy: walk.convergedBy ?? null,
    totals: {
      raised: all.length,
      fixed: all.filter((f) => f.resolution === "fixed").length,
      rejected: all.filter((f) => f.resolution === "rejected").length,
      open: all.filter((f) => f.resolution === "open").length,
      disputed: all.filter((f) => f.resolution === "disputed").length,
      escalated: all.filter((f) => f.resolution === "escalated").length,
    },
  };
}

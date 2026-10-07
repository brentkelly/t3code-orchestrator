/**
 * The card modal's Summary pane (T3O-5): a derived recap of how the work
 * went — verdict, review, build, PR — from `board.subscribeCard` plus the
 * stage list. Not an LLM write-up, not a second Review pane.
 */
import {
  BOARD_SEED_STAGE_IDS,
  DEFAULT_BOARD_REVIEW_ROUNDS,
  boardCardDisplayPullRequest,
  boardStageById,
  boardStageWithRole,
  effectiveBoardStageRole,
  type BoardCard,
  type BoardCardDetail,
  type BoardCardPullRequestState,
  type BoardStageDefinition,
  type BoardStageId,
  type BoardState,
  type BoardStepCompletion,
} from "@t3tools/contracts";

import { deriveBoardReviewLoop, hasBoardReviewSteps } from "./boardReviewLoop";
import type { BoardPlanRows } from "./boardPlanRows";

export type BoardCardWorkSummaryTone = "success" | "info" | "attention" | "warning" | "muted";

export interface BoardCardWorkSummaryVerdict {
  readonly label: string;
  readonly tone: BoardCardWorkSummaryTone;
}

export interface BoardCardWorkSummaryOutstandingFinding {
  readonly id: string;
  readonly title: string;
}

export interface BoardCardWorkSummaryReview {
  readonly empty: boolean;
  readonly currentRound: number;
  readonly maxRounds: number;
  readonly severities: {
    readonly critical: number;
    readonly improvement: number;
    readonly nitpick: number;
  };
  readonly counts: {
    readonly raised: number;
    readonly fixed: number;
    readonly rejected: number;
    readonly open: number;
    readonly disputed: number;
  };
  readonly outstanding: ReadonlyArray<BoardCardWorkSummaryOutstandingFinding>;
}

export interface BoardCardWorkSummaryChild {
  readonly cardId: string | null;
  readonly key: string;
  readonly stageLabel: string;
  readonly done: boolean;
}

export interface BoardCardWorkSummaryBuild {
  readonly empty: boolean;
  readonly summary: string | null;
  readonly children: {
    readonly done: number;
    readonly total: number;
    readonly rows: ReadonlyArray<BoardCardWorkSummaryChild>;
  } | null;
}

export interface BoardCardWorkSummaryPullRequest {
  readonly empty: boolean;
  readonly number: number | null;
  readonly title: string | null;
  readonly url: string | null;
  readonly headBranch: string | null;
  readonly baseRef: string | null;
  readonly state: BoardCardPullRequestState | null;
}

export interface BoardCardWorkSummary {
  readonly verdict: BoardCardWorkSummaryVerdict;
  readonly review: BoardCardWorkSummaryReview;
  readonly build: BoardCardWorkSummaryBuild;
  readonly pullRequest: BoardCardWorkSummaryPullRequest;
}

const TONE_RANK: Record<BoardCardWorkSummaryTone, number> = {
  warning: 4,
  attention: 3,
  info: 2,
  success: 1,
  muted: 0,
};

const EMPTY_REVIEW: BoardCardWorkSummaryReview = {
  empty: true,
  currentRound: 0,
  maxRounds: DEFAULT_BOARD_REVIEW_ROUNDS,
  severities: { critical: 0, improvement: 0, nitpick: 0 },
  counts: { raised: 0, fixed: 0, rejected: 0, open: 0, disputed: 0 },
  outstanding: [],
};

function stageStateOf(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

function stageRoleOf(
  stages: ReadonlyArray<BoardStageDefinition>,
  stage: BoardStageId,
): ReturnType<typeof effectiveBoardStageRole> {
  const def = boardStageById(stageStateOf(stages), stage);
  return def === null ? null : effectiveBoardStageRole(def);
}

/** Whether the Summary pill exists: review/merge/done, or a keep-alive
    review ledger / linked pull request after the card was dragged back. */
export function boardCardHasSummaryPane(input: {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly stage: BoardStageId;
  readonly stepCompletions: ReadonlyArray<BoardStepCompletion>;
  readonly card: Pick<BoardCard, "pullRequest" | "pullRequestHistory">;
}): boolean {
  const role = stageRoleOf(input.stages, input.stage);
  if (role === "review" || role === "merge" || role === "done") return true;
  if (hasBoardReviewSteps(input.stepCompletions)) return true;
  return boardCardDisplayPullRequest(input.card) !== null;
}

function pickVerdict(
  candidates: ReadonlyArray<BoardCardWorkSummaryVerdict>,
): BoardCardWorkSummaryVerdict {
  let winner: BoardCardWorkSummaryVerdict = { label: "In progress", tone: "muted" };
  let rank = -1;
  for (const candidate of candidates) {
    const next = TONE_RANK[candidate.tone];
    if (next > rank) {
      winner = candidate;
      rank = next;
    }
  }
  return winner;
}

function deriveVerdict(input: {
  readonly role: ReturnType<typeof effectiveBoardStageRole>;
  readonly blocked: boolean;
  readonly mergeHeld: boolean;
  readonly review: BoardCardWorkSummaryReview;
  readonly loopStatus: ReturnType<typeof deriveBoardReviewLoop>["status"] | null;
  readonly prState: BoardCardPullRequestState | null;
  readonly prMissingAtMerge: boolean;
}): BoardCardWorkSummaryVerdict {
  const candidates: BoardCardWorkSummaryVerdict[] = [];
  if (input.blocked) candidates.push({ label: "Blocked", tone: "warning" });
  if (input.mergeHeld) candidates.push({ label: "Merge held", tone: "warning" });
  if (input.prMissingAtMerge) candidates.push({ label: "No pull request", tone: "warning" });

  if (input.loopStatus === "unreadable") {
    candidates.push({ label: "Review unreadable", tone: "warning" });
  } else if (input.loopStatus === "round-cap") {
    candidates.push({ label: "No convergence", tone: "warning" });
  } else if (input.loopStatus === "stopped") {
    candidates.push({ label: "Held for you", tone: "attention" });
  } else if (input.loopStatus === "running") {
    if (input.role === "review") {
      candidates.push({ label: "Review running", tone: "info" });
    } else {
      candidates.push({ label: "Review paused", tone: "muted" });
    }
  } else if (input.loopStatus === "converged") {
    candidates.push({ label: "Review settled", tone: "success" });
  } else if (input.role === "review" && input.review.empty) {
    candidates.push({ label: "Review not started", tone: "muted" });
  }

  if (input.prState === "merged") {
    candidates.push({ label: "Merged", tone: "success" });
  } else if (input.role === "done") {
    candidates.push({ label: "Done", tone: "success" });
  } else if (input.role === "merge" && input.prState === "open") {
    candidates.push({ label: "Ready for merge", tone: "attention" });
  }

  return pickVerdict(candidates);
}

function deriveReview(
  completions: ReadonlyArray<BoardStepCompletion>,
  maxRounds: number,
  stopAfterRound: number | null,
  runThroughRound: number | null,
): {
  readonly recap: BoardCardWorkSummaryReview;
  readonly status: ReturnType<typeof deriveBoardReviewLoop>["status"] | null;
} {
  if (!hasBoardReviewSteps(completions)) {
    return { recap: EMPTY_REVIEW, status: null };
  }
  const loop = deriveBoardReviewLoop(completions, maxRounds, stopAfterRound, runThroughRound);
  const current =
    loop.rounds.find((round) => round.round === loop.currentRound) ?? loop.rounds.at(-1) ?? null;
  const outstanding =
    current === null
      ? []
      : current.findings
          .filter((entry) => entry.resolution === "open" || entry.resolution === "disputed")
          .map((entry) => ({ id: entry.finding.id, title: entry.finding.title }));
  const severities = loop.rounds.reduce(
    (acc, round) => ({
      critical: acc.critical + round.severities.critical,
      improvement: acc.improvement + round.severities.improvement,
      nitpick: acc.nitpick + round.severities.nitpick,
    }),
    { critical: 0, improvement: 0, nitpick: 0 },
  );
  return {
    status: loop.status,
    recap: {
      empty: false,
      currentRound: loop.currentRound,
      maxRounds: loop.maxRounds,
      severities,
      counts: loop.totals,
      outstanding,
    },
  };
}

function buildCompletionOf(
  stages: ReadonlyArray<BoardStageDefinition>,
  completions: ReadonlyArray<BoardStepCompletion>,
): BoardStepCompletion | null {
  const buildId =
    boardStageWithRole(stageStateOf(stages), "build")?.stageId ?? BOARD_SEED_STAGE_IDS.building;
  return completions.find((completion) => completion.stepId === String(buildId)) ?? null;
}

function deriveBuild(input: {
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly completions: ReadonlyArray<BoardStepCompletion>;
  readonly planRows: BoardPlanRows | null;
}): BoardCardWorkSummaryBuild {
  const completion = buildCompletionOf(input.stages, input.completions);
  const summary = completion?.summary ?? null;
  const children =
    input.planRows === null
      ? null
      : {
          done: input.planRows.liveDone,
          total: input.planRows.liveTotal,
          rows: input.planRows.rows
            .filter((row) => row.state === "live" && row.key !== null)
            .map((row) => ({
              cardId: row.live?.cardId ?? null,
              key: row.key as string,
              stageLabel: row.stageLabel ?? "—",
              done: row.done,
            })),
        };
  const empty = summary === null && (children === null || children.total === 0);
  return { empty, summary, children };
}

function derivePullRequest(
  card: Pick<BoardCard, "pullRequest" | "pullRequestHistory">,
): BoardCardWorkSummaryPullRequest {
  const pr = boardCardDisplayPullRequest(card);
  if (pr === null) {
    return {
      empty: true,
      number: null,
      title: null,
      url: null,
      headBranch: null,
      baseRef: null,
      state: null,
    };
  }
  return {
    empty: false,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headBranch: pr.headBranch,
    baseRef: pr.baseRef,
    state: pr.state,
  };
}

export function deriveBoardCardWorkSummary(input: {
  readonly detail: BoardCardDetail;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly planRows?: BoardPlanRows | null;
  readonly maxRounds?: number;
}): BoardCardWorkSummary {
  const { card } = input.detail;
  const role = stageRoleOf(input.stages, card.stage);
  const maxRounds = input.maxRounds ?? DEFAULT_BOARD_REVIEW_ROUNDS;
  const { recap: review, status: loopStatus } = deriveReview(
    input.detail.stepCompletions,
    maxRounds,
    card.reviewOverrides?.stopAfterRound ?? null,
    card.reviewOverrides?.runThroughRound ?? null,
  );
  const pullRequest = derivePullRequest(card);
  const build = deriveBuild({
    stages: input.stages,
    completions: input.detail.stepCompletions,
    planRows: input.planRows ?? null,
  });
  const verdict = deriveVerdict({
    role,
    blocked: card.blocked,
    mergeHeld: card.autoMergeHold !== null,
    review,
    loopStatus,
    prState: pullRequest.state,
    prMissingAtMerge: role === "merge" && pullRequest.empty,
  });
  return { verdict, review, build, pullRequest };
}

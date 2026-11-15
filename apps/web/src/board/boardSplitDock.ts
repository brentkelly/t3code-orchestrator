/**
 * T3o: the proposed split dock above the thread composer (T3O-105), as data. Whether it is
 * open, how tall it is, and what its collapsed row, approval choice and status bar say are all
 * derived here from the card and the viewer's stored choice, so the component only draws.
 */
import {
  boardSplitApprovalModes,
  boardSplitFingerprint,
  type BoardPendingSplitApproval,
  type BoardPlan,
  type BoardStepStatus,
} from "@t3tools/contracts";

const BOARD_SPLIT_DOCK_MIN_HEIGHT = 120;
const BOARD_SPLIT_DOCK_MAX_FRACTION = 0.45;

/** One viewer's dock state for one card. A choice is tied to the review and the split it was
    made under; a newer review or a changed split falls back to the automatic rule. */
export interface BoardSplitDockStored {
  readonly userState: "expanded" | "collapsed" | null;
  readonly atReviewStartedAt: string | null;
  readonly atPlanSetKey: string | null;
  readonly height: number | null;
}

export const BOARD_SPLIT_DOCK_DEFAULT: BoardSplitDockStored = {
  userState: null,
  atReviewStartedAt: null,
  atPlanSetKey: null,
  height: null,
};

const storageKey = (cardId: string) => `t3o:board-split-dock:${cardId}`;

/** The stored state, or the default when storage is blocked, empty or holds junk. */
export function readBoardSplitDockStored(cardId: string): BoardSplitDockStored {
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(cardId));
    if (raw == null) return BOARD_SPLIT_DOCK_DEFAULT;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return BOARD_SPLIT_DOCK_DEFAULT;
    const value = parsed as Record<string, unknown>;
    const text = (field: unknown) => (typeof field === "string" ? field : null);
    return {
      userState:
        value.userState === "expanded" || value.userState === "collapsed" ? value.userState : null,
      atReviewStartedAt: text(value.atReviewStartedAt),
      atPlanSetKey: text(value.atPlanSetKey),
      height: typeof value.height === "number" && value.height > 0 ? value.height : null,
    };
  } catch {
    return BOARD_SPLIT_DOCK_DEFAULT;
  }
}

export function writeBoardSplitDockStored(cardId: string, stored: BoardSplitDockStored): void {
  try {
    globalThis.localStorage?.setItem(storageKey(cardId), JSON.stringify(stored));
  } catch {
    // A per-viewer convenience: without storage the dock still works for this visit.
  }
}

/** What the dock is drawn from. */
export interface BoardSplitDockInput {
  readonly plans: ReadonlyArray<
    Pick<BoardPlan, "planId" | "title" | "dependsOn" | "ordinal" | "planned" | "revisedInRound">
  >;
  /** The live plan step's review, when one has started. */
  readonly review: {
    readonly startedAt: string;
    readonly rounds: number;
    readonly round?: number | undefined;
    readonly doneAt?: string | undefined;
  } | null;
  /** The live plan step's status, or null when planning has settled. */
  readonly stepStatus: BoardStepStatus | null;
  readonly pendingApproval: BoardPendingSplitApproval | null;
  /** The latest drop or refusal of an approval, when nothing was approved or undone since. */
  readonly approvalLost: BoardSplitApprovalLost | null;
}

export interface BoardSplitApprovalLost {
  readonly change: "dropped" | "refused";
  readonly round: number | null;
  readonly detail: string | null;
}

function boardSplitDockReviewRunning(input: Pick<BoardSplitDockInput, "review" | "stepStatus">) {
  return input.review !== null && input.review.doneAt === undefined && input.stepStatus !== null;
}

/** The key the viewer's choice is tied to. */
function boardSplitDockPlanSetKey(plans: BoardSplitDockInput["plans"]): string {
  return boardSplitFingerprint(plans);
}

/** Open or collapsed: the viewer's choice under this review and split, else collapsed while a
    review runs and open otherwise. A lost approval reopens it, since it needs the human. */
export function boardSplitDockExpanded(input: BoardSplitDockInput, stored: BoardSplitDockStored) {
  const current =
    stored.userState !== null &&
    stored.atReviewStartedAt === (input.review?.startedAt ?? null) &&
    stored.atPlanSetKey === boardSplitDockPlanSetKey(input.plans);
  if (current) return stored.userState === "expanded";
  return !boardSplitDockReviewRunning(input) || input.approvalLost !== null;
}

/** The stored state after the viewer opens or collapses the dock. */
export function boardSplitDockChoice(
  input: BoardSplitDockInput,
  stored: BoardSplitDockStored,
  expanded: boolean,
): BoardSplitDockStored {
  return {
    ...stored,
    userState: expanded ? "expanded" : "collapsed",
    atReviewStartedAt: input.review?.startedAt ?? null,
    atPlanSetKey: boardSplitDockPlanSetKey(input.plans),
  };
}

/** The expanded dock's height bounds: 120px up to 45% of the thread column. A stored height
    is clamped into them; without one the dock is as tall as its content, up to the cap. */
export function boardSplitDockHeight(input: {
  readonly stored: number | null;
  readonly columnHeight: number | null;
}): { readonly height: number | null; readonly max: number | null } {
  if (input.columnHeight === null) return { height: null, max: null };
  const max = Math.max(
    BOARD_SPLIT_DOCK_MIN_HEIGHT,
    Math.floor(input.columnHeight * BOARD_SPLIT_DOCK_MAX_FRACTION),
  );
  return {
    height:
      input.stored === null
        ? null
        : Math.min(max, Math.max(BOARD_SPLIT_DOCK_MIN_HEIGHT, Math.round(input.stored))),
    max,
  };
}

const cards = (count: number) => (count === 1 ? "1 card" : `${count} cards`);

/** How the human may approve now: the approval modes, worded. */
export type BoardSplitDockFooter =
  /** No review running: the single Approve split. */
  | { readonly kind: "direct" }
  /** Approve split… opens an inline choice. */
  | {
      readonly kind: "choice";
      readonly lead: string;
      readonly afterReview: { readonly label: string; readonly note: string };
      /** Offered only while planning is parked. */
      readonly now: { readonly label: string; readonly note: string } | null;
    };

export function boardSplitDockFooter(input: BoardSplitDockInput): BoardSplitDockFooter {
  const modes = boardSplitApprovalModes(
    input.stepStatus === null
      ? null
      : {
          status: input.stepStatus,
          ...(input.review === null ? {} : { planReviewStartedAt: input.review.startedAt }),
          ...(input.review?.doneAt === undefined ? {} : { planReviewDoneAt: input.review.doneAt }),
        },
  );
  if (!modes.afterReview) return { kind: "direct" };
  const count = cards(input.plans.length);
  const reviewing = boardSplitDockReviewRunning(input);
  const review = input.review;
  return {
    kind: "choice",
    lead:
      reviewing && review !== null
        ? `Plan review · round ${review.round ?? 1} of ${review.rounds}. Later rounds can still change the cards.`
        : "Planning is paused. Approve now, or when planning completes.",
    afterReview: {
      label: reviewing ? "Approve after review" : "Approve when planning completes",
      note:
        reviewing && review !== null
          ? `Approved now. The ${count} are created from the final plans when the review finishes (target: ${review.rounds} ${review.rounds === 1 ? "round" : "rounds"}).`
          : `Approved now. The ${count} are created when the planning step completes.`,
    },
    now: modes.now
      ? {
          label: "Approve now",
          note: reviewing ? "Ends the review: the plans freeze now." : `Creates the ${count} now.`,
        }
      : null,
  };
}

/** The collapsed row: "Proposed split · 7 cards · 2 revised · Needs approval". */
export function boardSplitDockSummary(input: Pick<BoardSplitDockInput, "plans">): string {
  const revised = input.plans.filter((plan) => plan.revisedInRound !== undefined).length;
  return [
    "Proposed split",
    cards(input.plans.length),
    ...(revised === 0 ? [] : [`${revised} revised`]),
    "Needs approval",
  ].join(" · ");
}

/** The green bar of a split approved to take effect later. */
export function boardSplitDockApprovedBar(input: BoardSplitDockInput): string | null {
  if (input.pendingApproval === null) return null;
  if (!boardSplitDockReviewRunning(input)) {
    return "Split approved · cards are created when planning completes";
  }
  const round = input.review?.round;
  return `Split approved · ${cards(input.plans.length)} created after review${
    round === undefined ? "" : ` · round ${round} now`
  }`;
}

/** The violet line of an approval the board dropped or could not apply. */
export function boardSplitDockLostNote(lost: BoardSplitApprovalLost | null): string | null {
  if (lost === null) return null;
  if (lost.change === "dropped") {
    return lost.round === null
      ? "Split changed, approve again"
      : `Split changed in round ${lost.round}, approve again`;
  }
  return `The approval could not be applied${lost.detail === null ? "" : `: ${lost.detail}`}. Approve again.`;
}

/** The latest approval change on the rail, when it was a drop or a refusal. */
export function boardSplitApprovalLostFromActivity(
  activity: ReadonlyArray<{
    readonly kind: string;
    readonly payload: {
      readonly splitApproval?: "approved" | "undone" | "dropped" | "refused" | undefined;
      readonly planReviewRound?: number | undefined;
      readonly detail?: string | undefined;
    };
  }>,
): BoardSplitApprovalLost | null {
  let latest: (typeof activity)[number] | null = null;
  for (const entry of activity) {
    if (entry.kind === "split-approval" || entry.kind === "card-moved") latest = entry;
  }
  const change = latest?.payload.splitApproval;
  if (latest === null || (change !== "dropped" && change !== "refused")) return null;
  return {
    change,
    round: latest.payload.planReviewRound ?? null,
    detail: latest.payload.detail ?? null,
  };
}

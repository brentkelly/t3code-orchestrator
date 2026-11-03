/**
 * The decision log's view (T3O-32): the card's planning decisions in reading
 * order, the header's count and flag summary, and whether the section opens by
 * default. Pure, so the Summary pane only draws it.
 */
import {
  sortBoardCardDecisions,
  type BoardCardDecision,
  type BoardCardDecisionFlag,
} from "@t3tools/contracts";

export type BoardDecisionLogRow = {
  readonly id: string;
  readonly question: string;
  readonly decision: string;
  readonly reason: string;
  readonly who: "Agent" | "You";
  readonly flag: BoardCardDecisionFlag;
};

export type BoardDecisionLogView = {
  readonly rows: ReadonlyArray<BoardDecisionLogRow>;
  /** "3 decisions". */
  readonly count: string;
  /** "1 unclear · 2 important", or null when nothing is flagged. */
  readonly flags: string | null;
  readonly autoPlanned: boolean;
  /** Open on first sight: an auto-planned card with unclear decisions, which
      a human has not yet reviewed. */
  readonly defaultOpen: boolean;
  /** Offer Send back to build and Create follow-up card. */
  readonly canAct: boolean;
};

export function boardDecisionLogView(input: {
  readonly decisions: ReadonlyArray<BoardCardDecision>;
  readonly autoPlanned: boolean;
  /** The card is past the build-role stage. */
  readonly pastBuild: boolean;
}): BoardDecisionLogView | null {
  if (input.decisions.length === 0) return null;
  const sorted = sortBoardCardDecisions(input.decisions);
  const unclear = sorted.filter((entry) => entry.flag === "unclear").length;
  const important = sorted.filter((entry) => entry.flag === "important").length;
  const flags = [
    unclear > 0 ? `${unclear} unclear` : null,
    important > 0 ? `${important} important` : null,
  ].filter((part) => part !== null);
  return {
    rows: sorted.map((entry) => ({
      id: entry.decisionId,
      question: entry.question,
      decision: entry.decision,
      reason: entry.reason,
      who: entry.decidedBy === "human" ? "You" : "Agent",
      flag: entry.flag,
    })),
    count: `${sorted.length} ${sorted.length === 1 ? "decision" : "decisions"}`,
    flags: flags.length === 0 ? null : flags.join(" · "),
    autoPlanned: input.autoPlanned,
    defaultOpen: input.autoPlanned && unclear > 0,
    canAct: input.autoPlanned && input.pastBuild,
  };
}

/** A follow-up card for the first decision that most needs a second look. */
export function boardDecisionFollowUp(input: {
  readonly cardKey: string;
  readonly rows: ReadonlyArray<BoardDecisionLogRow>;
}): { readonly title: string; readonly brief: string } | null {
  const first = input.rows[0];
  if (first === undefined) return null;
  const topic = first.question.replace(/\?$/, "");
  return {
    title: `Follow-up to ${input.cardKey}: ${topic}`.slice(0, 200),
    brief: `${input.cardKey} decided "${first.decision}" (${first.reason}). Revisit it.`,
  };
}

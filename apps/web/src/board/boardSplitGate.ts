/**
 * The split gate's view (T3O-31): what each proposed child is, where it lands,
 * and how the human's settings compare with the agent's recommendation.
 * Pure, so the gate component only draws it.
 */
import {
  isBoardPlanPlanned,
  type BoardCardGroupTarget,
  type BoardPlan,
  type BoardSplitRecommendation,
} from "@t3tools/contracts";

export type BoardSplitGateSettings = {
  readonly autoBuild: boolean;
  readonly mergeTarget: BoardCardGroupTarget;
};

export type BoardSplitGateRow = {
  readonly planId: string;
  readonly number: string;
  readonly title: string;
  /** "after #1, #3", or null without dependencies. */
  readonly after: string | null;
  readonly planned: boolean;
  readonly lands: string;
};

export type BoardSplitGateView = {
  readonly count: string;
  readonly mix: string;
  readonly rows: ReadonlyArray<BoardSplitGateRow>;
  readonly autoBuildNote: string;
  /** Where the children merge, e.g. "board/t3-190 → main". */
  readonly resolved: string;
  readonly edited: boolean;
  readonly foot: string;
};

function describe(settings: BoardSplitGateSettings): string {
  return `auto-build ${settings.autoBuild ? "on" : "off"}, ${
    settings.mergeTarget === "own" ? "own branch" : "inherit"
  }`;
}

export function boardSplitGateView(input: {
  readonly plans: ReadonlyArray<Pick<BoardPlan, "planId" | "title" | "dependsOn" | "planned">>;
  readonly recommendation: BoardSplitRecommendation;
  readonly settings: BoardSplitGateSettings;
  /** The group's own integration branch, used when it merges to its own. */
  readonly ownBranch: string;
  /** Where this card itself merges. */
  readonly landsOn: string;
  readonly readyLabel: string;
  readonly backlogLabel: string;
}): BoardSplitGateView {
  const numberById = new Map(input.plans.map((plan, index) => [plan.planId, index + 1]));
  const rows = input.plans.map((plan, index) => {
    const planned = isBoardPlanPlanned(plan);
    const after = plan.dependsOn.flatMap((id) => {
      const number = numberById.get(id);
      return number === undefined ? [] : [`#${number}`];
    });
    return {
      planId: plan.planId,
      number: `#${index + 1}`,
      title: plan.title,
      after: after.length === 0 ? null : `after ${after.join(", ")}`,
      planned,
      lands: `→ ${planned ? input.readyLabel : input.backlogLabel}`,
    };
  });
  const total = rows.length;
  const planned = rows.filter((row) => row.planned).length;
  const { settings, recommendation } = input;
  const edited =
    settings.autoBuild !== recommendation.autoBuild ||
    settings.mergeTarget !== recommendation.mergeTarget;
  return {
    count: `${total} cards`,
    mix:
      planned === total
        ? "all planned"
        : planned === 0
          ? "all need planning"
          : `${planned} planned, ${total - planned} need planning`,
    rows,
    autoBuildNote: settings.autoBuild
      ? "Once started, ready children build, review and merge on their own."
      : "You start each child yourself.",
    resolved:
      settings.mergeTarget === "own"
        ? `${input.ownBranch} → ${input.landsOn}`
        : `→ ${input.landsOn}`,
    edited,
    foot: `${
      edited
        ? `Changed from the agent's recommendation (${describe(recommendation)}).`
        : `Agent recommends ${describe(recommendation)}.`
    } Approving creates the cards. Nothing starts until you start it.`,
  };
}

/** What Ask for changes puts in the planning thread's composer. */
export const BOARD_SPLIT_CHANGE_REQUEST_PREFILL = "Change the split: ";

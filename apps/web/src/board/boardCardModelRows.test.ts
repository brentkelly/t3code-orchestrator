/**
 * The card model-override rows. What matters most is what a row says it
 * inherits, since "nothing set" can mean different fallbacks.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type BoardCardModelOverrides,
  type BoardSettings,
  type BoardStageDefinition,
} from "@t3tools/contracts";

import {
  boardCardModelOverrideSummary,
  boardCardModelRows,
  boardReviewRoundInheritedModel,
  hasBoardCardModelOverride,
} from "./boardCardModelRows";

const boardSettings: BoardSettings = DEFAULT_SERVER_SETTINGS.board;
const planning = BOARD_SEED_STAGE_IDS.planning;
const build = BOARD_SEED_STAGE_IDS.building;
const review = BOARD_SEED_STAGE_IDS.review;

const opus = { instanceId: ProviderInstanceId.make("anthropic"), model: "claude-opus-5" };
const haiku = { instanceId: ProviderInstanceId.make("anthropic"), model: "claude-haiku-4-5" };

const rows = (
  parentCard: {
    readonly key: string;
    readonly modelOverrides: BoardCardModelOverrides;
  } | null = null,
  stages: ReadonlyArray<BoardStageDefinition> = BOARD_SEED_STAGES,
) => boardCardModelRows({ stages, boardSettings, parentCard });

/** One stage's row — looked up by stage id so a test reads the row it means,
    not whatever happens to sit at an index. */
const rowFor = (stageId: string, parentCard: Parameters<typeof rows>[0] = null) =>
  rows(parentCard).find((row) => row.stageId === stageId);

describe("boardCardModelRows (t3o-29, D1)", () => {
  it("offers exactly the plan-, build- and review-role rows, in pipeline order", () => {
    expect(rows().map((row) => [row.stageId, row.label])).toEqual([
      [planning, "Planning"],
      [build, "Build"],
      [review, "Review"],
    ]);
  });

  it("omits a row whose role-holder stage the board no longer has", () => {
    // Better one row than an override nothing would ever read.
    const withoutReview = BOARD_SEED_STAGES.filter((stage) => stage.stageId !== review);
    expect(rows(null, withoutReview).map((row) => row.label)).toEqual(["Planning", "Build"]);
  });

  it("reports the workspace value as the inherited one for a top-level card", () => {
    for (const row of rows()) {
      expect(row.inheritedFromCardKey).toBeNull();
    }
  });

  it("AC5: a child names the PARENT as the source of what it inherits", () => {
    // The trap this closes: without it the child's row would read "(default)"
    // and name the workspace model, while the card actually ran on its
    // parent's — the user sees one model and gets another.
    const buildRow = rowFor(build, { key: "T3O-41", modelOverrides: { [build]: opus } });
    expect(buildRow?.inheritedModel).toEqual(opus);
    expect(buildRow?.inheritedFromCardKey).toBe("T3O-41");
  });

  it("AC5: a child inherits the parent's Planning override, named as the parent's (#119)", () => {
    const planningRow = rowFor(planning, { key: "T3O-41", modelOverrides: { [planning]: opus } });
    expect(planningRow?.inheritedModel).toEqual(opus);
    expect(planningRow?.inheritedFromCardKey).toBe("T3O-41");
  });

  it("reports the workspace Planning access level when nothing overrides it (#119)", () => {
    // Planning is a plan-mode stage, so it resolves to approval-required.
    expect(rowFor(planning)?.inheritedRuntimeMode).toBe("approval-required");
  });

  it("AC5: inheritance is per stage — a parent's Build override leaves Review alone", () => {
    const parent = { key: "T3O-41", modelOverrides: { [build]: opus } };
    expect(rowFor(review, parent)?.inheritedFromCardKey).toBeNull();
    expect(rowFor(planning, parent)?.inheritedFromCardKey).toBeNull();
  });

  it("carries the parent's access level as the inherited one when it names one", () => {
    const buildRow = rowFor(build, {
      key: "T3O-41",
      modelOverrides: { [build]: { ...opus, runtimeMode: "approval-required" } },
    });
    expect(buildRow?.inheritedRuntimeMode).toBe("approval-required");
  });

  it("falls back to the workspace access level when the parent names none", () => {
    const buildRow = rowFor(build, { key: "T3O-41", modelOverrides: { [build]: opus } });
    // The build stage resolves to `auto` by default.
    expect(buildRow?.inheritedRuntimeMode).toBe("auto");
  });
});

describe("the review row's later-rounds model (T3O-94)", () => {
  const reviewExec = boardSettings.pipeline[review];
  if (reviewExec?.kind !== "review") throw new Error("expected the review member");
  const tiered: BoardSettings = {
    ...boardSettings,
    pipeline: {
      ...boardSettings.pipeline,
      [review]: {
        ...reviewExec,
        laterReviewModel: { afterRound: 2, model: haiku },
        phases: { ...reviewExec.phases, review: { ...reviewExec.phases.review, model: opus } },
      },
    },
  };
  const reviewRow = (parentCard: Parameters<typeof rows>[0] = null) =>
    boardCardModelRows({ stages: BOARD_SEED_STAGES, boardSettings: tiered, parentCard }).find(
      (row) => row.stageId === review,
    );

  it("names the early model as inherited and carries the later one", () => {
    const row = reviewRow();
    expect(row?.inheritedModel).toEqual(opus);
    expect(row?.laterRounds).toEqual({ afterRound: 2, model: haiku });
  });

  it("keeps the later model beside a parent's override, which replaces both tiers", () => {
    const row = reviewRow({ key: "T3O-41", modelOverrides: { [review]: haiku } });
    expect(row?.inheritedModel).toEqual(haiku);
    expect(row?.inheritedFromCardKey).toBe("T3O-41");
    expect(row?.laterRounds).not.toBeNull();
  });

  it("names the model and source a round without its own override runs on", () => {
    const row = reviewRow()!;
    const at = (round: number, cardOverride: typeof haiku | null = null) =>
      boardReviewRoundInheritedModel({ row, cardOverride, round });
    expect(at(2)).toEqual({ model: opus, source: "stage" });
    expect(at(3)).toEqual({ model: haiku, source: "later" });
    expect(at(3, opus)).toEqual({ model: opus, source: "card" });
    const childRow = reviewRow({ key: "T3O-41", modelOverrides: { [review]: opus } })!;
    expect(boardReviewRoundInheritedModel({ row: childRow, cardOverride: null, round: 5 })).toEqual(
      { model: opus, source: "parent" },
    );
  });

  it("is null off the review row and when Settings leaves it off", () => {
    expect(rowFor(review)?.laterRounds).toBeNull();
    expect(
      boardCardModelRows({ stages: BOARD_SEED_STAGES, boardSettings: tiered, parentCard: null })
        .filter((row) => row.stageId !== review)
        .map((row) => row.laterRounds),
    ).toEqual([null, null]);
  });
});

describe("boardCardModelOverrideSummary / hasBoardCardModelOverride (AC9)", () => {
  const spec = rows();

  it("reads Default when the card overrides nothing", () => {
    expect(boardCardModelOverrideSummary(spec, null)).toBe("Default");
    expect(boardCardModelOverrideSummary(spec, {})).toBe("Default");
    expect(hasBoardCardModelOverride(spec, null)).toBe(false);
  });

  it("names the overridden rows, in row order", () => {
    expect(boardCardModelOverrideSummary(spec, { [build]: opus })).toBe("Build");
    expect(boardCardModelOverrideSummary(spec, { [review]: opus })).toBe("Review");
    expect(boardCardModelOverrideSummary(spec, { [build]: opus, [review]: haiku })).toBe(
      "Build · Review",
    );
    expect(hasBoardCardModelOverride(spec, { [build]: opus })).toBe(true);
  });

  it("names a Planning override, alone or alongside the others (#119)", () => {
    expect(boardCardModelOverrideSummary(spec, { [planning]: opus })).toBe("Planning");
    expect(boardCardModelOverrideSummary(spec, { [build]: haiku, [planning]: opus })).toBe(
      "Planning · Build",
    );
    expect(
      boardCardModelOverrideSummary(spec, { [planning]: opus, [build]: opus, [review]: haiku }),
    ).toBe("Planning · Build · Review");
    expect(hasBoardCardModelOverride(spec, { [planning]: opus })).toBe(true);
  });

  it("counts only the card's OWN overrides, never an inherited one", () => {
    // A child running its parent's model has set nothing: the pill must not
    // claim it did, or "Reset" would appear with nothing to reset.
    const childRows = rows({ key: "T3O-41", modelOverrides: { [build]: opus } });
    expect(boardCardModelOverrideSummary(childRows, null)).toBe("Default");
    expect(hasBoardCardModelOverride(childRows, null)).toBe(false);
  });
});

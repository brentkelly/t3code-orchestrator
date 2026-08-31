/**
 * The card model-override rows (t3o-29, D1/D5). Pure over stages + workspace
 * settings + the parent card, so the whole inheritance story is testable
 * without rendering a popover or standing up a provider list.
 *
 * The assertions that matter most are the ones about what a row SAYS it is
 * inheriting: once a card can inherit from a parent, "nothing set" is three
 * different situations, and a row that renders them identically leaves the user
 * unable to tell which model their card will actually run on.
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
  hasBoardCardModelOverride,
} from "./boardCardModelRows";

const boardSettings: BoardSettings = DEFAULT_SERVER_SETTINGS.board;
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

describe("boardCardModelRows (t3o-29, D1)", () => {
  it("offers exactly the build- and review-role rows, in that order", () => {
    expect(rows().map((row) => [row.stageId, row.label])).toEqual([
      [build, "Build"],
      [review, "Review"],
    ]);
  });

  it("omits a row whose role-holder stage the board no longer has", () => {
    // Better one row than an override nothing would ever read.
    const withoutReview = BOARD_SEED_STAGES.filter((stage) => stage.stageId !== review);
    expect(rows(null, withoutReview).map((row) => row.label)).toEqual(["Build"]);
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
    const [buildRow] = rows({ key: "T3O-41", modelOverrides: { [build]: opus } });
    expect(buildRow?.inheritedModel).toEqual(opus);
    expect(buildRow?.inheritedFromCardKey).toBe("T3O-41");
  });

  it("AC5: inheritance is per stage — a parent's Build override leaves Review alone", () => {
    const [, reviewRow] = rows({ key: "T3O-41", modelOverrides: { [build]: opus } });
    expect(reviewRow?.inheritedFromCardKey).toBeNull();
  });

  it("carries the parent's access level as the inherited one when it names one", () => {
    const [buildRow] = rows({
      key: "T3O-41",
      modelOverrides: { [build]: { ...opus, runtimeMode: "approval-required" } },
    });
    expect(buildRow?.inheritedRuntimeMode).toBe("approval-required");
  });

  it("falls back to the workspace access level when the parent names none", () => {
    const [buildRow] = rows({ key: "T3O-41", modelOverrides: { [build]: opus } });
    // The build stage resolves to `auto` by default (t3o-21, D2).
    expect(buildRow?.inheritedRuntimeMode).toBe("auto");
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

  it("counts only the card's OWN overrides, never an inherited one", () => {
    // A child running its parent's model has set nothing: the pill must not
    // claim it did, or "Reset" would appear with nothing to reset.
    const childRows = rows({ key: "T3O-41", modelOverrides: { [build]: opus } });
    expect(boardCardModelOverrideSummary(childRows, null)).toBe("Default");
    expect(hasBoardCardModelOverride(childRows, null)).toBe(false);
  });
});

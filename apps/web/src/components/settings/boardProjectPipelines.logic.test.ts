/**
 * T3o: Settings → Board's Project pipelines rows (T3O-43).
 */
import {
  BOARD_SEED_STAGES,
  DEFAULT_BOARD_SETTINGS,
  ProjectId,
  resolveT3oProjectFile,
  type BoardStageView,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardProjectPipelineSummary,
  formatBoardSettingValue,
} from "./boardProjectPipelines.logic";

const projectId = ProjectId.make("web");
const NOW = "2026-01-01T00:00:00.000Z";

function viewFor(raw: unknown): BoardStageView {
  const base = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };
  const resolved = resolveT3oProjectFile({
    raw,
    board: base,
    projectId,
    source: { path: "/repo/web/t3o.json", commitSha: "0123456789abcdef" },
    now: NOW,
  });
  return {
    stages: [...BOARD_SEED_STAGES, ...resolved.stages],
    projectStageConfigs: { [projectId]: resolved.config },
    cards: [],
  };
}

describe("boardProjectPipelineSummary", () => {
  it("follows the global pipeline with no file", () => {
    const summary = boardProjectPipelineSummary({
      view: { stages: BOARD_SEED_STAGES, cards: [] },
      projectId,
      settings: DEFAULT_BOARD_SETTINGS,
    });
    expect(summary.followsGlobal).toBe(true);
    expect(summary.chips).toEqual([]);
  });

  it("summarises additions, removals, overrides and ignored entries", () => {
    const summary = boardProjectPipelineSummary({
      view: viewFor({
        stages: {
          remove: ["sprint", "review"],
          add: [{ id: "qa", label: "QA", after: "building" }],
          settings: {
            review: { rounds: 7, phases: { triage: { prompt: "Targeted tests" } } },
            building: { prompt: "Build it" },
          },
        },
      }),
      projectId,
      settings: DEFAULT_BOARD_SETTINGS,
    });
    expect(summary.followsGlobal).toBe(false);
    expect(summary.chips).toEqual(["+1 stage", "−1 stage", "3 overrides", "1 ignored entry"]);
    expect(
      summary.sequence.map((step) => `${step.label}${step.change ? `(${step.change})` : ""}`),
    ).toEqual([
      "Backlog",
      "Sprint(removed)",
      "Planning",
      "Ready",
      "Building",
      "QA(added)",
      "Code review",
      "Ready for merge",
      "Done",
    ]);
    expect(summary.overrides).toEqual(
      expect.arrayContaining([
        { stageLabel: "Code review", field: "rounds", projectValue: "7", globalValue: "5" },
        expect.objectContaining({
          stageLabel: "Code review",
          field: "phases.triage.prompt",
          projectValue: "Targeted tests",
        }),
        expect.objectContaining({
          stageLabel: "Building",
          field: "prompt",
          projectValue: "Build it",
        }),
      ]),
    );
    expect(summary.commitSha).toBe("0123456789abcdef");
    expect(summary.path).toBe("/repo/web/t3o.json");
  });
});

describe("boardProjectPipelineSummary CI (T3O-44)", () => {
  const ciFile = (enabled?: boolean) => ({
    stages: {
      settings: {
        ci: {
          ...(enabled === undefined ? {} : { enabled }),
          maxFixAttempts: 3,
          steps: [{ name: "Check", command: "cargo xtask check", timeoutMinutes: 30 }],
        },
      },
    },
  });

  it("chips the step count, lists CI in the sequence and keeps the fix cap as an override", () => {
    const summary = boardProjectPipelineSummary({
      view: viewFor(ciFile()),
      projectId,
      settings: DEFAULT_BOARD_SETTINGS,
    });
    expect(summary.chips).toEqual(["CI · 1 step", "1 override"]);
    expect(summary.ci).toEqual({
      active: true,
      steps: [{ name: "Check", command: "cargo xtask check", timeoutMinutes: 30 }],
    });
    expect(summary.sequence.map((step) => step.label)).toContain("Continuous integration");
    expect(summary.overrides).toEqual([
      {
        stageLabel: "Continuous integration",
        field: "maxFixAttempts",
        projectValue: "3",
        globalValue: "2",
      },
    ]);
  });

  it("says when CI is paused, and leaves it out of the sequence", () => {
    const summary = boardProjectPipelineSummary({
      view: viewFor(ciFile(false)),
      projectId,
      settings: DEFAULT_BOARD_SETTINGS,
    });
    expect(summary.chips[0]).toBe("CI · 1 step · paused");
    expect(summary.ci?.active).toBe(false);
    expect(summary.sequence.map((step) => step.label)).not.toContain("Continuous integration");
  });
});

describe("formatBoardSettingValue", () => {
  it("keeps a cell to one short line", () => {
    expect(formatBoardSettingValue("a\n  b")).toBe("a b");
    expect(formatBoardSettingValue("x".repeat(100))).toHaveLength(80);
    expect(formatBoardSettingValue(null)).toBe("default");
    expect(formatBoardSettingValue(true)).toBe("true");
  });
});

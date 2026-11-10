/**
 * The Continuous integration stage's contracts (T3O-44/57): the seed stage and
 * seed-only detection, when CI is active for a project, how the CI member
 * resolves, the human move rules around CI, and a failed pass's fix issues.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BOARD_CI_MAX_FIX_ISSUES,
  DEFAULT_BOARD_CI_FIX_PROMPT,
  DEFAULT_BOARD_SETTINGS,
  EMPTY_BOARD_STATE,
  ProjectId,
  areBoardStagesAdjacent,
  boardCardMoveRefusal,
  boardCiFixIssueOutcomes,
  boardCiFixIssues,
  boardProjectConfigDifferenceCount,
  decodeBoardCiFixPayload,
  boardNextStageId,
  boardProjectStagesInOrder,
  boardStagesAreSeedOnly,
  isBoardCiActive,
  isBoardCiStageExecution,
  resolveBoardStageExecution,
  withBoardProjectConfigVersion,
  type BoardCard,
  type BoardStageId,
  type BoardState,
} from "./index.ts";
import { resolveT3oProjectFile } from "./t3oProjectFile.ts";
import { composeBoardReviewPhasePrompt } from "./boardEnvelope.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const withCi = ProjectId.make("project-ci");
const withoutCi = ProjectId.make("project-plain");
const { ci, review, merge, done, building, ready } = BOARD_SEED_STAGE_IDS;

const STEPS = [
  { name: "Lint", command: "vp lint" },
  { name: "Test", command: "vp test run", timeoutMinutes: 10 },
];

const resolveFile = (raw: unknown, projectId = withCi) =>
  resolveT3oProjectFile({ raw, board: EMPTY_BOARD_STATE, projectId, now: NOW });

const configFrom = (raw: unknown) =>
  withBoardProjectConfigVersion({
    ...resolveFile(raw).delta,
    dismissedImportSha: null,
    lastChangedBy: null,
  });

const boardWith = (
  raw: unknown,
  cards: ReadonlyArray<Pick<BoardCard, "stage" | "projectId">> = [],
): BoardState => ({
  ...EMPTY_BOARD_STATE,
  cards: cards.map((card, index) => ({
    ...card,
    id: BoardCardId.make(`card-${index}`),
    archivedAt: null,
  })) as unknown as ReadonlyArray<BoardCard>,
  projectStageConfigs: { [withCi]: configFrom(raw) },
});

const ciFile = { stages: { settings: { ci: { steps: STEPS } } } };

const pipeline = (board: BoardState, projectId: ProjectId | null) =>
  boardProjectStagesInOrder(board, projectId).map((stage) =>
    stage.retired ? `${stage.stageId}(retired)` : String(stage.stageId),
  );

describe("CI seed stage", () => {
  it("sits between Code review and Ready for merge", () => {
    const ids = BOARD_SEED_STAGES.map((stage) => String(stage.stageId));
    expect(ids.indexOf("ci")).toBe(ids.indexOf("review") + 1);
    expect(ids.indexOf("merge")).toBe(ids.indexOf("ci") + 1);
    const seed = BOARD_SEED_STAGES.find((stage) => stage.stageId === ci)!;
    expect(seed).toMatchObject({ label: "Continuous integration", role: null, orderKey: "m" });
  });

  it("counts both the nine-stage and the pre-CI eight-stage tables as untouched", () => {
    expect(boardStagesAreSeedOnly(BOARD_SEED_STAGES)).toBe(true);
    expect(boardStagesAreSeedOnly(BOARD_SEED_STAGES.filter((stage) => stage.stageId !== ci))).toBe(
      true,
    );
    expect(
      boardStagesAreSeedOnly(
        BOARD_SEED_STAGES.map((stage) =>
          stage.stageId === ci ? { ...stage, label: "Checks" } : stage,
        ),
      ),
    ).toBe(false);
    expect(
      boardStagesAreSeedOnly(BOARD_SEED_STAGES.filter((stage) => stage.stageId !== done)),
    ).toBe(false);
  });
});

describe("CI activeness", () => {
  it("is on only for a project switched on with at least one step", () => {
    const board = boardWith(ciFile);
    expect(isBoardCiActive(board, withCi)).toBe(true);
    expect(isBoardCiActive(board, withoutCi)).toBe(false);
    expect(isBoardCiActive(board, null)).toBe(false);
    expect(configFrom(ciFile).stageSwitches).toEqual({ ci: true });
    expect(configFrom(ciFile).ci.steps).toEqual([
      {
        kind: "script",
        id: "legacy-0",
        name: "Lint",
        parallel: false,
        command: "vp lint",
        timeoutMinutes: 30,
      },
      {
        kind: "script",
        id: "legacy-1",
        name: "Test",
        parallel: false,
        command: "vp test run",
        timeoutMinutes: 10,
      },
    ]);
  });

  it("stays out of the pipeline when switched on with no steps", () => {
    const board: BoardState = {
      ...EMPTY_BOARD_STATE,
      projectStageConfigs: {
        [withCi]: withBoardProjectConfigVersion({
          stageSwitches: { ci: true },
          overrides: {},
          ci: { steps: [] },
          dismissedImportSha: null,
          warnings: [],
          lastChangedBy: null,
        }),
      },
    };
    expect(isBoardCiActive(board, withCi)).toBe(false);
    expect(pipeline(board, withCi)).not.toContain("ci");
  });

  it("puts CI in the pipeline only while active", () => {
    const board = boardWith(ciFile);
    expect(pipeline(board, withCi)).toContain("ci");
    expect(pipeline(board, withoutCi)).not.toContain("ci");
    expect(pipeline(board, null)).not.toContain("ci");
    expect(boardNextStageId(board, review, withCi)).toBe(ci);
    expect(boardNextStageId(board, ci, withCi)).toBe(merge);
    expect(boardNextStageId(board, review, withoutCi)).toBe(merge);
    expect(areBoardStagesAdjacent(board, review, merge, withoutCi)).toBe(true);
    expect(areBoardStagesAdjacent(board, review, merge, withCi)).toBe(false);
  });

  it("is paused by enabled: false, and needs steps to be on", () => {
    const pausedFile = { stages: { settings: { ci: { steps: STEPS, enabled: false } } } };
    expect(configFrom(pausedFile).stageSwitches.ci).toBe(false);
    const board = boardWith(pausedFile);
    expect(pipeline(board, withCi)).not.toContain("ci");
    expect(isBoardCiActive(board, withCi)).toBe(false);

    const empty = resolveFile({ stages: { settings: { ci: { enabled: true } } } });
    expect(empty.delta.ci.steps).toEqual([]);
    expect(empty.delta.warnings.join("\n")).toContain("has no steps");
  });

  it("keeps an inactive CI column while a card of the project still sits in it", () => {
    const board = boardWith({ stages: { settings: { ci: { steps: STEPS, enabled: false } } } }, [
      { stage: ci, projectId: withCi },
    ]);
    expect(pipeline(board, withCi)).toContain("ci(retired)");
  });

  it("can't be removed, and caps the step list", () => {
    const removed = resolveFile({ stages: { remove: ["ci"] } });
    expect(removed.delta.stageSwitches).toEqual({});
    expect(removed.delta.warnings.join("\n")).toContain("ci.enabled");

    const many = Array.from({ length: 20 }, (_, index) => ({
      name: `Step ${index}`,
      command: "true",
    }));
    const capped = resolveFile({ stages: { settings: { ci: { steps: many } } } });
    expect(capped.delta.ci.steps).toHaveLength(12);
    expect(capped.delta.warnings.join("\n")).toContain("at most 12 steps");
  });
});

describe("CI member resolution", () => {
  it("defaults to no steps, three fixes and the compiled-in prompt, in build mode and unattended", () => {
    const exec = resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, ci);
    expect(isBoardCiStageExecution(exec)).toBe(true);
    if (!isBoardCiStageExecution(exec)) return;
    expect(exec).toMatchObject({
      maxFixAttempts: 3,
      prompt: DEFAULT_BOARD_CI_FIX_PROMPT,
      mode: "build",
      humanInLoop: false,
      autoAdvance: true,
      autoExecute: true,
    });
  });

  it("takes every field from the project's stages.settings.ci, but never its invariants", () => {
    const resolved = configFrom({
      stages: {
        settings: {
          ci: {
            steps: STEPS,
            maxFixAttempts: 0,
            prompt: "Fix it.",
            autoAdvance: false,
            humanInLoop: true,
            mode: "plan",
          },
        },
      },
    });
    const exec = resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, ci, resolved);
    if (!isBoardCiStageExecution(exec)) throw new Error("expected the CI member");
    expect(resolved.ci.steps.map((step) => step.name)).toEqual(["Lint", "Test"]);
    expect(exec.maxFixAttempts).toBe(0);
    expect(exec.prompt).toBe("Fix it.");
    expect(exec.autoAdvance).toBe(true);
    expect(exec.humanInLoop).toBe(false);
    expect(exec.mode).toBe("build");
  });

  it("warns about a bad step list and keeps the rest", () => {
    const resolved = resolveFile({
      stages: { settings: { ci: { steps: [{ name: "", command: "x" }], maxFixAttempts: 1 } } },
    });
    expect(resolved.delta.warnings.join("\n")).toContain("stages.settings.ci.steps");
    expect(resolved.delta.ci.steps).toEqual([]);
    expect(resolved.delta.overrides.ci?.maxFixAttempts).toBe(1);
  });
});

describe("CI move refusals", () => {
  const board = boardWith(ciFile);
  const card = (stage: BoardStageId, projectId = withCi) => ({ stage, projectId });
  const refuse = (from: BoardStageId, to: BoardStageId, projectId = withCi, pipelineMove = false) =>
    boardCardMoveRefusal(board, card(from, projectId), to, {
      override: true,
      pipeline: pipelineMove,
    });

  it("lets a card in, by hand, only from the stage just before CI", () => {
    // A review loop that stopped short holds the card in review: a human
    // must be able to send it on into CI.
    expect(refuse(review, ci)).toBeNull();
    expect(refuse(building, ci)).toContain("just before it");
    expect(refuse(merge, ci)).toContain("just before it");
  });

  it("refuses leaving CI forward, and jumping over it", () => {
    expect(refuse(ci, merge)).toContain("Skip CI");
    expect(refuse(ci, done)).toContain("Skip CI");
    expect(refuse(review, merge)).toContain("has to pass CI");
    expect(refuse(ready, done)).toContain("has to pass CI");
  });

  it("lets a card move back out of CI, and around after it", () => {
    expect(refuse(ci, review)).toBeNull();
    expect(refuse(ci, building)).toBeNull();
    expect(refuse(merge, done)).toBeNull();
    expect(refuse(done, merge)).toBeNull();
  });

  it("holds back people, not the pipeline", () => {
    expect(refuse(review, ci, withCi, true)).toBeNull();
    expect(refuse(ci, merge, withCi, true)).toBeNull();
  });

  it("changes nothing for a project without CI", () => {
    expect(refuse(review, merge, withoutCi)).toBeNull();
    expect(refuse(review, ci, withoutCi)).toContain("is off for");
  });
});

describe("a CI send-back in the next review round", () => {
  it("is a must-fix finding for review and triage, not for adjudication", () => {
    const compose = (phase: "review" | "triage" | "adjudicate") =>
      composeBoardReviewPhasePrompt({
        phase,
        round: 4,
        rounds: 4,
        prompt: "Review it.",
        ciFinding: { stepName: "Test", finding: "vp test exited with code 1." },
      });
    expect(compose("review")).toContain('after its "Test" step failed');
    expect(compose("review")).toContain("report it as a critical finding");
    expect(compose("triage")).toContain("vp test exited with code 1.");
    expect(compose("adjudicate")).not.toContain("CI sent this card back");
  });
});

describe("CI fix issues (T3O-57)", () => {
  const step = (
    name: string,
    status: "passed" | "failed" | "timed-out",
    failures: ReadonlyArray<{ title: string; file?: string; line?: number }> = [],
  ) => ({
    name,
    status,
    ...(failures.length === 0 ? {} : { result: { summary: null, failures } }),
  });

  it("makes one issue per reported failure, or one for a step that reported none", () => {
    const issues = boardCiFixIssues([
      step("Build", "passed"),
      step("Lint", "failed", [
        { title: "unused import", file: "src/a.ts", line: 3 },
        { title: "no-explicit-any" },
      ]),
      step("Test", "failed"),
      step("Browser", "timed-out"),
    ]);
    expect(issues).toEqual([
      {
        id: "s1-1",
        stepIndex: 1,
        stepName: "Lint",
        title: "unused import",
        file: "src/a.ts",
        line: 3,
      },
      { id: "s1-2", stepIndex: 1, stepName: "Lint", title: "no-explicit-any" },
      { id: "s2", stepIndex: 2, stepName: "Test", title: "Test failed" },
      { id: "s3", stepIndex: 3, stepName: "Browser", title: "Browser timed out" },
    ]);
  });

  it("caps the list, rolling the rest into a last issue", () => {
    const many = Array.from({ length: 25 }, (_, n) => ({ title: `problem ${n}` }));
    const issues = boardCiFixIssues([step("Lint", "failed", many), step("Test", "failed", many)]);
    expect(issues).toHaveLength(BOARD_CI_MAX_FIX_ISSUES);
    expect(issues.at(-2)?.id).toBe("s1-4");
    expect(issues.at(-1)).toMatchObject({ id: "more", title: "and 21 more in Test" });
  });

  it("reads each issue's outcome from the fix report, leniently", () => {
    const issues = boardCiFixIssues([step("Lint", "failed"), step("Test", "failed")]);
    const statuses = (payload: unknown) =>
      boardCiFixIssueOutcomes(
        issues,
        payload === null ? null : decodeBoardCiFixPayload(JSON.stringify(payload)),
      ).map((outcome) => [outcome.issue.id, outcome.status, outcome.note]);
    expect(statuses(null)).toEqual([
      ["s0", "open", null],
      ["s1", "open", null],
    ]);
    // Left out under `fixed` reads resolved; under `cannot-fix`, open.
    expect(statuses({ verdict: "fixed" })).toEqual([
      ["s0", "resolved", null],
      ["s1", "resolved", null],
    ]);
    expect(
      statuses({
        verdict: "cannot-fix",
        finding: "Needs Postgres.",
        issues: [{ id: "s1", status: "cannot-fix", note: "needs Postgres" }],
      }),
    ).toEqual([
      ["s0", "open", null],
      ["s1", "cannot-fix", "needs Postgres"],
    ]);
  });

  it("decodes cannot-fix, the older return-to-review, and a report with no issues", () => {
    expect(
      decodeBoardCiFixPayload(JSON.stringify({ verdict: "cannot-fix", finding: "x" })),
    ).toMatchObject({ verdict: "cannot-fix", finding: "x" });
    expect(
      decodeBoardCiFixPayload(JSON.stringify({ verdict: "return-to-review", finding: "x" })),
    ).toMatchObject({ verdict: "return-to-review" });
    expect(decodeBoardCiFixPayload(JSON.stringify({ verdict: "fixed", fixedSha: "abc" }))).toEqual({
      verdict: "fixed",
      finding: "",
      fixedSha: "abc",
    });
    expect(decodeBoardCiFixPayload(JSON.stringify({ verdict: "maybe" }))).toBeNull();
  });

  it("counts Stop on failure = No as a difference from global", () => {
    expect(
      boardProjectConfigDifferenceCount({ stageSwitches: {}, overrides: {}, ci: { steps: [] } }),
    ).toBe(0);
    expect(
      boardProjectConfigDifferenceCount({
        stageSwitches: {},
        overrides: {},
        ci: { steps: [], stopOnFailure: false },
      }),
    ).toBe(1);
  });
});

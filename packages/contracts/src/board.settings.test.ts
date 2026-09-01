/**
 * T3o board settings — the typed stage-execution pipeline (D4, t3o-07/t3o-15).
 * These lock the three things the spec's verification calls out: an empty
 * settings file produces a working pipeline, the pipeline round-trips (survives
 * a restart), and a stage absent from the pipeline resolves to the all-defaults
 * (auto-execute off) config rather than throwing.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  assignBoardKeyPrefix,
  BOARD_SEED_STAGE_IDS,
  BoardSettings,
  boardProjectAcronym,
  DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE,
  DEFAULT_BOARD_BUILD_PROMPT,
  DEFAULT_BOARD_KEY_PREFIX,
  DEFAULT_BOARD_PIPELINE,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_BOARD_STAGE_EXECUTION,
  effectiveBoardRuntimeMode,
  isBoardReviewStageExecution,
  resolveBoardKeyPrefix,
  resolveBoardProjectAccent,
  resolveBoardStageExecution,
  resolveBoardDefaultModelSelection,
  resolveBoardStageModelSelection,
  boardStepErrorSummary,
  BOARD_STEP_ERROR_MAX_CHARS,
} from "./board.ts";

const decodeSettings = Schema.decodeUnknownSync(BoardSettings);
const encodeSettings = Schema.encodeUnknownSync(BoardSettings);

const PROJECT = ProjectId.make("project-1");

describe("board settings defaults", () => {
  it("decodes an empty file to a working default pipeline", () => {
    const settings = decodeSettings({});
    // Building ships auto-executing in build mode (D4) — a working pipeline out
    // of an empty file.
    expect(settings.pipeline[BOARD_SEED_STAGE_IDS.building]).toEqual(
      DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.building],
    );
    expect(settings.pipeline[BOARD_SEED_STAGE_IDS.planning]).toEqual(
      DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.planning],
    );
    expect(settings.projects).toEqual({});
    expect(settings.concurrency.globalMaxConcurrent).toBeGreaterThan(0);
    expect(settings.lifecycle.reclaimWorktreeOnDone).toBe(DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE);
    expect(settings).toEqual(DEFAULT_BOARD_SETTINGS);
  });

  it("decodes a settings file written before the lifecycle reshape", () => {
    // `lifecycle` is one of the INDIVISIBLE settings keys, so a user who ever
    // touched the old archive-window or retention control has the WHOLE old
    // object on disk. Unknown keys drop silently, leaving `{}` — and a
    // `lifecycle` block that fails to decode does not merely lose its own
    // value: `loadSettingsFromDisk` discards the ENTIRE settings file back to
    // compiled-in defaults, silently reverting every unrelated setting the
    // user has. The field's own decoding default is what stops that; the
    // struct-level one on `BoardSettings.lifecycle` does not, because it fires
    // only when `lifecycle` is ABSENT, never when it is present and invalid.
    const settings = decodeSettings({
      lifecycle: { archiveAfterDays: 21, worktreeRetention: "reclaim-on-archive" },
    });
    expect(settings.lifecycle.reclaimWorktreeOnDone).toBe(DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE);
  });

  it("the default Building stage is runnable (real instance + model), not a placeholder", () => {
    const building = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      BOARD_SEED_STAGE_IDS.building,
    );
    expect(building.autoExecute).toBe(true);
    expect(building.mode).toBe("build");
    expect(building.prompt).toBe(DEFAULT_BOARD_BUILD_PROMPT);
    expect(building.maxAttempts).toBeGreaterThan(0);
    expect(building.timeoutMs).toBeGreaterThan(0);
    // A stage names no model of its own out of the box: the caller supplies
    // the fallback (the app's own text-generation selection), because the board
    // has no compiled-in pair — one would name a model the user may not have.
    expect(building.model).toBe(null);
    const fallback = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };
    expect(resolveBoardStageModelSelection(building.model, fallback)).toEqual(fallback);
    const chosen = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-terra" };
    expect(resolveBoardStageModelSelection(chosen, fallback)).toEqual(chosen);
  });
});

describe("resolveBoardDefaultModelSelection (t3o-30, D1)", () => {
  const appFallback = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-luna" };

  it("falls through to the app's text-generation selection when unset", () => {
    // The shipped state, and the behaviour this replaced: with no board default
    // the app-wide pair still governs, so nothing changes for anyone who never
    // sets one.
    expect(DEFAULT_BOARD_SETTINGS.defaultModel).toBe(null);
    expect(resolveBoardDefaultModelSelection(DEFAULT_BOARD_SETTINGS, appFallback)).toEqual(
      appFallback,
    );
  });

  it("wins over the app's selection once the user picks one", () => {
    const chosen = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5" };
    expect(resolveBoardDefaultModelSelection({ defaultModel: chosen }, appFallback)).toEqual(
      chosen,
    );
  });

  it("survives a round-trip, so a restart does not drop it", () => {
    const chosen = { instanceId: "claudeAgent", model: "claude-opus-5" };
    expect(decodeSettings({ defaultModel: chosen }).defaultModel).toEqual(chosen);
  });
});

describe("boardStepErrorSummary (t3o-30, D2)", () => {
  it("keeps the message and its root cause, and drops the stack between them", () => {
    const summary = boardStepErrorSummary(
      [
        "ProviderAdapterProcessError: Failed to spawn Codex App Server process",
        "    at file:///app/src/provider/Layers/CodexAdapter.ts:1709:15",
        "    at startSession (file:///app/src/orchestration/x.ts:624:23)",
        "  [cause]: CodexAppServerSpawnError: Failed to spawn Codex App Server",
        "    at file:///app/src/provider/Layers/CodexSessionRuntime.ts:890:13",
        "  [cause]: Error: spawn codex ENOENT",
      ].join("\n"),
    );
    // The outer message says which layer noticed; the INNERMOST cause says what
    // to fix, and each nesting level prints its own, so the last one wins.
    expect(summary).toBe(
      "ProviderAdapterProcessError: Failed to spawn Codex App Server process\n\nError: spawn codex ENOENT",
    );
  });

  it("returns the message alone when there is no cause, and null when there is nothing", () => {
    expect(boardStepErrorSummary("Model 'gpt-9' is not available on this instance.")).toBe(
      "Model 'gpt-9' is not available on this instance.",
    );
    expect(boardStepErrorSummary("   \n  \n")).toBe(null);
    expect(boardStepErrorSummary("")).toBe(null);
  });

  it("caps the length, so a pathological error cannot become the whole card", () => {
    const summary = boardStepErrorSummary("x".repeat(5_000));
    expect(summary).not.toBeNull();
    expect(summary!.length).toBe(BOARD_STEP_ERROR_MAX_CHARS);
    expect(summary!.endsWith("\u2026")).toBe(true);
  });
});

describe("board settings round-trip", () => {
  it("survives encode/decode (a restart) unchanged, including a full pipeline", () => {
    const configured = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "T3", accentColor: "#39d" } },
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          autoExecute: true,
          prompt: DEFAULT_BOARD_BUILD_PROMPT,
          model: { instanceId: "codex", model: "custom-model" },
          mode: "build",
          humanInLoop: false,
          humanInLoopWithPlan: false,
          humanInLoopWithoutPlan: true,
          autoAdvance: true,
          timeoutMs: 600000,
          maxAttempts: 3,
        },
        [BOARD_SEED_STAGE_IDS.review]: {
          autoExecute: true,
          prompt: "Review the diff.",
          model: { instanceId: "codex", model: "review-model" },
          mode: "build",
          humanInLoop: false,
          humanInLoopWithPlan: false,
          humanInLoopWithoutPlan: true,
          autoAdvance: true,
          timeoutMs: 600000,
          maxAttempts: 2,
        },
      },
    });
    const roundTripped = decodeSettings(JSON.parse(JSON.stringify(encodeSettings(configured))));
    expect(roundTripped).toEqual(configured);
  });
});

describe("resolveBoard* helpers", () => {
  it("resolves a stage's execution config, or the all-defaults config when the stage has none", () => {
    // The resolver fills the effective access level (t3o-21): a build-mode
    // stage defaults to `auto` (never the old forced `full-access`).
    expect(
      resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.building),
    ).toEqual({ ...DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.building], runtimeMode: "auto" });
    // A stage absent from the pipeline map runs nothing — the all-defaults
    // (auto-execute off) config, whose plan-mode default resolves access to
    // `approval-required`.
    expect(resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.ready)).toEqual({
      ...DEFAULT_BOARD_STAGE_EXECUTION,
      runtimeMode: "approval-required",
    });
    expect(DEFAULT_BOARD_STAGE_EXECUTION.autoExecute).toBe(false);
  });

  it("resolves an ABSENT seeded stage to its seeded config, not the empty one", () => {
    // settings.json is written sparsely — an entry equal to its compiled-in
    // default is pruned — so "Planning is missing from the map" is the normal
    // state of a board whose Planning was never edited. Resolving it to the
    // empty all-defaults config would switch the seeded stage off the first
    // time any OTHER stage was edited.
    const onlyBuilding = decodeSettings({
      pipeline: { [BOARD_SEED_STAGE_IDS.building]: DEFAULT_BOARD_PIPELINE.building },
    });
    for (const stageId of [BOARD_SEED_STAGE_IDS.planning, BOARD_SEED_STAGE_IDS.review] as const) {
      const resolved = resolveBoardStageExecution(onlyBuilding, stageId);
      expect(resolved.autoExecute).toBe(true);
      expect(resolved.prompt).toBe(DEFAULT_BOARD_PIPELINE[stageId]?.prompt);
    }
  });

  it("falls back to the default key prefix, or uses the configured one and accent", () => {
    expect(resolveBoardKeyPrefix(DEFAULT_BOARD_SETTINGS, PROJECT)).toBe(DEFAULT_BOARD_KEY_PREFIX);
    expect(resolveBoardProjectAccent(DEFAULT_BOARD_SETTINGS, PROJECT)).toBe(null);
    const configured = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "T3", accentColor: "#39d" } },
    });
    expect(resolveBoardKeyPrefix(configured, PROJECT)).toBe("T3");
    expect(resolveBoardProjectAccent(configured, PROJECT)).toBe("#39d");
  });
});

describe("project key acronyms (D14)", () => {
  it("reads a name as words — separators and camelCase humps both split", () => {
    expect(boardProjectAcronym("core.agent.advisor")).toBe("CAA");
    expect(boardProjectAcronym("mesh.web")).toBe("MW");
    expect(boardProjectAcronym("mesh-relay")).toBe("MR");
    expect(boardProjectAcronym("meshRelay")).toBe("MR");
    expect(boardProjectAcronym("t3o-test")).toBe("TT");
    // One word gives its opening letters, digits included.
    expect(boardProjectAcronym("backend")).toBe("BAC");
    expect(boardProjectAcronym("t3o")).toBe("T3O");
    // Nothing to read: the compiled-in default, never an empty prefix.
    expect(boardProjectAcronym("···")).toBe(DEFAULT_BOARD_KEY_PREFIX);
  });

  it("never hands two projects the same prefix", () => {
    expect(boardProjectAcronym("mesh.web", ["MW"])).toBe("MES");
    expect(boardProjectAcronym("mesh.web", ["MW", "MES"])).toBe("MW2");
    // Case never smuggles a collision through.
    expect(boardProjectAcronym("mesh.web", ["mw"])).toBe("MES");
  });

  it("assigns an acronym once, then leaves the stored prefix alone", () => {
    const first = assignBoardKeyPrefix({
      board: DEFAULT_BOARD_SETTINGS,
      projectId: PROJECT,
      projectTitle: "mesh.web",
    });
    expect(first).toEqual({ prefix: "MW", assigned: true });

    // Persisted — a later card (even after a rename) keeps the same keys.
    const stored = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "MW", accentColor: null } },
    });
    expect(
      assignBoardKeyPrefix({ board: stored, projectId: PROJECT, projectTitle: "mesh.gateway" }),
    ).toEqual({ prefix: "MW", assigned: false });

    // A second project with the same initials gets its own namespace.
    const other = ProjectId.make("project-2");
    expect(
      assignBoardKeyPrefix({ board: stored, projectId: other, projectTitle: "mesh-worker" }),
    ).toEqual({ prefix: "MES", assigned: true });
  });
});

describe("stage execution resolution reflects edits (D4)", () => {
  it("resolveBoardStageExecution tracks the current settings, so an edit changes what a stage runs", () => {
    // Settings edited mid-flight to a different model for Building.
    const edited = decodeSettings({
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          autoExecute: true,
          prompt: DEFAULT_BOARD_BUILD_PROMPT,
          model: { instanceId: "codex", model: "a-newer-model" },
          mode: "build",
          humanInLoop: false,
          humanInLoopWithPlan: false,
          humanInLoopWithoutPlan: true,
          autoAdvance: true,
          timeoutMs: DEFAULT_BOARD_STAGE_EXECUTION.timeoutMs,
          maxAttempts: DEFAULT_BOARD_STAGE_EXECUTION.maxAttempts,
        },
      },
    });
    const before = resolveBoardStageExecution(
      DEFAULT_BOARD_SETTINGS,
      BOARD_SEED_STAGE_IDS.building,
    );
    const after = resolveBoardStageExecution(edited, BOARD_SEED_STAGE_IDS.building);
    // The default resolves to a null model (the global default); the edit
    // resolves to the concrete override — the two diverge exactly at the model.
    expect(before.model).toBe(null);
    expect(after.model).toEqual({ instanceId: "codex", model: "a-newer-model" });
    expect(after).not.toEqual(before);
  });
});

describe("role-holder invariants forced at resolution (settings redesign)", () => {
  it("Planning always resolves plan-mode + human-in-the-loop, whatever is stored", () => {
    const edited = decodeSettings({
      pipeline: {
        [BOARD_SEED_STAGE_IDS.planning]: {
          autoExecute: true,
          prompt: "custom",
          mode: "build",
          humanInLoop: false,
          humanInLoopWithPlan: true,
        },
      },
    });
    const resolved = resolveBoardStageExecution(edited, BOARD_SEED_STAGE_IDS.planning);
    expect(resolved.mode).toBe("plan");
    expect(resolved.humanInLoop).toBe(true);
    expect(resolved.humanInLoopWithPlan).toBe(false);
    expect(resolved.prompt).toBe("custom");
  });

  it("Building always resolves build-mode with the with-plan pause off", () => {
    const edited = decodeSettings({
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          autoExecute: true,
          prompt: "custom",
          mode: "plan",
          humanInLoopWithPlan: true,
        },
      },
    });
    const resolved = resolveBoardStageExecution(edited, BOARD_SEED_STAGE_IDS.building);
    expect(resolved.mode).toBe("build");
    expect(resolved.humanInLoopWithPlan).toBe(false);
  });

  it("a review member stored under a role-holder key is ignored, like a simple member under the review key", () => {
    const edited = decodeSettings({
      pipeline: { [BOARD_SEED_STAGE_IDS.planning]: { kind: "review" } },
    });
    const resolved = resolveBoardStageExecution(edited, BOARD_SEED_STAGE_IDS.planning);
    expect(resolved.kind).toBe("simple");
    expect(resolved.mode).toBe("plan");
  });
});

describe("agent access level is the user's, never forced (t3o-21)", () => {
  it("effectiveBoardRuntimeMode defaults by mode and honours an explicit choice", () => {
    // Unset: build defaults to `auto`, plan to `approval-required` — NEVER the
    // old forced `full-access`.
    expect(effectiveBoardRuntimeMode(undefined, "build")).toBe("auto");
    expect(effectiveBoardRuntimeMode(undefined, "plan")).toBe("approval-required");
    // A value the user picked is honoured verbatim for either mode.
    expect(effectiveBoardRuntimeMode("approval-required", "build")).toBe("approval-required");
    expect(effectiveBoardRuntimeMode("full-access", "build")).toBe("full-access");
    expect(effectiveBoardRuntimeMode("auto", "plan")).toBe("auto");
  });

  it("no seeded stage resolves to full-access by default", () => {
    for (const stageId of [
      BOARD_SEED_STAGE_IDS.planning,
      BOARD_SEED_STAGE_IDS.building,
      BOARD_SEED_STAGE_IDS.review,
    ] as const) {
      const resolved = resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, stageId);
      expect(resolved.runtimeMode).not.toBe("full-access");
    }
    // Building (build-mode) → auto; Planning (plan-mode) → approval-required.
    expect(
      resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.building).runtimeMode,
    ).toBe("auto");
    expect(
      resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.planning).runtimeMode,
    ).toBe("approval-required");
  });

  it("honours a user-chosen access level on a build-mode stage, even full-access", () => {
    const edited = decodeSettings({
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          autoExecute: true,
          prompt: "custom",
          runtimeMode: "full-access",
        },
      },
    });
    // The user opted into full-access explicitly — the resolver must not
    // override it back to the safer default.
    expect(resolveBoardStageExecution(edited, BOARD_SEED_STAGE_IDS.building).runtimeMode).toBe(
      "full-access",
    );
  });

  it("each review phase carries its own optional access level and effort", () => {
    const edited = decodeSettings({
      pipeline: {
        [BOARD_SEED_STAGE_IDS.review]: {
          kind: "review",
          phases: {
            review: { runtimeMode: "full-access" },
            triage: {},
            adjudicate: {},
          },
        },
      },
    });
    const resolved = resolveBoardStageExecution(edited, BOARD_SEED_STAGE_IDS.review);
    expect(isBoardReviewStageExecution(resolved)).toBe(true);
    if (!isBoardReviewStageExecution(resolved)) return;
    // The stored phase value survives; the two unset phases have no key (the
    // settings row resolves them to `auto` at render, always build-mode).
    expect(resolved.phases.review.runtimeMode).toBe("full-access");
    expect(resolved.phases.triage.runtimeMode).toBeUndefined();
    expect(effectiveBoardRuntimeMode(resolved.phases.triage.runtimeMode, "build")).toBe("auto");
  });
});

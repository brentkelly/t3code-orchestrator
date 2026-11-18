import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  assignBoardKeyPrefix,
  BOARD_CONFLICT_VERIFICATION,
  BOARD_SEED_STAGE_IDS,
  BoardStageId,
  BoardSettings,
  boardProjectAcronym,
  DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_AUTO_ARCHIVE_DONE,
  DEFAULT_BOARD_AUTO_COLLAPSE_EMPTY_STAGES,
  DEFAULT_BOARD_COST_EMPHASIS_USD,
  DEFAULT_BOARD_WORKTREE_AT_DONE,
  BoardSettingsPatch,
  DEFAULT_BOARD_BUILD_PROMPT,
  DEFAULT_BOARD_SUBMIT_PROMPT,
  DEFAULT_BOARD_KEY_PREFIX,
  DEFAULT_BOARD_MERGE_CONFLICT_PROMPT,
  DEFAULT_BOARD_PIPELINE,
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_BOARD_STAGE_EXECUTION,
  effectiveBoardRuntimeMode,
  isBoardProjectHidden,
  isBoardBuildStageExecution,
  isBoardReviewStageExecution,
  RETIRED_BOARD_MERGE_CONFLICT_PROMPTS,
  resolveBoardKeyPrefix,
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
    // Building ships auto-executing in build mode — a working pipeline out
    // of an empty file.
    expect(settings.pipeline[BOARD_SEED_STAGE_IDS.building]).toEqual(
      DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.building],
    );
    expect(settings.pipeline[BOARD_SEED_STAGE_IDS.planning]).toEqual(
      DEFAULT_BOARD_PIPELINE[BOARD_SEED_STAGE_IDS.planning],
    );
    expect(settings.projects).toEqual({});
    expect(settings.concurrency.globalMaxConcurrent).toBeGreaterThan(0);
    expect(settings.lifecycle.worktreeAtDone).toBe(DEFAULT_BOARD_WORKTREE_AT_DONE);
    expect(settings).toEqual(DEFAULT_BOARD_SETTINGS);
  });

  it("decodes a settings file written before the lifecycle reshape", () => {
    // `lifecycle` is indivisible, and a block that fails to decode discards the whole settings
    // file to defaults. The field's own decoding default prevents that; the struct-level one
    // fires only when `lifecycle` is absent.
    const settings = decodeSettings({
      lifecycle: { archiveAfterDays: 21, worktreeRetention: "reclaim-on-archive" },
    });
    expect(settings.lifecycle.worktreeAtDone).toBe(DEFAULT_BOARD_WORKTREE_AT_DONE);
    // The old `archiveAfterDays` must not switch auto-archive on.
    expect(settings.lifecycle.autoArchiveDone).toBe(false);
    expect(settings.lifecycle.autoArchiveAfterDays).toBe(7);
  });

  it("ships auto-collapse empty stages off and round-trips it (T3O-40)", () => {
    expect(DEFAULT_BOARD_AUTO_COLLAPSE_EMPTY_STAGES).toBe(false);
    expect(DEFAULT_BOARD_SETTINGS.display.autoCollapseEmptyStages).toBe(false);
    // A file written before `display` existed, or with an empty block, decodes off.
    expect(decodeSettings({ lifecycle: {} }).display.autoCollapseEmptyStages).toBe(false);
    expect(decodeSettings({ display: {} }).display.autoCollapseEmptyStages).toBe(false);
    const on = decodeSettings({ display: { autoCollapseEmptyStages: true } });
    expect(on.display.autoCollapseEmptyStages).toBe(true);
    expect(decodeSettings(encodeSettings(on)).display).toEqual({
      autoCollapseEmptyStages: true,
      costEmphasisUsd: DEFAULT_BOARD_COST_EMPHASIS_USD,
    });
  });

  it("ships the cost emphasis at $5, keeps a set one, and refuses a negative one (T3O-77)", () => {
    expect(DEFAULT_BOARD_COST_EMPHASIS_USD).toBe(5);
    expect(
      decodeSettings({ display: { autoCollapseEmptyStages: true } }).display.costEmphasisUsd,
    ).toBe(5);
    const set = decodeSettings({ display: { costEmphasisUsd: 12.5 } });
    expect(decodeSettings(encodeSettings(set)).display.costEmphasisUsd).toBe(12.5);
    expect(() => decodeSettings({ display: { costEmphasisUsd: -1 } })).toThrow();
  });

  it("ships auto-archive off with a seven-day window (T3O-77)", () => {
    expect(DEFAULT_BOARD_AUTO_ARCHIVE_DONE).toBe(false);
    expect(DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS).toBe(7);
    expect(DEFAULT_BOARD_SETTINGS.lifecycle.autoArchiveDone).toBe(false);
    expect(DEFAULT_BOARD_SETTINGS.lifecycle.autoArchiveAfterDays).toBe(7);
    // A lifecycle block written before the fields existed decodes the defaults
    // rather than failing — which would discard the whole settings file.
    const settings = decodeSettings({ lifecycle: { reclaimWorktreeOnDone: false } });
    expect(settings.lifecycle).toEqual({
      worktreeAtDone: "keep",
      autoArchiveDone: false,
      autoArchiveAfterDays: 7,
    });
  });

  it("reads the worktree-at-Done mode from the new key, else the legacy boolean (T3O-123)", () => {
    expect(DEFAULT_BOARD_WORKTREE_AT_DONE).toBe("remove");
    const mode = (lifecycle: object) => decodeSettings({ lifecycle }).lifecycle.worktreeAtDone;
    expect(mode({})).toBe("remove");
    expect(mode({ reclaimWorktreeOnDone: false })).toBe("keep");
    expect(mode({ reclaimWorktreeOnDone: true })).toBe("remove");
    expect(mode({ worktreeAtDone: "remove-if-clean" })).toBe("remove-if-clean");
    // deepMerge never deletes a key, so a stored block can carry both; the new key wins.
    expect(mode({ reclaimWorktreeOnDone: false, worktreeAtDone: "remove" })).toBe("remove");
    expect(mode({ reclaimWorktreeOnDone: true, worktreeAtDone: "keep" })).toBe("keep");
    // The legacy key does not survive a decode.
    expect(
      decodeSettings({ lifecycle: { reclaimWorktreeOnDone: false } }).lifecycle,
    ).not.toHaveProperty("reclaimWorktreeOnDone");
  });

  it("maps an out-of-date client's reclaimWorktreeOnDone patch to worktreeAtDone (T3O-123)", () => {
    const decodePatch = Schema.decodeUnknownSync(BoardSettingsPatch);
    expect(decodePatch({ lifecycle: { reclaimWorktreeOnDone: false } }).lifecycle).toEqual({
      worktreeAtDone: "keep",
    });
    expect(decodePatch({ lifecycle: { reclaimWorktreeOnDone: true } }).lifecycle).toEqual({
      worktreeAtDone: "remove",
    });
    expect(
      decodePatch({
        lifecycle: { worktreeAtDone: "remove-if-clean", reclaimWorktreeOnDone: false },
      }).lifecycle,
    ).toEqual({ worktreeAtDone: "remove-if-clean" });
    expect(decodePatch({ lifecycle: { autoArchiveDone: true } }).lifecycle).toEqual({
      autoArchiveDone: true,
    });
  });

  it("round-trips an enabled auto-archive and refuses a non-positive window", () => {
    const lifecycle = {
      worktreeAtDone: "remove-if-clean",
      autoArchiveDone: true,
      autoArchiveAfterDays: 3,
    };
    expect(decodeSettings(encodeSettings(decodeSettings({ lifecycle }))).lifecycle).toEqual(
      lifecycle,
    );
    expect(() =>
      decodeSettings({ lifecycle: { ...lifecycle, autoArchiveAfterDays: 0 } }),
    ).toThrow();
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
      projects: { [PROJECT]: { keyPrefix: "T3" } },
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
    // The resolver fills the effective access level: a build-mode
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
    // settings.json prunes entries equal to their default, so a missing Planning is normal and
    // must not resolve to the all-defaults (switched off) config.
    const onlyBuilding = decodeSettings({
      pipeline: { [BOARD_SEED_STAGE_IDS.building]: DEFAULT_BOARD_PIPELINE.building },
    });
    for (const stageId of [BOARD_SEED_STAGE_IDS.planning, BOARD_SEED_STAGE_IDS.review] as const) {
      const resolved = resolveBoardStageExecution(onlyBuilding, stageId);
      expect(resolved.autoExecute).toBe(true);
      expect(resolved.prompt).toBe(DEFAULT_BOARD_PIPELINE[stageId]?.prompt);
    }
  });

  // The Building stage resolves to the build member whatever the file says; the resolver,
  // not a migration, is the guarantee.

  it("resolves an ABSENT Building entry to the build member, with submit populated", () => {
    const resolved = resolveBoardStageExecution(decodeSettings({}), BOARD_SEED_STAGE_IDS.building);
    expect(isBoardBuildStageExecution(resolved)).toBe(true);
    expect(isBoardBuildStageExecution(resolved) && resolved.submit.prompt).toBe(
      DEFAULT_BOARD_SUBMIT_PROMPT,
    );
    // The invariants the branch has always forced.
    expect(resolved.mode).toBe("build");
    expect(resolved.humanInLoopWithPlan).toBe(false);
    expect(resolved.prompt).toBe(DEFAULT_BOARD_BUILD_PROMPT);
  });

  it("UPGRADES a legacy simple Building entry rather than discarding what the user wrote", () => {
    // Unlike review and merge, a legacy build entry keeps its fields: one of them is a prompt
    // the user wrote.
    const legacy = decodeSettings({
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          kind: "simple",
          autoExecute: true,
          prompt: "My own build prompt.",
          model: { instanceId: "claude", model: "opus" },
          autoAdvance: false,
          maxAttempts: 2,
        },
      },
    });
    const resolved = resolveBoardStageExecution(legacy, BOARD_SEED_STAGE_IDS.building);
    expect(isBoardBuildStageExecution(resolved)).toBe(true);
    expect(resolved.prompt).toBe("My own build prompt.");
    expect(resolved.model).toEqual({ instanceId: "claude", model: "opus" });
    expect(resolved.autoAdvance).toBe(false);
    expect(resolved.maxAttempts).toBe(2);
    // ...and the setting that did not exist when the file was written is
    // filled in from the compiled-in default.
    expect(isBoardBuildStageExecution(resolved) && resolved.submit.prompt).toBe(
      DEFAULT_BOARD_SUBMIT_PROMPT,
    );
    expect(resolved.mode).toBe("build");
  });

  it("passes a genuine build entry through, submit and all", () => {
    const configured = decodeSettings({
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          kind: "build",
          prompt: "Build it.",
          submit: {
            prompt: "Push it.",
            model: { instanceId: "claude", model: "haiku" },
            maxAttempts: 1,
          },
        },
      },
    });
    const resolved = resolveBoardStageExecution(configured, BOARD_SEED_STAGE_IDS.building);
    expect(isBoardBuildStageExecution(resolved)).toBe(true);
    if (!isBoardBuildStageExecution(resolved)) return;
    expect(resolved.submit.prompt).toBe("Push it.");
    expect(resolved.submit.model).toEqual({ instanceId: "claude", model: "haiku" });
    expect(resolved.submit.maxAttempts).toBe(1);
    // Unset per-step fields still take their own defaults.
    expect(resolved.submit.timeoutMs).toBeGreaterThan(0);
  });

  it("a settings file written before the build member round-trips through a decode", () => {
    // The upgrade case as a user actually hits it: their file is read, their
    // board runs, and re-encoding it does not lose anything they wrote.
    const legacyFile = {
      pipeline: {
        [BOARD_SEED_STAGE_IDS.building]: {
          kind: "simple" as const,
          autoExecute: true,
          prompt: "My own build prompt.",
        },
      },
    };
    const decoded = decodeSettings(legacyFile);
    const round = decodeSettings(encodeSettings(decoded));
    expect(round.pipeline[BOARD_SEED_STAGE_IDS.building]?.prompt).toBe("My own build prompt.");
    expect(resolveBoardStageExecution(round, BOARD_SEED_STAGE_IDS.building).prompt).toBe(
      "My own build prompt.",
    );
  });

  it("falls back to the default key prefix, or uses the configured one", () => {
    expect(resolveBoardKeyPrefix(DEFAULT_BOARD_SETTINGS, PROJECT)).toBe(DEFAULT_BOARD_KEY_PREFIX);
    const configured = decodeSettings({ projects: { [PROJECT]: { keyPrefix: "T3" } } });
    expect(resolveBoardKeyPrefix(configured, PROJECT)).toBe("T3");
  });

  it("still decodes an entry carrying the retired `accentColor`, and drops it", () => {
    // Legacy entries carry `accentColor`; rejecting it would revert the whole settings file,
    // so it must decode, keep the other fields, and not survive the next write.
    const legacy = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "T3", accentColor: "violet", hidden: true } },
    });
    // T3o (T3O-124): an entry from before readiness trust decodes untrusted.
    expect(legacy.projects[PROJECT]).toEqual({
      keyPrefix: "T3",
      hidden: true,
      trustReadinessScript: false,
    });
    expect(encodeSettings(legacy)).not.toHaveProperty(["projects", PROJECT, "accentColor"]);
    const legacyNull = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: null, accentColor: null } },
    });
    expect(legacyNull.projects[PROJECT]).toEqual({
      keyPrefix: null,
      hidden: false,
      trustReadinessScript: false,
    });
  });

  it("resolves project visibility, and an entry written before `hidden` existed still decodes", () => {
    expect(isBoardProjectHidden(DEFAULT_BOARD_SETTINGS, PROJECT)).toBe(false);
    // A pre-`hidden` settings file: the field's decoding default fills false
    // rather than failing the whole-settings decode (which would silently
    // revert the user's file to compiled-in defaults).
    const legacy = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "T3" } },
    });
    expect(isBoardProjectHidden(legacy, PROJECT)).toBe(false);
    const hiddenSettings = decodeSettings({
      projects: { [PROJECT]: { keyPrefix: "T3", hidden: true } },
    });
    expect(isBoardProjectHidden(hiddenSettings, PROJECT)).toBe(true);
  });
});

describe("project key acronyms (D14)", () => {
  it("reads a name as words — separators and camelCase humps both split", () => {
    expect(boardProjectAcronym("core.agent.advisor")).toBe("CAA");
    expect(boardProjectAcronym("mesh.web")).toBe("MW");
    expect(boardProjectAcronym("mesh-relay")).toBe("MR");
    expect(boardProjectAcronym("meshRelay")).toBe("MR");
    expect(boardProjectAcronym("t3o-test")).toBe("TT");
    // Four words still make at most three letters.
    expect(boardProjectAcronym("a.big.core.thing")).toBe("ABC");
    // One word gives its opening letters, digits included.
    expect(boardProjectAcronym("backend")).toBe("BAC");
    expect(boardProjectAcronym("t3o")).toBe("T3O");
    // Nothing to read: the compiled-in default, never an empty prefix.
    expect(boardProjectAcronym("···")).toBe(DEFAULT_BOARD_KEY_PREFIX);
  });

  it("never hands two projects the same prefix, and numbers within three characters", () => {
    expect(boardProjectAcronym("mesh.web", ["MW"])).toBe("MES");
    expect(boardProjectAcronym("mesh.web", ["MW", "MES"])).toBe("MW2");
    expect(boardProjectAcronym("core.agent.advisor", ["CAA", "CA", "COR"])).toBe("CA2");
    expect(
      boardProjectAcronym("mesh.web", [
        "MW",
        "MES",
        ...Array.from({ length: 8 }, (_, index) => `MW${index + 2}`),
      ]),
    ).toBe("M10");
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
      projects: { [PROJECT]: { keyPrefix: "MW" } },
    });
    expect(
      assignBoardKeyPrefix({ board: stored, projectId: PROJECT, projectTitle: "mesh.gateway" }),
    ).toEqual({ prefix: "MW", assigned: false });

    // A second project reading the same gets its own namespace.
    const other = ProjectId.make("project-2");
    expect(
      assignBoardKeyPrefix({ board: stored, projectId: other, projectTitle: "mesh-web" }),
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
  it("effectiveBoardRuntimeMode defaults to auto and honours an explicit choice", () => {
    // Unset: `auto` — NEVER the old forced `full-access`.
    expect(effectiveBoardRuntimeMode(undefined)).toBe("auto");
    // A value the user picked is honoured verbatim for either mode.
    expect(effectiveBoardRuntimeMode("approval-required")).toBe("approval-required");
    expect(effectiveBoardRuntimeMode("full-access")).toBe("full-access");
    expect(effectiveBoardRuntimeMode("auto")).toBe("auto");
  });

  it("Planning defaults to auto; a custom plan-mode stage, without the root guard, to approval-required", () => {
    const settings = decodeSettings({
      pipeline: { research: { mode: "plan" } },
    });
    expect(resolveBoardStageExecution(settings, BOARD_SEED_STAGE_IDS.planning).runtimeMode).toBe(
      "auto",
    );
    expect(resolveBoardStageExecution(settings, BoardStageId.make("research")).runtimeMode).toBe(
      "approval-required",
    );
    const building = decodeSettings({
      pipeline: { research: { mode: "build" } },
    });
    expect(resolveBoardStageExecution(building, BoardStageId.make("research")).runtimeMode).toBe(
      "auto",
    );
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
    // Both default to auto; a stage's configured mode would win (T3O-115).
    expect(
      resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.building).runtimeMode,
    ).toBe("auto");
    expect(
      resolveBoardStageExecution(DEFAULT_BOARD_SETTINGS, BOARD_SEED_STAGE_IDS.planning).runtimeMode,
    ).toBe("auto");
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
    expect(effectiveBoardRuntimeMode(resolved.phases.triage.runtimeMode)).toBe("auto");
  });
});

describe("conflict resolution verifies only what it resolved (T3O-69)", () => {
  // Live settings hold the merge stage entry whole as soon as any field in it
  // is overridden (a model, say), so its prompt is the OLD default verbatim.
  // Changing the default alone would never reach those users.
  const withMergePrompt = (prompt: string) =>
    decodeSettings({
      pipeline: { [BOARD_SEED_STAGE_IDS.merge]: { kind: "merge", prompt } },
    });

  it("the default conflict prompt carries the scoped verification rule", () => {
    expect(DEFAULT_BOARD_MERGE_CONFLICT_PROMPT).toContain(BOARD_CONFLICT_VERIFICATION);
    expect(DEFAULT_BOARD_MERGE_CONFLICT_PROMPT).not.toContain("Run the project's checks");
  });

  it("the shared rule promises no follow-up the merge stage never runs", () => {
    // The merge stage re-attempts the merge straight after the conflict fix,
    // with no review round and CI that gates only when the forge requires it.
    expect(BOARD_CONFLICT_VERIFICATION).not.toMatch(/review round|CI still follow/i);
  });

  it("a saved retired default resolves to the current default", () => {
    expect(RETIRED_BOARD_MERGE_CONFLICT_PROMPTS.length).toBeGreaterThan(0);
    for (const retired of RETIRED_BOARD_MERGE_CONFLICT_PROMPTS) {
      const resolved = resolveBoardStageExecution(
        withMergePrompt(retired),
        BOARD_SEED_STAGE_IDS.merge,
      );
      expect(resolved.prompt).toBe(DEFAULT_BOARD_MERGE_CONFLICT_PROMPT);
    }
  });

  it("a customised conflict prompt passes through unchanged", () => {
    const custom = `${RETIRED_BOARD_MERGE_CONFLICT_PROMPTS[0]} Also run the e2e suite.`;
    const resolved = resolveBoardStageExecution(
      withMergePrompt(custom),
      BOARD_SEED_STAGE_IDS.merge,
    );
    expect(resolved.prompt).toBe(custom);
  });

  it("the retired list never contains the current default", () => {
    expect(RETIRED_BOARD_MERGE_CONFLICT_PROMPTS).not.toContain(DEFAULT_BOARD_MERGE_CONFLICT_PROMPT);
  });
});

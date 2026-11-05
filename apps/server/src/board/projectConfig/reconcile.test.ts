// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3o: reconciling a project's `t3o.json` (T3O-43). The reader caches by the
 * file's modification time, and the update is null whenever the resolved
 * config would not change the read model — so the sweep emits nothing on an
 * unchanged file, once on a change, and warnings ride the config.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  BoardStageId,
  EMPTY_BOARD_STATE,
  ProjectId,
  T3O_PROJECT_FILE_NAME,
  type BoardState,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { projectBoardEvent, type BoardReadModel } from "../projector.ts";
import { make as makeReader, type BoardProjectFileRead } from "./BoardProjectConfig.ts";
import { boardProjectStageConfigUpdate } from "./reconcile.ts";

const projectId = ProjectId.make("project-a");
const NOW = "2026-01-01T00:00:00.000Z";

/** git, reduced to the one call the reader makes. */
const gitCalls: Array<string> = [];
const StubGit = Layer.succeed(
  GitVcsDriver.GitVcsDriver,
  GitVcsDriver.GitVcsDriver.of({
    execute: (input: GitVcsDriver.ExecuteGitInput) => {
      gitCalls.push(input.args.join(" "));
      return Effect.succeed({
        exitCode: 0 as never,
        stdout: "deadbeef\n",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      });
    },
  } as unknown as GitVcsDriver.GitVcsDriver["Service"]),
);

/** Apply an update the way the decider and projector would. */
const apply = (board: BoardState, read: BoardProjectFileRead) =>
  Effect.gen(function* () {
    const update = boardProjectStageConfigUpdate({ board, projectId, read, now: NOW });
    if (update === null) return { board, emitted: false };
    const model = yield* projectBoardEvent(
      { board } as BoardReadModel,
      {
        sequence: 1,
        eventId: "event-1",
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: NOW,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "board.project-stage-config-set",
        payload: {
          projectId,
          config: update.config,
          upserts: update.stages,
          deletedStageIds: [],
        },
      } as never,
    );
    return { board: model.board!, emitted: true };
  });

describe("boardProjectStageConfigUpdate", () => {
  it.effect("emits nothing for a project with no file", () =>
    Effect.gen(function* () {
      const result = yield* apply(EMPTY_BOARD_STATE, { raw: null, warnings: [], source: null });
      assert.isFalse(result.emitted);
    }),
  );

  it.effect("emits once on a change, and nothing for the same file again", () =>
    Effect.gen(function* () {
      const read: BoardProjectFileRead = {
        raw: { stages: { remove: ["sprint", "review"] } },
        warnings: [],
        source: { path: "/repo/t3o.json", commitSha: "aaa" },
      };
      const first = yield* apply(EMPTY_BOARD_STATE, read);
      assert.isTrue(first.emitted);
      const config = first.board.projectStageConfigs?.[projectId];
      assert.deepStrictEqual(config?.removedStageIds, [BoardStageId.make("sprint")]);
      // Removing a role stage is ignored with a warning.
      assert.isTrue(config?.warnings.some((warning) => warning.includes("review role")));

      const again = yield* apply(first.board, read);
      assert.isFalse(again.emitted);
      // The checkout moving on with the file unchanged is not a change.
      const moved = yield* apply(first.board, {
        ...read,
        source: { path: "/repo/t3o.json", commitSha: "bbb" },
      });
      assert.isFalse(moved.emitted);

      const edited = yield* apply(first.board, {
        ...read,
        raw: { stages: { remove: [] } },
      });
      assert.isTrue(edited.emitted);
    }),
  );

  it.effect("emits nothing again when the file's keys are not in schema order", () =>
    Effect.gen(function* () {
      const read: BoardProjectFileRead = {
        raw: {
          stages: {
            add: [
              {
                prompt: "Audit it.",
                autoAdvance: true,
                after: "review",
                label: "Security",
                id: "security",
              },
            ],
            settings: {
              building: { autoAdvance: false, prompt: "Build it." },
              review: { phases: { triage: { prompt: "Triage it." } }, rounds: 2 },
            },
          },
        },
        warnings: [],
        source: { path: "/repo/t3o.json", commitSha: "aaa" },
      };
      const first = yield* apply(EMPTY_BOARD_STATE, read);
      assert.isTrue(first.emitted);
      const again = yield* apply(first.board, read);
      assert.isFalse(again.emitted);
    }),
  );

  it.effect("carries a read failure's warning", () =>
    Effect.gen(function* () {
      const result = yield* apply(EMPTY_BOARD_STATE, {
        raw: null,
        warnings: ["t3o.json is not valid JSON; ignored."],
        source: { path: "/repo/t3o.json", commitSha: null },
      });
      assert.isTrue(result.emitted);
      assert.deepStrictEqual(result.board.projectStageConfigs?.[projectId]?.warnings, [
        "t3o.json is not valid JSON; ignored.",
      ]);
    }),
  );

  it.effect("keeps the board's config when a restart finds the file broken", () =>
    Effect.gen(function* () {
      const good = yield* apply(EMPTY_BOARD_STATE, {
        raw: {
          stages: {
            remove: ["sprint"],
            add: [{ id: "security", label: "Security", after: "review" }],
          },
        },
        warnings: [],
        source: { path: "/repo/t3o.json", commitSha: "aaa" },
      });
      assert.isTrue(good.emitted);
      const before = good.board.projectStageConfigs?.[projectId];
      // What the reader returns on its first read of a broken file: no good
      // version in memory, so nothing to fall back to but the board.
      const broken = yield* apply(good.board, {
        raw: null,
        warnings: ["t3o.json is not valid JSON (x); ignored."],
        source: { path: "/repo/t3o.json", commitSha: "bbb" },
        unusable: "t3o.json is not valid JSON (x)",
      });
      const after = broken.board.projectStageConfigs?.[projectId];
      assert.deepStrictEqual(after?.removedStageIds, before?.removedStageIds);
      assert.deepStrictEqual(after?.addedStageIds, before?.addedStageIds);
      assert.deepStrictEqual(after?.warnings, [
        "t3o.json is not valid JSON (x). Using the version the board last loaded.",
      ]);
      assert.isTrue(
        broken.board.stages?.some((stage) => stage.stageId === before?.addedStageIds[0]),
      );
      // The same broken read again is not a change.
      assert.isFalse(
        (yield* apply(broken.board, {
          raw: null,
          warnings: ["t3o.json is not valid JSON (x); ignored."],
          source: { path: "/repo/t3o.json", commitSha: "bbb" },
          unusable: "t3o.json is not valid JSON (x)",
        })).emitted,
      );
    }),
  );
});

describe("BoardProjectConfig.read", () => {
  it.effect("reads through a cache keyed by the file's modification time", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-project-config-"));
      const file = NodePath.join(root, T3O_PROJECT_FILE_NAME);
      const reader = yield* makeReader;
      gitCalls.length = 0;

      assert.deepStrictEqual(yield* reader.read(root), { raw: null, warnings: [], source: null });

      NodeFS.writeFileSync(file, JSON.stringify({ stages: { remove: ["sprint"] } }));
      NodeFS.utimesSync(file, 1_000, 1_000);
      const first = yield* reader.read(root);
      assert.deepStrictEqual(first.raw, { stages: { remove: ["sprint"] } });
      assert.deepStrictEqual(first.source, { path: file, commitSha: "deadbeef" });
      const second = yield* reader.read(root);
      assert.strictEqual(second, first);
      assert.strictEqual(gitCalls.length, 1);

      NodeFS.writeFileSync(file, "{ not json");
      NodeFS.utimesSync(file, 2_000, 2_000);
      // One bad save keeps the last good version, so the pipeline holds.
      const broken = yield* reader.read(root);
      assert.deepStrictEqual(broken.raw, { stages: { remove: ["sprint"] } });
      assert.match(
        broken.warnings[0] ?? "",
        /^t3o\.json is not valid JSON \(.*\)\. Using the last version that could be read\.$/,
      );
      assert.strictEqual(gitCalls.length, 2);

      // Deleting the file is deliberate: the project goes back to global.
      NodeFS.rmSync(file);
      assert.deepStrictEqual(yield* reader.read(root), { raw: null, warnings: [], source: null });
      // And a broken file with no good version before it is no file plus a warning.
      NodeFS.writeFileSync(file, "{ not json");
      NodeFS.utimesSync(file, 3_000, 3_000);
      const fresh = yield* reader.read(root);
      assert.isNull(fresh.raw);
      assert.include(fresh.unusable ?? "", "not valid JSON");
      assert.match(fresh.warnings[0] ?? "", /not valid JSON \(.*\); ignored\.$/);

      NodeFS.rmSync(root, { recursive: true, force: true });
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, StubGit))),
  );
});

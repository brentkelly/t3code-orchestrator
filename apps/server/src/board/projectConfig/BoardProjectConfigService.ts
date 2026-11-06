/**
 * T3o: the service behind every project config RPC (T3O-49), built per
 * connection by `boardRpcHandlers`.
 *
 * It reads global settings, normalizes a delta against them (the decider has
 * no settings, and replay must not depend on today's), stamps the human
 * actor, and dispatches. Import and export read and write the committed
 * `t3o.json` through `BoardProjectFile`.
 */
import {
  BOARD_CONFIG_VERSION_MISMATCH,
  BoardSettingsCommandError,
  CommandId,
  DEFAULT_BOARD_SETTINGS,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  EMPTY_BOARD_STATE,
  boardProjectDeltaNewTexts,
  boardProjectDeltasEqual,
  boardProjectStageConfig,
  buildT3oProjectFile,
  normalizeBoardProjectDelta,
  resolveT3oProjectFile,
  type BoardActivityActor,
  type BoardProjectConfigDetail,
  type BoardProjectExportResult,
  type BoardProjectImportCandidate,
  type BoardProjectImportCandidatesInput,
  type BoardProjectImportInput,
  type BoardProjectImportResult,
  type BoardSettings,
  type BoardSettingsClientCommand,
  type BoardState,
  type ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import { BoardEngine } from "../BoardEngine.ts";
import type { BoardCommand } from "../decider.ts";
import { BoardProjectFile, type BoardProjectFileRead } from "./BoardProjectFile.ts";

export interface BoardProjectConfigServiceShape {
  readonly dispatch: (
    command: BoardSettingsClientCommand,
    actor: BoardActivityActor,
  ) => Effect.Effect<{ readonly sequence: number }, BoardSettingsCommandError>;
  readonly getConfig: (projectId: ProjectId) => Effect.Effect<BoardProjectConfigDetail>;
  readonly importCandidates: (
    input: BoardProjectImportCandidatesInput,
  ) => Effect.Effect<ReadonlyArray<BoardProjectImportCandidate>>;
  readonly importFile: (
    input: BoardProjectImportInput,
    actor: BoardActivityActor,
  ) => Effect.Effect<BoardProjectImportResult, BoardSettingsCommandError>;
  readonly exportFile: (
    projectId: ProjectId,
    actor: BoardActivityActor,
  ) => Effect.Effect<BoardProjectExportResult, BoardSettingsCommandError>;
}


/** A committed file people read and diff, so it is indented. */
const encodePrettyJson = (value: unknown) =>
  JSON.stringify(value, null, 2);

const toSettingsError = (cause: { readonly message: string }) =>
  new BoardSettingsCommandError({
    code: cause.message.includes(BOARD_CONFIG_VERSION_MISMATCH)
      ? "version-mismatch"
      : "detail" in cause
        ? "refused"
        : "internal",
    message:
      "detail" in cause && typeof cause.detail === "string" ? cause.detail : cause.message,
    cause,
  });

export const make = Effect.gen(function* () {
  const engine = yield* BoardEngine;
  const serverSettings = yield* ServerSettingsService;
  const projectFile = yield* BoardProjectFile;
  const crypto = yield* Crypto.Crypto;

  const readBoard = engine.getReadModel.pipe(
    Effect.map((model): BoardState => model.board ?? EMPTY_BOARD_STATE),
  );
  const settings: Effect.Effect<BoardSettings> = serverSettings.getSettings.pipe(
    Effect.map((value) => value.board ?? DEFAULT_BOARD_SETTINGS),
    Effect.catchCause(() => Effect.succeed(DEFAULT_BOARD_SETTINGS)),
  );
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const configOf = (board: BoardState, projectId: ProjectId) =>
    boardProjectStageConfig(board, projectId) ?? EMPTY_BOARD_PROJECT_STAGE_CONFIG;

  const send = (command: BoardCommand) =>
    engine.dispatch(command).pipe(Effect.mapError(toSettingsError));

  const dispatch: BoardProjectConfigServiceShape["dispatch"] = (command, actor) =>
    Effect.gen(function* () {
      if (command.type === "board.project.set-stage-override" && command.patch !== null) {
        const board = yield* readBoard;
        const normalized = normalizeBoardProjectDelta({
          board,
          settings: yield* settings,
          delta: { stageSwitches: {}, overrides: { [command.stageId]: command.patch }, ci: { steps: [] } },
        });
        return yield* send({ ...command, actor, patch: normalized.overrides[command.stageId] ?? null });
      }
      return yield* send({ ...command, actor } as BoardCommand);
    });

  /** What importing a read would set, normalized, with what it creates. */
  const resolveRead = (
    board: BoardState,
    globalSettings: BoardSettings,
    projectId: ProjectId,
    read: Extract<BoardProjectFileRead, { kind: "found" }>,
    now: string,
  ) => {
    const resolved = resolveT3oProjectFile({
      raw: read.raw,
      board,
      projectId,
      now,
      warnings: read.warnings,
    });
    const delta = normalizeBoardProjectDelta({
      board,
      settings: globalSettings,
      delta: resolved.delta,
      extraStages: resolved.createStages,
    });
    return { delta, createStages: resolved.createStages };
  };

  const candidateFor = (
    board: BoardState,
    globalSettings: BoardSettings,
    projectId: ProjectId,
    read: BoardProjectFileRead,
    now: string,
  ): BoardProjectImportCandidate => {
    const base = { projectId, asOfLastFetch: false, dismissed: false, reason: null, preview: null };
    if (read.kind === "unavailable") {
      return { ...base, status: "unavailable", blobSha: null, reason: read.reason };
    }
    if (read.kind === "none") {
      return { ...base, status: "none", blobSha: null, asOfLastFetch: read.asOfLastFetch };
    }
    const current = configOf(board, projectId);
    const next = resolveRead(board, globalSettings, projectId, read, now);
    const currentNormalized = normalizeBoardProjectDelta({
      board,
      settings: globalSettings,
      delta: current,
    });
    const matches =
      next.createStages.length === 0 && boardProjectDeltasEqual(next.delta, currentNormalized);
    return {
      ...base,
      status: matches ? "matches" : "differs",
      blobSha: read.blobSha,
      asOfLastFetch: read.asOfLastFetch,
      dismissed: current.dismissedImportSha === read.blobSha,
      preview: matches
        ? null
        : {
            delta: next.delta,
            createStages: next.createStages.map((stage) => ({
              stageId: stage.stageId,
              label: stage.label,
            })),
            texts: boardProjectDeltaNewTexts(current, next.delta),
          },
    };
  };

  const importCandidates: BoardProjectConfigServiceShape["importCandidates"] = (input) =>
    Effect.gen(function* () {
      const board = yield* readBoard;
      const globalSettings = yield* settings;
      const now = yield* nowIso;
      const reads = yield* Effect.forEach(
        input.projectIds,
        (projectId) =>
          projectFile.readCommitted(projectId, { refresh: input.refresh === true }).pipe(
            Effect.timeoutOrElse({
              duration: "45 seconds",
              orElse: () =>
                Effect.succeed<BoardProjectFileRead>({
                  kind: "unavailable",
                  reason: "Reading t3o.json timed out.",
                }),
            }),
          ),
        { concurrency: 4 },
      );
      return input.projectIds.map((projectId, index) =>
        candidateFor(board, globalSettings, projectId, reads[index]!, now),
      );
    });

  const importFile: BoardProjectConfigServiceShape["importFile"] = (input, actor) =>
    Effect.gen(function* () {
      const read = yield* projectFile.readCommitted(input.projectId, { refresh: true });
      if (read.kind === "unavailable") {
        return { outcome: "unavailable", reason: read.reason } as const;
      }
      if (read.kind === "none" || read.blobSha !== input.blobSha) {
        return { outcome: "file-changed" } as const;
      }
      const board = yield* readBoard;
      if (configOf(board, input.projectId).version !== input.expectedConfigVersion) {
        return { outcome: "version-mismatch" } as const;
      }
      const now = yield* nowIso;
      const next = resolveRead(board, yield* settings, input.projectId, read, now);
      const result = yield* send({
        type: "board.project.import-file",
        commandId: CommandId.make(`project-import:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`),
        projectId: input.projectId,
        blobSha: read.blobSha,
        delta: next.delta,
        createStages: next.createStages,
        expectedConfigVersion: input.expectedConfigVersion,
        actor,
        createdAt: now,
      });
      return { outcome: "imported", sequence: result.sequence } as const;
    });

  const exportFile: BoardProjectConfigServiceShape["exportFile"] = (projectId, actor) =>
    Effect.gen(function* () {
      const board = yield* readBoard;
      const content = `${encodePrettyJson(
        buildT3oProjectFile({ board, config: configOf(board, projectId) }),
      )}\n`;
      const written = yield* projectFile.write(projectId, content);
      if (written.kind === "unavailable") {
        return { outcome: "download", content, reason: written.reason } as const;
      }
      // The file now matches the board, so its notice stays away once committed.
      if (written.blobSha !== null) {
        yield* send({
          type: "board.project.dismiss-import",
          commandId: CommandId.make(`project-export:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`),
          projectId,
          blobSha: written.blobSha,
          actor,
          createdAt: yield* nowIso,
        });
      }
      return { outcome: "written", path: written.path, content } as const;
    });

  const getConfig: BoardProjectConfigServiceShape["getConfig"] = (projectId) =>
    readBoard.pipe(Effect.map((board) => ({ projectId, config: configOf(board, projectId) })));

  return {
    dispatch,
    getConfig,
    importCandidates,
    importFile,
    exportFile,
  } satisfies BoardProjectConfigServiceShape;
});

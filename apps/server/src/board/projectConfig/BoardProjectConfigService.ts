/**
 * The service behind every project config RPC. It normalizes a delta against
 * global settings before dispatch, since the decider has none and replay must
 * not depend on today's.
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
  type BoardScheduleImportOutcome,
  type T3oFileSchedule,
  type BoardSettings,
  type BoardSettingsClientCommand,
  type BoardState,
  type ProjectId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSettingsService } from "../../serverSettings.ts";
import { BoardEngine } from "../BoardEngine.ts";
import type { BoardCommand } from "../decider.ts";
import { BoardProjectFile, type BoardProjectFileRead } from "./BoardProjectFile.ts";
import { BoardSchedules, type BoardSchedulePreview } from "../schedules/BoardSchedules.ts";

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
    options?: { readonly excludeHandMade: boolean },
  ) => Effect.Effect<BoardProjectExportResult, BoardSettingsCommandError>;
}

/** A committed file people read and diff, so it is indented. */
const encodePrettyJson = (value: unknown) => JSON.stringify(value, null, 2);

const toSettingsError = (cause: { readonly message: string }) =>
  new BoardSettingsCommandError({
    code: cause.message.includes(BOARD_CONFIG_VERSION_MISMATCH)
      ? "version-mismatch"
      : "detail" in cause
        ? "refused"
        : "internal",
    message: "detail" in cause && typeof cause.detail === "string" ? cause.detail : cause.message,
    cause,
  });

export const make = Effect.gen(function* () {
  const engine = yield* BoardEngine;
  const serverSettings = yield* ServerSettingsService;
  const projectFile = yield* BoardProjectFile;
  const crypto = yield* SecureRandom.SecureRandom;
  // T3o: t3o.json schedules (T3O-117); absent on a harness without them.
  const schedules = Option.getOrNull(yield* Effect.serviceOption(BoardSchedules));
  const emptyPreview: BoardSchedulePreview = { entries: [], warnings: [] };
  /** The file's schedule diff against the stored definitions, never the live tasks. */
  const schedulePreview = (
    projectId: ProjectId,
    fileSchedules: ReadonlyArray<T3oFileSchedule> | null,
  ) =>
    schedules === null || fileSchedules === null
      ? Effect.succeed(emptyPreview)
      : schedules.previewImport(projectId, fileSchedules);

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

  const dispatch: BoardProjectConfigServiceShape["dispatch"] = Effect.fn(
    "BoardProjectConfigService.dispatch",
  )(function* (command, actor) {
    if (command.type === "board.project.set-stage-override" && command.patch !== null) {
      const board = yield* readBoard;
      const normalized = normalizeBoardProjectDelta({
        board,
        settings: yield* settings,
        delta: {
          stageSwitches: {},
          overrides: { [command.stageId]: command.patch },
          ci: { steps: [] },
        },
      });
      return yield* send({
        ...command,
        actor,
        patch: normalized.overrides[command.stageId] ?? null,
      });
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
    return { delta, createStages: resolved.createStages, schedules: resolved.schedules };
  };

  const candidateFor = Effect.fn("BoardProjectConfigService.candidateFor")(function* (
    board: BoardState,
    globalSettings: BoardSettings,
    projectId: ProjectId,
    read: BoardProjectFileRead,
    now: string,
  ) {
    const base = { projectId, asOfLastFetch: false, dismissed: false, reason: null, preview: null };
    if (read.kind === "unavailable") {
      return {
        ...base,
        status: "unavailable",
        blobSha: null,
        reason: read.reason,
      } satisfies BoardProjectImportCandidate;
    }
    if (read.kind === "none") {
      return {
        ...base,
        status: "none",
        blobSha: null,
        asOfLastFetch: read.asOfLastFetch,
      } satisfies BoardProjectImportCandidate;
    }
    const current = configOf(board, projectId);
    const next = resolveRead(board, globalSettings, projectId, read, now);
    const currentNormalized = normalizeBoardProjectDelta({
      board,
      settings: globalSettings,
      delta: current,
    });
    const pipelineMatches =
      next.createStages.length === 0 && boardProjectDeltasEqual(next.delta, currentNormalized);
    const scheduleDiff = yield* schedulePreview(projectId, next.schedules).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Couldn't compare the file's schedules", { projectId, error }).pipe(
          Effect.as(emptyPreview),
        ),
      ),
    );
    const matches = pipelineMatches && scheduleDiff.entries.length === 0;
    return {
      ...base,
      status: matches ? "matches" : "differs",
      blobSha: read.blobSha,
      asOfLastFetch: read.asOfLastFetch,
      dismissed: current.dismissedImportSha === read.blobSha,
      fileScheduleCount: next.schedules?.length ?? 0,
      preview: matches
        ? null
        : {
            delta: {
              ...next.delta,
              warnings: [...next.delta.warnings, ...scheduleDiff.warnings],
            },
            createStages: next.createStages.map((stage) => ({
              stageId: stage.stageId,
              label: stage.label,
            })),
            texts: boardProjectDeltaNewTexts(current, next.delta),
            schedules: scheduleDiff.entries.map((entry) => entry.row),
            schedulesOnly: pipelineMatches,
          },
    } satisfies BoardProjectImportCandidate;
  });

  const importCandidates: BoardProjectConfigServiceShape["importCandidates"] = Effect.fn(
    "BoardProjectConfigService.importCandidates",
  )(function* (input) {
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
    return yield* Effect.forEach(input.projectIds, (projectId, index) =>
      candidateFor(board, globalSettings, projectId, reads[index]!, now),
    );
  });

  const importFile: BoardProjectConfigServiceShape["importFile"] = Effect.fn(
    "BoardProjectConfigService.importFile",
  )(function* (input, actor) {
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
    const preview = yield* schedulePreview(input.projectId, next.schedules).pipe(
      Effect.mapError((error) => toSettingsError(error)),
    );
    // Placements apply only to the rows the import changes; omitted is Don't schedule.
    const placements = Object.fromEntries(
      preview.entries.map((entry) => {
        const chosen = input.schedulePlacements;
        // Own keys only: a schedule id such as "constructor" must not read the prototype.
        return [
          entry.row.fileId,
          chosen !== undefined && Object.hasOwn(chosen, entry.row.fileId)
            ? (chosen[entry.row.fileId] ?? null)
            : null,
        ];
      }),
    );
    for (const placement of Object.values(placements)) {
      const refusal = schedules === null ? null : yield* schedules.placementRefusal(placement);
      if (refusal !== null) {
        return yield* new BoardSettingsCommandError({ code: "refused", message: refusal });
      }
    }
    // Dispatched even when only schedules differ: the version bump lets one of two
    // concurrent imports write the store.
    const result = yield* send({
      type: "board.project.import-file",
      commandId: CommandId.make(`project-import:${yield* crypto.uuidV4().pipe(Effect.orDie)}`),
      projectId: input.projectId,
      blobSha: read.blobSha,
      delta: next.delta,
      createStages: next.createStages,
      expectedConfigVersion: input.expectedConfigVersion,
      actor,
      createdAt: now,
    });
    if (schedules === null || preview.entries.length === 0) {
      return { outcome: "imported", sequence: result.sequence } as const;
    }
    // The board config is never rolled back; a failed store write heals on the next import.
    const outcome: BoardScheduleImportOutcome = yield* schedules
      .applyImport(input.projectId, preview, placements)
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            setUp: 0,
            stopped: 0,
            deleted: 0,
            failures: preview.entries
              .filter((entry) => entry.row.kind !== "delete")
              .map((entry) => ({
                fileId: entry.row.fileId,
                title: entry.row.title,
                environmentId: placements[entry.row.fileId] ?? null,
                reason: error.message,
              })),
          }),
        ),
      );
    return { outcome: "imported", sequence: result.sequence, schedules: outcome } as const;
  });

  const exportFile: BoardProjectConfigServiceShape["exportFile"] = Effect.fn(
    "BoardProjectConfigService.exportFile",
  )(function* (projectId, actor, options) {
    const board = yield* readBoard;
    const exported =
      schedules === null
        ? { schedules: undefined, handMade: [], warnings: [] }
        : yield* schedules
            .exportSchedules(projectId, { excludeHandMade: options?.excludeHandMade === true })
            .pipe(Effect.mapError((error) => toSettingsError(error)));
    const extras = {
      ...(exported.handMade.length === 0 ? {} : { handMade: exported.handMade }),
      ...(exported.warnings.length === 0 ? {} : { warnings: exported.warnings }),
    };
    const content = `${encodePrettyJson(
      buildT3oProjectFile({
        board,
        config: configOf(board, projectId),
        schedules: exported.schedules,
      }),
    )}\n`;
    const written = yield* projectFile.write(projectId, content);
    if (written.kind === "unavailable") {
      return { outcome: "download", content, reason: written.reason, ...extras } as const;
    }
    // The file now matches the board, so its notice stays away once committed.
    if (written.blobSha !== null) {
      yield* send({
        type: "board.project.dismiss-import",
        commandId: CommandId.make(`project-export:${yield* crypto.uuidV4().pipe(Effect.orDie)}`),
        projectId,
        blobSha: written.blobSha,
        actor,
        createdAt: yield* nowIso,
      });
    }
    return { outcome: "written", path: written.path, content, ...extras } as const;
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

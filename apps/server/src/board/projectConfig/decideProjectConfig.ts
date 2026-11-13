/**
 * Every project command emits `board.project-stage-config-set` with the whole
 * new delta, so projector, SQL projection and client reducer apply one shape.
 */
import {
  BOARD_CI_RUNNABLE_STEP_KINDS,
  BOARD_CONFIG_VERSION_MISMATCH,
  BOARD_SEED_STAGE_IDS,
  BOARD_SYSTEM_ACTOR,
  EMPTY_BOARD_PROJECT_RESOURCES,
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  EventId,
  boardCiStepsRefusal,
  boardProjectStageConfig,
  boardStageById,
  boardStageDefaultForProjects,
  boardStageOrderViolation,
  boardStages,
  isBoardStageSwitchable,
  isEmptyBoardProjectResources,
  normalizeBoardReadinessPath,
  withBoardProjectConfigVersion,
  type BoardActivityActor,
  type BoardProjectResources,
  type BoardProjectStageConfig,
  type BoardStageDefinition,
  type BoardState,
  type ProjectId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import type { BoardCommand, PlannedBoardEvent } from "../decider.ts";
import { BoardCommandInvariantError } from "../errors.ts";

type ProjectCommand = Extract<BoardCommand, { type: `board.project.${string}` }>;
type ConfigCause = NonNullable<
  Extract<PlannedBoardEvent, { type: "board.project-stage-config-set" }>["payload"]["cause"]
>;

const refuse = (command: BoardCommand, detail: string) =>
  new BoardCommandInvariantError({ commandType: command.type, detail });

/** The event recording a project's new delta. */
const projectConfigEvent = Effect.fn("projectConfigEvent")(function* (input: {
  readonly command: Pick<BoardCommand, "commandId" | "createdAt">;
  readonly projectId: ProjectId;
  readonly config: BoardProjectStageConfig;
  readonly cause: ConfigCause;
}) {
  const crypto = yield* SecureRandom.SecureRandom;
  return {
    eventId: EventId.make(yield* crypto.uuidV4()),
    aggregateKind: "project" as const,
    aggregateId: input.projectId,
    occurredAt: input.command.createdAt,
    commandId: input.command.commandId,
    causationEventId: null,
    correlationId: input.command.commandId,
    metadata: {},
    type: "board.project-stage-config-set" as const,
    payload: {
      projectId: input.projectId,
      config: input.config,
      upserts: [],
      deletedStageIds: [],
      cause: input.cause,
    },
  } satisfies PlannedBoardEvent;
});

function nextConfig(
  current: BoardProjectStageConfig,
  change: Partial<
    Pick<BoardProjectStageConfig, "stageSwitches" | "overrides" | "ci" | "warnings" | "resources">
  >,
  changedBy: { readonly actor: BoardActivityActor; readonly at: string } | null,
): BoardProjectStageConfig {
  const resources =
    change.resources === undefined
      ? current.resources
      : withBoardOwnedResources(change.resources, current.resources);
  return withBoardProjectConfigVersion({
    stageSwitches: change.stageSwitches ?? current.stageSwitches,
    overrides: change.overrides ?? current.overrides,
    ci: change.ci ?? current.ci,
    dismissedImportSha: current.dismissedImportSha,
    // An import's warnings describe the file as imported; any edit moves on from it.
    warnings: change.warnings ?? [],
    lastChangedBy: changedBy ?? current.lastChangedBy,
    ...(isEmptyBoardProjectResources(resources) ? {} : { resources }),
  });
}

/** T3o (T3O-87): an edit or an import never overwrites what the board learned, and an import
    (which carries no Pin declared) keeps the project's pins. */
function withBoardOwnedResources(
  next: BoardProjectResources,
  current: BoardProjectResources | undefined,
): BoardProjectResources {
  const { learned: _sent, ...edited } = next;
  const pinDeclared = edited.pinDeclared ?? current?.pinDeclared;
  return {
    ...edited,
    ...(pinDeclared === undefined || pinDeclared.length === 0 ? {} : { pinDeclared }),
    ...(current?.learned === undefined ? {} : { learned: current.learned }),
  };
}

function withoutKey<V>(record: Readonly<Record<string, V>>, key: string): Record<string, V> {
  const { [key]: _removed, ...rest } = record;
  return rest;
}

/** A switch that equals the stage's default is not a difference. */
function setSwitch(
  switches: Readonly<Record<string, boolean>>,
  stage: BoardStageDefinition,
  on: boolean | null,
): Record<string, boolean> {
  if (on === null || on === boardStageDefaultForProjects(stage)) {
    return withoutKey(switches, stage.stageId);
  }
  return { ...switches, [stage.stageId]: on };
}

export const decideProjectConfigCommand = Effect.fn("decideProjectConfigCommand")(function* (
  board: BoardState,
  command: ProjectCommand,
): Effect.fn.Return<
  ReadonlyArray<PlannedBoardEvent>,
  BoardCommandInvariantError | PlatformError.PlatformError,
  SecureRandom.SecureRandom
> {
  const current =
    boardProjectStageConfig(board, command.projectId) ?? EMPTY_BOARD_PROJECT_STAGE_CONFIG;
  const expected = "expectedConfigVersion" in command ? command.expectedConfigVersion : undefined;
  if (expected !== undefined && expected !== current.version) {
    return yield* refuse(command, BOARD_CONFIG_VERSION_MISMATCH);
  }
  const changedBy = {
    actor: ("actor" in command ? command.actor : undefined) ?? BOARD_SYSTEM_ACTOR,
    at: command.createdAt,
  };
  const emit = (config: BoardProjectStageConfig, cause: ConfigCause) =>
    projectConfigEvent({ command, projectId: command.projectId, config, cause }).pipe(
      Effect.map((event) => [event]),
    );

  switch (command.type) {
    case "board.project.set-stage-switch": {
      const stage = boardStageById(board, command.stageId);
      if (stage === null)
        return yield* refuse(command, `Stage '${command.stageId}' does not exist.`);
      if (!isBoardStageSwitchable(board, stage)) {
        return yield* refuse(
          command,
          `${stage.label} is on for every project and can't be switched off.`,
        );
      }
      return yield* emit(
        nextConfig(
          current,
          { stageSwitches: setSwitch(current.stageSwitches, stage, command.on) },
          changedBy,
        ),
        stage.stageId === BOARD_SEED_STAGE_IDS.ci ? "ci-enabled" : "switch",
      );
    }
    case "board.project.set-stage-override": {
      const stage = boardStageById(board, command.stageId);
      if (stage === null)
        return yield* refuse(command, `Stage '${command.stageId}' does not exist.`);
      const overrides =
        command.patch === null || Object.keys(command.patch).length === 0
          ? withoutKey(current.overrides, stage.stageId)
          : { ...current.overrides, [stage.stageId]: command.patch };
      return yield* emit(nextConfig(current, { overrides }, changedBy), "override");
    }
    case "board.project.set-ci-steps": {
      const refusal = boardCiStepsRefusal(command.steps, {
        scriptOnly: !BOARD_CI_RUNNABLE_STEP_KINDS.has("agent"),
      });
      if (refusal !== null) return yield* refuse(command, refusal);
      return yield* emit(
        nextConfig(current, { ci: { ...current.ci, steps: command.steps } }, changedBy),
        "ci-steps",
      );
    }
    case "board.project.set-ci-stop-on-failure": {
      const { stopOnFailure: _previous, ...rest } = current.ci;
      return yield* emit(
        nextConfig(
          current,
          { ci: command.stopOnFailure ? rest : { ...rest, stopOnFailure: false } },
          changedBy,
        ),
        "ci-stop-on-failure",
      );
    }
    case "board.project.set-resources": {
      const { resources } = command;
      if (
        resources.readinessPath !== null &&
        normalizeBoardReadinessPath(resources.readinessPath) === null
      ) {
        return yield* refuse(
          command,
          "The readiness script's path must be relative and inside the repository.",
        );
      }
      return yield* emit(
        nextConfig(
          current,
          {
            resources: {
              ...resources,
              readinessPath:
                resources.readinessPath === null
                  ? null
                  : normalizeBoardReadinessPath(resources.readinessPath),
            },
          },
          changedBy,
        ),
        "resources",
      );
    }
    case "board.project.record-learned": {
      // The board's own write: no actor, warnings kept, and the version unmoved.
      const resources = {
        ...(current.resources ?? EMPTY_BOARD_PROJECT_RESOURCES),
        learned: command.learned,
      };
      return yield* emit(withBoardProjectConfigVersion({ ...current, resources }), "resources");
    }
    case "board.project.set-ci-enabled": {
      const ci = boardStageById(board, BOARD_SEED_STAGE_IDS.ci);
      if (ci === null) return yield* refuse(command, "This board has no CI stage.");
      return yield* emit(
        nextConfig(
          current,
          { stageSwitches: setSwitch(current.stageSwitches, ci, command.on) },
          changedBy,
        ),
        "ci-enabled",
      );
    }
    case "board.project.reset": {
      return yield* emit(
        nextConfig(
          current,
          { stageSwitches: {}, overrides: {}, ci: { steps: [] }, warnings: [] },
          changedBy,
        ),
        "reset",
      );
    }
    case "board.project.dismiss-import": {
      return yield* emit(
        withBoardProjectConfigVersion({ ...current, dismissedImportSha: command.blobSha }),
        "dismiss-import",
      );
    }
    case "board.project.import-file": {
      const events: PlannedBoardEvent[] = [];
      const crypto = yield* SecureRandom.SecureRandom;
      for (const stage of command.createStages) {
        if (boardStageById(board, stage.stageId) !== null) {
          return yield* refuse(command, `Stage '${stage.stageId}' already exists; check again.`);
        }
        if (stage.role !== null)
          return yield* refuse(command, "An import can't create a role stage.");
      }
      const violation = boardStageOrderViolation([...boardStages(board), ...command.createStages]);
      if (violation !== null) return yield* refuse(command, `Can't import: ${violation}.`);
      for (const stage of command.createStages) {
        events.push({
          eventId: EventId.make(yield* crypto.uuidV4()),
          aggregateKind: "stage",
          aggregateId: stage.stageId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          causationEventId: null,
          correlationId: command.commandId,
          metadata: {},
          type: "board.stage-created",
          payload: { stageId: stage.stageId, stage },
        });
      }
      const nextBoard: BoardState = {
        ...board,
        stages: [...boardStages(board), ...command.createStages],
      };
      for (const stageId of Object.keys(command.delta.stageSwitches)) {
        const stage = boardStageById(nextBoard, stageId as BoardStageDefinition["stageId"]);
        if (stage === null || !isBoardStageSwitchable(nextBoard, stage)) {
          return yield* refuse(
            command,
            `The import switches '${stageId}', which can't be switched.`,
          );
        }
      }
      const refusal = boardCiStepsRefusal(command.delta.ci.steps, {
        scriptOnly: !BOARD_CI_RUNNABLE_STEP_KINDS.has("agent"),
      });
      if (refusal !== null) return yield* refuse(command, refusal);
      events.push(
        yield* projectConfigEvent({
          command,
          projectId: command.projectId,
          config: nextConfig(
            current,
            {
              stageSwitches: command.delta.stageSwitches,
              overrides: command.delta.overrides,
              ci: command.delta.ci,
              warnings: command.delta.warnings,
              ...(command.delta.resources === undefined
                ? {}
                : { resources: command.delta.resources }),
            },
            changedBy,
          ),
          cause: "import",
        }),
      );
      return events;
    }
  }
});

/** The configs a deleted stage leaves behind: pruned of it, re-versioned. */
export const pruneDeletedStage = Effect.fn("pruneDeletedStage")(function* (
  board: BoardState,
  command: Pick<BoardCommand, "commandId" | "createdAt">,
  stageId: string,
) {
  const events: PlannedBoardEvent[] = [];
  for (const [projectId, config] of Object.entries(board.projectStageConfigs ?? {})) {
    if (!(stageId in config.stageSwitches) && !(stageId in config.overrides)) continue;
    events.push(
      yield* projectConfigEvent({
        command,
        projectId: projectId as ProjectId,
        config: nextConfig(
          config,
          {
            stageSwitches: withoutKey(config.stageSwitches, stageId),
            overrides: withoutKey(config.overrides, stageId),
          },
          null,
        ),
        cause: "stage-deleted",
      }),
    );
  }
  return events;
});

/** The config a stage made for one project starts with there: switched on. */
export const switchOnForProject = Effect.fn("switchOnForProject")(function* (
  board: BoardState,
  command: Pick<BoardCommand, "commandId" | "createdAt"> & {
    readonly actor?: BoardActivityActor | undefined;
  },
  projectId: ProjectId,
  stage: BoardStageDefinition,
) {
  const current = boardProjectStageConfig(board, projectId) ?? EMPTY_BOARD_PROJECT_STAGE_CONFIG;
  return yield* projectConfigEvent({
    command,
    projectId,
    config: nextConfig(
      current,
      { stageSwitches: setSwitch(current.stageSwitches, stage, true) },
      command.actor === undefined ? null : { actor: command.actor, at: command.createdAt },
    ),
    cause: "stage-created",
  });
});

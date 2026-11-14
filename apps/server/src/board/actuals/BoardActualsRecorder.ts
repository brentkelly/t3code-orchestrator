/**
 * T3o (T3O-87): the board's side of measured actuals. A sweep stores each running heavy step's
 * figures so far, ends the steps that stopped, and relearns their projects' baselines. A worker
 * out of reach keeps its rows open; one that lost a key (a restart) leaves the row partial.
 */
import {
  BOARD_LEARNED_WINDOW_DAYS,
  BOARD_LOCAL_WORKER_ID,
  CommandId,
  EMPTY_BOARD_STATE,
  EMPTY_BOARD_WORKERS_STATE,
  type EnvironmentId,
  boardAgentActualsSkipReason,
  boardCardActualsSample,
  boardCardEffectiveSize,
  boardCardEffectiveWorkerId,
  boardCardPlacementTarget,
  boardProjectLearned,
  boardProjectLearnedEqual,
  boardProjectStageConfig,
  boardRepositoryGroupingKey,
  boardStepNotMeasured,
  boardThreadLinkWorkerId,
  type BoardCard,
  type BoardCardId,
  type BoardCommand,
  type BoardResourceProfile,
  type BoardState,
  type BoardStepReading,
  type BoardWorkerActualsInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import { BoardEngine } from "../BoardEngine.ts";
import { boardWorkerReadyForProject } from "../placement/placementRanking.ts";
import { ThreadGateway } from "../ThreadGateway.ts";
import { BoardPlacement, boardPlacementGate } from "../workers/BoardPlacement.ts";
import { BoardCapacityClient } from "../capacity/BoardCapacityClient.ts";
import { boardSetupActualsKey } from "../capacity/cardSetup.ts";
import { BoardUsageRecorder } from "../usage/BoardUsageRecorder.ts";
import { WorkerConnections } from "../workers/WorkerConnections.ts";
import { BoardActualsMeter } from "./BoardActualsMeter.ts";
import {
  hasActualsRow,
  listCardActualsRows,
  listEndedActualsRows,
  listOpenActualsRows,
  upsertActualsRow,
  type BoardStoredActualsRow,
} from "./boardActualsStore.ts";

/** How often running steps are read. */
const SWEEP_INTERVAL = "15 seconds";
/** A row whose worker stayed out of reach this long is closed partial. */
const OPEN_ROW_LAPSE_MS = 24 * 60 * 60_000;

/** The relay to a step's worker: its reading, null when it has none, or "unreachable". */
export type BoardActualsRelay = (
  workerId: string,
  input: BoardWorkerActualsInput,
) => Effect.Effect<BoardStepReading | null | "unreachable">;

export interface BoardActualsRecorderDeps {
  readonly sql: SqlClient.SqlClient;
  readonly readBoard: Effect.Effect<BoardState>;
  readonly dispatch: (command: BoardCommand) => Effect.Effect<void>;
  readonly commandId: (tag: string) => Effect.Effect<CommandId>;
  readonly nowIso: Effect.Effect<string>;
  readonly relay: BoardActualsRelay;
  /** The declared capacity of every worker ready for the project now, for the unplaceable check. */
  readonly readyWorkers: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyArray<BoardResourceProfile>>;
  /** After a card's rows changed: an open card re-reads its detail. */
  readonly publish: (cardId: BoardCardId) => Effect.Effect<void>;
}

/** A heavy step running now, as the sweep found it. */
interface ActiveStep {
  readonly card: BoardCard;
  readonly stepKey: string;
  readonly kind: BoardStoredActualsRow["kind"];
  readonly stepId: string | null;
  readonly label: string;
  readonly workerId: string;
  readonly input: BoardWorkerActualsInput;
  /** Not measurable at all (the provider runs no scope of its own). */
  readonly skipReason: string | null;
}

const workerOf = (_board: BoardState, card: BoardCard): string =>
  boardCardPlacementTarget(card) ?? card.placedWorkerId ?? boardCardEffectiveWorkerId(card);

function activeSteps(board: BoardState): ReadonlyArray<ActiveStep> {
  const steps: Array<ActiveStep> = [];
  for (const card of board.cards) {
    if (card.archivedAt !== null || card.group !== null) continue;
    const state = (board.stepStates ?? []).find((candidate) => candidate.cardId === card.id);
    if (
      state !== undefined &&
      state.mode === "build" &&
      (state.status === "running" || state.status === "completing") &&
      state.threadId !== null
    ) {
      const link = card.threadLinks.find((candidate) => candidate.threadId === state.threadId);
      steps.push({
        card,
        stepKey: `thread:${state.threadId}`,
        kind: "agent",
        stepId: link?.role ?? state.stepId,
        label: state.stepLabel ?? state.stageLabel ?? state.stepId,
        workerId: link === undefined ? workerOf(board, card) : boardThreadLinkWorkerId(link),
        input: { op: "read", key: `thread:${state.threadId}`, threadId: state.threadId },
        skipReason: boardAgentActualsSkipReason(state.providerInstanceId),
      });
    }
    const ci = card.ci;
    if (ci !== null && (ci.phase === "queued" || ci.phase === "running")) {
      steps.push({
        card,
        stepKey: `ci:${ci.runId}`,
        kind: "ci",
        stepId: null,
        label: `CI pass ${ci.entry}`,
        workerId: workerOf(board, card),
        input: { op: "read", key: `ci:${ci.runId}` },
        skipReason: null,
      });
    }
    const setup = card.resources?.setup ?? null;
    const worktreePath = card.worktree?.path ?? null;
    if (setup !== null && setup.status === "running" && worktreePath !== null) {
      steps.push({
        card,
        stepKey: `setup:${setup.startedAt}`,
        kind: "setup",
        stepId: null,
        label: "Setup",
        workerId: setup.workerId,
        input: { op: "read", key: boardSetupActualsKey(worktreePath, setup.startedAt) },
        skipReason: null,
      });
    }
  }
  return steps;
}

/**
 * A resumed agent step is a new run on its worker (a pause ended the last one), stored as a
 * segment `thread:<id>#<n>` beside the first so neither overwrites the other.
 */
const baseStepKeyOf = (stepKey: string) => stepKey.replace(/#\d+$/, "");

/** The worker key a stored row is read under. */
function workerKeyOf(row: BoardStoredActualsRow, card: BoardCard | undefined): string | null {
  if (row.kind !== "setup") return baseStepKeyOf(row.stepKey);
  const worktreePath = card?.worktree?.path ?? null;
  return worktreePath === null
    ? null
    : boardSetupActualsKey(worktreePath, row.stepKey.slice("setup:".length));
}

export const makeBoardActualsRecorder = (deps: BoardActualsRecorderDeps) => {
  const learn = Effect.fn("BoardActualsRecorder.learn")(function* (projectId: ProjectId) {
    const board = yield* deps.readBoard;
    const now = yield* deps.nowIso;
    const cards = board.cards.filter((card) => card.projectId === projectId && card.group === null);
    const since = DateTime.formatIso(
      DateTime.makeUnsafe(Date.parse(now) - BOARD_LEARNED_WINDOW_DAYS * 24 * 60 * 60_000),
    );
    const rows = yield* listEndedActualsRows(
      deps.sql,
      cards.map((card) => card.id),
      since,
    );
    const samples = cards.flatMap((card) => {
      const sample = boardCardActualsSample(
        rows.filter((row) => row.cardId === card.id),
        boardCardEffectiveSize(card.resources?.sizing),
      );
      return sample === null ? [] : [sample];
    });
    const resources = boardProjectStageConfig(board, projectId)?.resources;
    const learned = boardProjectLearned({
      samples,
      resources,
      readyWorkers: yield* deps.readyWorkers(projectId),
      nowIso: now,
    });
    if (resources?.learned === undefined && samples.length === 0) return;
    if (boardProjectLearnedEqual(resources?.learned, learned)) return;
    yield* deps.dispatch({
      type: "board.project.record-learned",
      commandId: yield* deps.commandId("record-learned"),
      projectId,
      learned,
      createdAt: now,
    });
  });

  const sweep = Effect.fn("BoardActualsRecorder.sweep")(function* () {
    const board = yield* deps.readBoard;
    const now = yield* deps.nowIso;
    const open = new Map(
      (yield* listOpenActualsRows(deps.sql)).map((row) => [
        `${row.cardId}|${baseStepKeyOf(row.stepKey)}`,
        row,
      ]),
    );
    const changed = new Set<BoardCardId>();
    const ended = new Set<ProjectId>();

    for (const step of activeSteps(board)) {
      const id = `${step.card.id}|${step.stepKey}`;
      const held = open.get(id);
      open.delete(id);
      // A step no worker measures has one row, written once and ended.
      if (
        step.skipReason !== null &&
        (yield* hasActualsRow(deps.sql, step.card.id, step.stepKey))
      ) {
        continue;
      }
      const reading =
        step.skipReason !== null
          ? boardStepNotMeasured(step.skipReason)
          : yield* deps.relay(step.workerId, { ...step.input, ...(held ? { seen: true } : {}) });
      if (reading === "unreachable" || reading === null) continue;
      let stepKey = held?.stepKey ?? step.stepKey;
      if (held === undefined && step.kind === "agent") {
        const earlier = (yield* listCardActualsRows(deps.sql, step.card.id)).filter(
          (row) => baseStepKeyOf(row.stepKey) === step.stepKey,
        ).length;
        if (earlier > 0) stepKey = `${step.stepKey}#${earlier + 1}`;
      }
      yield* upsertActualsRow(deps.sql, {
        cardId: step.card.id,
        stepKey,
        kind: step.kind,
        stepId: step.stepId,
        label: step.label,
        workerId: step.workerId,
        grantedProfile: step.card.resources?.grant?.profile ?? null,
        startedAt: held?.startedAt ?? now,
        // The board's own "not measured" is final; a worker's may be measured yet, and its
        // meter entry is ended with the step.
        endedAt: step.skipReason !== null ? now : null,
        reading,
        updatedAt: now,
      });
      changed.add(step.card.id);
    }

    // Open rows whose step no longer runs: end them on their worker.
    for (const row of open.values()) {
      const card = board.cards.find((candidate) => candidate.id === row.cardId);
      const key = workerKeyOf(row, card);
      const answer =
        key === null
          ? null
          : yield* deps.relay(row.workerId, {
              op: "end",
              key,
              seen: true,
              ...(card?.worktree?.path == null ? {} : { worktreePath: card.worktree.path }),
              ...(row.kind === "agent"
                ? { threadId: baseStepKeyOf(row.stepKey).slice("thread:".length) }
                : {}),
            });
      if (
        answer === "unreachable" &&
        Date.parse(now) - Date.parse(row.updatedAt) < OPEN_ROW_LAPSE_MS
      ) {
        continue;
      }
      const reading: BoardStepReading =
        answer !== null && answer !== "unreachable"
          ? { ...answer, running: false }
          : // The worker lost it: what was stored is all there is, and it's partial.
            { ...row.reading, running: false, partial: row.reading.measured };
      yield* upsertActualsRow(deps.sql, { ...row, endedAt: now, reading, updatedAt: now });
      changed.add(row.cardId);
      if (card !== undefined) ended.add(card.projectId);
    }

    for (const projectId of ended) yield* learn(projectId);
    for (const cardId of changed) yield* deps.publish(cardId);
  });

  return { sweep, learn };
};

export type BoardActualsRecorderShape = ReturnType<typeof makeBoardActualsRecorder>;

export class BoardActualsRecorder extends Context.Service<
  BoardActualsRecorder,
  BoardActualsRecorderShape
>()("t3/board/actuals/BoardActualsRecorder") {}

export const BoardActualsRecorderLive = Layer.effect(
  BoardActualsRecorder,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const engine = yield* BoardEngine;
    const crypto = yield* SecureRandom.SecureRandom;
    const meter = yield* Effect.serviceOption(BoardActualsMeter);
    const connections = yield* Effect.serviceOption(WorkerConnections);
    const capacity = yield* Effect.serviceOption(BoardCapacityClient);
    const usage = yield* Effect.serviceOption(BoardUsageRecorder);
    const placement = yield* Effect.serviceOption(BoardPlacement);
    const threads = yield* ThreadGateway;

    const relay: BoardActualsRelay = (workerId, input) => {
      if (workerId === BOARD_LOCAL_WORKER_ID) {
        return Option.isNone(meter) ? Effect.succeed(null) : meter.value.relay(input);
      }
      if (Option.isNone(connections)) return Effect.succeed("unreachable" as const);
      return connections.value.get(workerId as EnvironmentId).pipe(
        Effect.flatMap((rpc) => rpc.gateway.actuals(input)),
        Effect.timeoutOption("10 seconds"),
        Effect.map((answer) => (Option.isNone(answer) ? ("unreachable" as const) : answer.value)),
        // A worker too old for the call, or out of reach.
        Effect.catchCause(() => Effect.succeed("unreachable" as const)),
      );
    };

    const recorder = makeBoardActualsRecorder({
      sql,
      readBoard: engine.getReadModel.pipe(Effect.map((model) => model.board ?? EMPTY_BOARD_STATE)),
      dispatch: (command) =>
        engine.dispatch(command).pipe(
          Effect.asVoid,
          Effect.catchCause((cause) =>
            Effect.logWarning("board actuals: a learned baseline wasn't recorded", { cause }),
          ),
        ),
      commandId: (tag) =>
        crypto.uuidV4().pipe(
          Effect.map((uuid) => CommandId.make(`server:board-${tag}:${uuid}`)),
          Effect.orDie,
        ),
      nowIso: Effect.map(DateTime.now, DateTime.formatIso),
      relay,
      readyWorkers: Effect.fn("BoardActualsRecorder.readyWorkers")(function* (
        projectId: ProjectId,
      ) {
        if (Option.isNone(capacity)) return [];
        const board = yield* engine.getReadModel.pipe(
          Effect.map((model) => model.board ?? EMPTY_BOARD_STATE),
        );
        const workersState = Option.isNone(placement)
          ? EMPTY_BOARD_WORKERS_STATE
          : yield* placement.value.workers;
        const repositoryKey = yield* threads.project(projectId).pipe(
          Effect.map((project) => boardRepositoryGroupingKey(project?.repositoryIdentity)),
          Effect.catchCause(() => Effect.succeed(null)),
        );
        const profiles: Array<BoardResourceProfile> = [];
        for (const workerId of [BOARD_LOCAL_WORKER_ID, ...(board.workers ?? []).map((w) => w.id)]) {
          const snapshot = yield* capacity.value.latest(workerId);
          if (snapshot === null) continue;
          const gate = boardPlacementGate({
            workerId,
            workers: workersState,
            projectRepositoryKey: repositoryKey,
            providerInstanceId: null,
          });
          if (
            boardWorkerReadyForProject({
              workerId,
              gate: gate.kind,
              snapshot,
              repositoryKey,
              projectId: String(projectId),
            })
          )
            profiles.push(snapshot.declared);
        }
        return profiles;
      }),
      publish: (cardId) => (Option.isNone(usage) ? Effect.void : usage.value.publish(cardId)),
    });

    yield* recorder.sweep().pipe(
      Effect.catchCause((cause) => Effect.logWarning("board actuals sweep failed", { cause })),
      Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
      Effect.forkScoped,
    );
    return recorder;
  }),
);

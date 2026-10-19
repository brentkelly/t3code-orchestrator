/**
 * T3o (T3O-23): the real `WorktreeRetirer` over stub collaborators, for tests.
 *
 * Terminals, sessions, the read model and settings are doubles; the removal is
 * whatever `GitVcsDriver` the test provides, and the remove scripts are real
 * child processes. Every stop, check and removal is appended to `events`, so a
 * test can assert their order.
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  makeWorktreeRetirer,
  WorktreeRetirer,
  type WorktreeProcess,
  type WorktreeRetirerOptions,
} from "./worktreeRetire.ts";

export interface WorktreeRetirerTestInput {
  /** Threads and projects the retirer reads; empty when omitted. */
  readonly model?: () => Pick<OrchestrationReadModel, "threads" | "projects">;
  readonly settings?: Partial<ServerSettings>;
  /** Survivors per check, consumed in order; the last answer repeats. None by default. */
  readonly survivors?: ReadonlyArray<ReadonlyArray<WorktreeProcess>>;
  readonly options?: WorktreeRetirerOptions;
  readonly events?: Array<string>;
}

export const worktreeRetirerTestLayer = (input: WorktreeRetirerTestInput = {}) => {
  const events = input.events ?? [];
  const answers = [...(input.survivors ?? [[]])];
  const terminals = {
    close: (request: { readonly threadId: string }) =>
      Effect.sync(() => void events.push(`close-terminals:${request.threadId}`)),
  } as unknown as TerminalManager.TerminalManager["Service"];
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        events.push(
          command.type === "thread.session.stop"
            ? `stop-session:${command.threadId}`
            : command.type,
        );
        return { sequence: 0 };
      }),
  } as unknown as OrchestrationEngineService["Service"];
  const snapshot = {
    getCommandReadModel: () =>
      Effect.sync(() => ({ threads: [], projects: [], ...input.model?.() })),
  } as unknown as ProjectionSnapshotQuery["Service"];
  const settings = {
    getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, ...input.settings }),
  } as unknown as ServerSettingsService["Service"];
  return Layer.effect(
    WorktreeRetirer,
    makeWorktreeRetirer({
      findProcessesInDirectory: () =>
        Effect.sync(() => {
          events.push("check-processes");
          return answers.length > 1 ? answers.shift()! : (answers[0] ?? []);
        }),
      signalProcess: (pid, signal) => Effect.sync(() => void events.push(`${signal}:${pid}`)),
      settleIntervalMs: 0,
      settleAttempts: 1,
      killGraceMs: 0,
      ...input.options,
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(TerminalManager.TerminalManager, terminals),
        Layer.succeed(OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery, snapshot),
        Layer.succeed(ServerSettingsService, settings),
      ),
    ),
  );
};

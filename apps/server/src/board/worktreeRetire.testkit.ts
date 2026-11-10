// @effect-diagnostics nodeBuiltinImport:off
/**
 * The real `WorktreeRetirer` over stub collaborators. The removal is the test's
 * `GitVcsDriver`, remove scripts are real child processes, and every stop, check and
 * removal is appended to `events` so a test can assert their order.
 */
import * as NodePath from "node:path";

import { DEFAULT_SERVER_SETTINGS, ThreadId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../serverSettings.ts";
import { BoardTerminals } from "./ports/BoardTerminals.ts";
import {
  makeWorktreeRetirer,
  WorktreeRetirer,
  type WorktreeProcess,
  type WorktreeRetirerOptions,
} from "./worktreeRetire.ts";
import { ThreadGateway, type BoardProject } from "./ThreadGateway.ts";
import { inertThreadGateway } from "./threadGateway.testkit.ts";

/** A thread the retirer may find in the worktree it is retiring. */
export interface WorktreeRetirerTestThread {
  readonly threadId: string;
  readonly worktreePath: string | null;
  readonly deleted?: boolean;
  /** A provider session that is not stopped. */
  readonly sessionLive?: boolean;
}

export interface WorktreeRetirerTestInput {
  /** Threads and projects the retirer reads; empty when omitted. */
  readonly threads?: () => ReadonlyArray<WorktreeRetirerTestThread>;
  readonly projects?: () => ReadonlyArray<BoardProject>;
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
  } as unknown as BoardTerminals["Service"];
  const threads = inertThreadGateway({
    stopSession: (request) =>
      Effect.sync(() => void events.push(`stop-session:${request.threadId}`)),
    threadsInWorktree: (worktreePath) =>
      Effect.sync(() =>
        (input.threads?.() ?? [])
          .filter(
            (thread) =>
              thread.worktreePath !== null &&
              NodePath.resolve(thread.worktreePath) === NodePath.resolve(worktreePath),
          )
          .map((thread) => ({
            threadId: ThreadId.make(thread.threadId),
            deleted: thread.deleted ?? false,
            sessionLive: thread.sessionLive ?? false,
          })),
      ),
    projects: () => Effect.sync(() => input.projects?.() ?? []),
  });
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
        Layer.succeed(BoardTerminals, terminals),
        Layer.succeed(ThreadGateway, threads),
        Layer.succeed(ServerSettingsService, settings),
      ),
    ),
  );
};

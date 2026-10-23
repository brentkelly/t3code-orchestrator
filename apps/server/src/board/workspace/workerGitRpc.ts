/**
 * T3o (T3O-64, D21): the worker side of the board's named git and forge
 * operations — `boardWorker.git.*`, which arrive as one `boardWorker.git.call`
 * spread into the board's RPC handler record (`board/rpc.ts`).
 *
 * Every T3o server answers them, for the central server that dialed it, by
 * running its own `LocalBoardWorkspace`: the same code the central server runs
 * for a card of its own, marking the checkouts it makes as the central board's
 * so this server's own board never sweeps them. Two checks stand between the call and git:
 *
 * - the session holds the operation's scope (`BOARD_WORKER_GIT_RPC_SCOPES`);
 * - a path the caller names is one of the project's worktrees on THIS server,
 *   and, for an operation that changes or removes a checkout, one the central
 *   board made (its owner marker), so no write reaches this server's own
 *   board's checkouts or a user's thread worktree;
 * - a branch it provisions a worktree or integration branch on is not on
 *   this server's own board's cards, and one it deletes is not either, nor checked out in a
 *   worktree the central board didn't make.
 *
 * Anything that goes wrong comes back as `BoardWorkerGitError`, a defect
 * included, so the central server never mistakes a broken operation for a
 * worker it cannot reach.
 */
import {
  BOARD_WORKER_GIT_CALL_WS_METHODS,
  BOARD_WORKER_GIT_RPC_SCOPES,
  BOARD_WORKER_GIT_WS_METHODS,
  BoardWorkerGitError,
  type BoardWorkerGitCall,
  EnvironmentAuthorizationError,
  type BoardWorkerGitMethod,
  type BoardWorkerGitOperation,
  type BoardWorkerGitPayload,
  type BoardWorkerGitSuccess,
  type ProjectId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import type { BoardWorkspacesShape } from "./BoardWorkspace.ts";
import { decodeGitPayload, encodeGitSuccess } from "./gitWire.ts";

export type BoardWorkerGitHandlers = {
  readonly [Method in BoardWorkerGitMethod]: (
    input: BoardWorkerGitPayload<Method>,
  ) => Effect.Effect<
    BoardWorkerGitSuccess<Method>,
    BoardWorkerGitError | EnvironmentAuthorizationError
  >;
};

/** The payload fields that name a path on the worker. */
const pathsOf = (input: Record<string, unknown>): ReadonlyArray<string> => {
  const path = input["worktreePath"];
  return typeof path === "string" ? [path] : [];
};

/** The operations that change or remove the checkout they name. */
const WRITES_TO_PATH: ReadonlySet<BoardWorkerGitOperation> = new Set([
  "pinGhDefault",
  "pruneWorktree",
  "retireWorktree",
]);

const guardPaths = (
  workspaces: BoardWorkspacesShape,
  operation: BoardWorkerGitOperation,
  projectId: ProjectId,
  paths: ReadonlyArray<string>,
) =>
  Effect.forEach(paths, (path) =>
    workspaces
      .ownsWorktreePath(projectId, path, WRITES_TO_PATH.has(operation) ? "central" : undefined)
      .pipe(
        Effect.flatMap((owned) =>
          owned
            ? Effect.void
            : Effect.fail(
                new BoardWorkerGitError({
                  operation,
                  detail: `${path} is not one of this project's worktrees on this server${WRITES_TO_PATH.has(operation) ? " that the board made" : ""}.`,
                }),
              ),
        ),
      ),
  );

/** The operations that create, or adopt as the card's own, the branch they
    name: a checkout on it, or a split parent's integration branch. */
const PROVISIONS_BRANCH: ReadonlySet<BoardWorkerGitOperation> = new Set([
  "provisionWorktree",
  "provisionWorktreeFromRemoteBranch",
  "createIntegrationBranch",
]);

/** A branch the call names, not a path: one it provisions must not be this
    server's own board's (`centralMayUseBranch`), and one it deletes must be
    one the central board may delete here (`centralMayDeleteBranch`). */
const guardBranch = (
  workspaces: BoardWorkspacesShape,
  operation: BoardWorkerGitOperation,
  projectId: ProjectId,
  input: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const branch = String(input["branch"]);
    if (operation === "deleteCardBranch") {
      if (yield* workspaces.centralMayDeleteBranch(projectId, branch)) return;
      return yield* new BoardWorkerGitError({
        operation,
        detail: `${branch} belongs to this server's own board or a checkout the board didn't make.`,
      });
    }
    if (!PROVISIONS_BRANCH.has(operation) || (yield* workspaces.centralMayUseBranch(branch))) {
      return;
    }
    return yield* new BoardWorkerGitError({
      operation,
      detail: `${branch} belongs to this server's own board.`,
    });
  });

export const boardWorkerGitRpcHandlers = (
  currentSession: AuthenticatedSession,
  workspaces: BoardWorkspacesShape,
): BoardWorkerGitHandlers => {
  const handler =
    (op: BoardWorkerGitOperation) =>
    (input: { readonly projectId: ProjectId } & Record<string, unknown>) => {
      const method = BOARD_WORKER_GIT_WS_METHODS[op];
      const requiredScope = BOARD_WORKER_GIT_RPC_SCOPES[method];
      if (!currentSession.scopes.includes(requiredScope)) {
        return Effect.fail(
          new EnvironmentAuthorizationError({
            message: `The authenticated token is missing required scope: ${requiredScope}.`,
            requiredScope,
          }),
        );
      }
      return Effect.gen(function* () {
        yield* guardPaths(workspaces, op, input.projectId, pathsOf(input));
        yield* guardBranch(workspaces, op, input.projectId, input);
        const run = workspaces.forCentral[op] as (
          payload: unknown,
        ) => Effect.Effect<unknown, BoardWorkerGitError | { readonly _tag: "WorkerUnavailable" }>;
        return yield* run(input);
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "BoardWorkerGitError"
            ? error
            : new BoardWorkerGitError({ operation: op, detail: "This server is unavailable." }),
        ),
        Effect.catchDefect((defect) =>
          Effect.fail(
            new BoardWorkerGitError({
              operation: op,
              detail: `The operation failed on the worker: ${Cause.pretty(Cause.die(defect)).split("\n")[0] ?? "unknown error"}`,
            }),
          ),
        ),
      );
    };
  return Object.fromEntries(
    (Object.keys(BOARD_WORKER_GIT_WS_METHODS) as Array<BoardWorkerGitOperation>).map((op) => [
      BOARD_WORKER_GIT_WS_METHODS[op],
      handler(op),
    ]),
  ) as unknown as BoardWorkerGitHandlers;
};

const operationOf = Object.fromEntries(
  Object.entries(BOARD_WORKER_GIT_WS_METHODS).map(([op, method]) => [method, op]),
) as Record<BoardWorkerGitMethod, BoardWorkerGitOperation>;

/**
 * `boardWorker.git.call`: decodes the operation's payload with its own schema
 * — a branch the rules refuse never reaches git — runs the operation's handler
 * above, and encodes its answer.
 */
export const boardWorkerGitCallRpcHandlers = (
  currentSession: AuthenticatedSession,
  workspaces: BoardWorkspacesShape,
) => {
  const operations = boardWorkerGitRpcHandlers(currentSession, workspaces) as unknown as Record<
    BoardWorkerGitMethod,
    (input: unknown) => Effect.Effect<unknown, BoardWorkerGitError | EnvironmentAuthorizationError>
  >;
  const unusable = (method: BoardWorkerGitMethod, what: string) => (error: { message: string }) =>
    new BoardWorkerGitError({
      operation: operationOf[method],
      detail: `The ${what} could not be used: ${error.message}`,
    });
  return {
    [BOARD_WORKER_GIT_CALL_WS_METHODS.call]: ({ method, payload }: BoardWorkerGitCall) =>
      decodeGitPayload(method, payload).pipe(
        Effect.mapError(unusable(method, "call's payload")),
        Effect.flatMap((input) => operations[method](input)),
        Effect.flatMap((value) =>
          encodeGitSuccess(method, value).pipe(Effect.mapError(unusable(method, "answer"))),
        ),
      ),
  };
};

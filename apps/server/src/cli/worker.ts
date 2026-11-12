// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off globalTimers:off globalFetchInEffect:off globalJsonInEffect:off - a CLI over plain files and one HTTP call.
/**
 * T3o: `t3 worker …` (T3O-84), the worker's whole interface: there is no worker settings
 * UI. `join` presents a board's one-time code, stores the tunnel credential in the secret
 * store, then records the board in `<home>/worker.json`, which the running server
 * watches. `pnpm t3o-worker` wraps this with the T3o service's home.
 */
import * as NodeOS from "node:os";

import {
  BoardWorkerJoinAccepted,
  BoardWorkerJoinRefused,
  BOARD_WORKER_JOIN_PATH,
  T3O_TUNNEL_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, CliError, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { revokeBoardSessions } from "../board/workers/workerRpc.ts";
import { readT3oRelease } from "../board/tunnel/WorkerTunnels.ts";
import {
  boardUrlRefusal,
  findWorkerBoard,
  readWorkerFile,
  readWorkerStatus,
  removeWorkerBoard,
  tunnelCredentialSecretName,
  upsertWorkerBoard,
  WORKER_CONFIG_KEYS,
  workerFilePath,
  writeWorkerFile,
  type WorkerBoardEntry,
  type WorkerStatusFile,
} from "../board/tunnel/workerFile.ts";
import * as ServerConfig from "../config.ts";
import { ServerEnvironmentIdentity } from "../environment/ServerEnvironment.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { authLocationFlags, type CliAuthLocationFlags, resolveCliAuthConfig } from "./config.ts";

class WorkerCliError extends Schema.TaggedError<WorkerCliError>()("WorkerCliError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

const fail = (detail: string) =>
  Effect.fail(new CliError.UserError({ cause: new WorkerCliError({ detail }) }));

/** `worker.json`, or a user error when it exists but can't be read: never written over. */
const readBoards = (home: string) =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(readWorkerFile(home));
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });

/** How long `join` waits for the running server to report the tunnel connected. */
const JOIN_CONNECT_TIMEOUT_MS = 30_000;

/** Run with the worker's home: its secrets, auth store, identity and policy. */
const withWorkerHome = Effect.fn("worker.withHome")(function* <A, E>(
  flags: CliAuthLocationFlags,
  run: (services: {
    readonly home: string;
    readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
    readonly secrets: ServerSecretStore["Service"];
    readonly environmentId: string;
    readonly policy: ManagedPolicy.ManagedPolicy["Service"];
  }) => Effect.Effect<A, E>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: true });
  return yield* Effect.gen(function* () {
    const identity = yield* ServerEnvironmentIdentity;
    return yield* run({
      home: config.baseDir,
      auth: yield* EnvironmentAuth.EnvironmentAuth,
      secrets: yield* ServerSecretStore,
      environmentId: yield* identity.getEnvironmentId,
      policy: yield* ManagedPolicy.ManagedPolicy,
    });
  }).pipe(
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
      ),
    ),
  );
});

const decodeAccepted = Schema.decodeUnknownOption(BoardWorkerJoinAccepted);
const decodeRefused = Schema.decodeUnknownOption(BoardWorkerJoinRefused);

/** A board address and code, from `<url> --code X` or a pasted join link (`…?code=X`). */
export function parseJoinTarget(
  rawUrl: string,
  code: string | undefined,
): { readonly boardUrl: string; readonly code: string } | string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `"${rawUrl}" isn't a URL. Copy the command from the board's Add worker dialog.`;
  }
  const linked =
    url.searchParams.get("code") ?? new URLSearchParams(url.hash.replace(/^#/, "")).get("code");
  const resolved = code ?? linked ?? undefined;
  if (resolved === undefined || resolved.trim().length === 0) {
    return "Missing --code. Copy the command from the board's Add worker dialog.";
  }
  url.search = "";
  url.hash = "";
  const boardUrl = `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  return { boardUrl, code: resolved.trim() };
}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms)));

const processAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** What a status file says about a join written at `since`. A status from before the
    join (a stale `revoked`, or a tunnel still on the old credential) or from a server
    that's gone says nothing yet. */
export function joinStatusVerdict(
  status: WorkerStatusFile | null,
  boardId: string,
  since: number,
  isAlive: (pid: number) => boolean = processAlive,
): "connected" | "refused" | "pending" | "no-server" {
  if (status === null || !isAlive(status.pid)) return "no-server";
  if (!(Date.parse(status.updatedAt) > since)) return "pending";
  const board = status.boards.find((entry) => entry.boardEnvironmentId === boardId);
  if (board?.state === "connected") return "connected";
  if (board?.state === "revoked" || board?.state === "needs-update") return "refused";
  return "pending";
}

/** Wait for the running server's tunnel to this board to connect. */
const awaitConnected = Effect.fn("worker.awaitConnected")(function* (
  home: string,
  boardId: string,
  since: number,
) {
  const deadline = Date.now() + JOIN_CONNECT_TIMEOUT_MS;
  let last: ReturnType<typeof readWorkerStatus> = null;
  let verdict: ReturnType<typeof joinStatusVerdict> = "no-server";
  while (Date.now() < deadline) {
    last = readWorkerStatus(home);
    verdict = joinStatusVerdict(last, boardId, since);
    const board = last?.boards.find((entry) => entry.boardEnvironmentId === boardId) ?? null;
    if (verdict === "connected") return { ok: true as const, status: board };
    if (verdict === "refused") return { ok: false as const, status: board };
    yield* sleep(500);
  }
  const board = last?.boards.find((entry) => entry.boardEnvironmentId === boardId) ?? null;
  return { ok: false as const, status: board, noServer: verdict === "no-server" };
});

const insecureFlag = Flag.Boolean("insecure").pipe(
  Flag.withDescription("Allow a plain http:// board address that isn't loopback or Tailscale."),
  Flag.withDefault(false),
);

const joinCommand = Command.make("join", {
  ...authLocationFlags,
  board: Argument.String("board-url").pipe(
    Argument.withDescription("The board's address, or the join link from its Add worker dialog."),
  ),
  code: Flag.String("code").pipe(
    Flag.withDescription("The one-time join code shown on the board (XXXX-XXXX)."),
    Flag.optional,
  ),
  label: Flag.String("label").pipe(
    Flag.withDescription("This worker's name on the board. Defaults to the host name."),
    Flag.optional,
  ),
  insecure: insecureFlag,
}).pipe(
  Command.withDescription("Join a board with the code from its Add worker dialog."),
  Command.withHandler((flags) =>
    withWorkerHome(flags, ({ home, secrets, environmentId, policy }) =>
      Effect.gen(function* () {
        const target = parseJoinTarget(flags.board, Option.getOrUndefined(flags.code));
        if (typeof target === "string") return yield* fail(target);
        const refusal = boardUrlRefusal(target.boardUrl, flags.insecure);
        if (refusal !== null) return yield* fail(refusal);
        if (!ManagedLimits.allowsRemoteClients(policy)) {
          return yield* fail(
            "This machine's managed policy doesn't allow remote clients, so no board can use it as a worker.",
          );
        }
        const file = yield* readBoards(home);
        const label = Option.getOrElse(flags.label, () => NodeOS.hostname()).slice(0, 64);
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`${target.boardUrl}${BOARD_WORKER_JOIN_PATH}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                code: target.code,
                environmentId,
                label,
                t3oRelease: readT3oRelease(),
                tunnelProtocol: T3O_TUNNEL_PROTOCOL_VERSION,
              }),
            }),
          catch: (cause) =>
            new WorkerCliError({
              detail: `Couldn't reach ${target.boardUrl}: ${cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause)}`,
            }),
        }).pipe(Effect.catch((error) => fail(error.detail)));
        const body: unknown = yield* Effect.promise(() => response.json().catch(() => null));
        const accepted = decodeAccepted(body);
        if (Option.isNone(accepted)) {
          const refused = decodeRefused(body);
          return yield* fail(
            Option.isSome(refused)
              ? refused.value.message
              : `The board answered HTTP ${response.status}. Is ${target.boardUrl} a T3o board?`,
          );
        }
        const joined = accepted.value;
        const others = file.boards.filter(
          (board) => board.boardEnvironmentId !== joined.boardEnvironmentId,
        );
        // The secret first: a board in worker.json with no credential reads as revoked.
        yield* secrets
          .set(
            tunnelCredentialSecretName(joined.boardEnvironmentId),
            new TextEncoder().encode(joined.tunnelCredential),
          )
          .pipe(Effect.catch(() => fail("Couldn't store the tunnel credential.")));
        const entry: WorkerBoardEntry = {
          boardEnvironmentId: joined.boardEnvironmentId,
          boardUrl: target.boardUrl,
          boardLabel: joined.boardLabel,
          joinedAt: new Date().toISOString(),
        };
        const writtenAt = Date.now();
        writeWorkerFile(home, upsertWorkerBoard(yield* readBoards(home), entry));
        yield* Console.log(`Joined ${joined.boardLabel} as ${label}.`);
        if (others.length > 0) {
          yield* Console.log(
            `Note: this worker now serves ${others.length + 1} boards. A worker and every board it serves are one trust domain: users of each board can see every thread on this worker.`,
          );
        }
        yield* Console.log("Waiting for this machine's T3o server to connect…");
        const connected = yield* awaitConnected(home, joined.boardEnvironmentId, writtenAt);
        if (connected.ok) {
          yield* Console.log(`Connected to ${joined.boardLabel}. Finish in the board's dialog.`);
          return;
        }
        if ("noServer" in connected && connected.noServer === true) {
          return yield* fail(
            `No T3o server is running with home ${home}, so nothing has connected yet. Start the T3o service (pnpm t3o-worker join installs it on Linux); it connects as soon as it runs.`,
          );
        }
        return yield* fail(
          `Not connected yet${connected.status?.lastError ? `: ${connected.status.lastError}` : "."} Check with \`t3o-worker status\`.`,
        );
      }),
    ),
  ),
);

const pickBoard = (home: string, name: string | undefined) =>
  Effect.flatMap(readBoards(home), (file) => {
    if (name === undefined) {
      if (file.boards.length === 1) return Effect.succeed(file.boards[0]!);
      return fail(
        file.boards.length === 0
          ? "This worker serves no boards."
          : `This worker serves ${file.boards.length} boards; name one: ${file.boards.map((board) => board.boardLabel).join(", ")}.`,
      );
    }
    const found = findWorkerBoard(file, name);
    return found === null ? fail(`No board named ${name} on this worker.`) : Effect.succeed(found);
  });

const leaveBoard = (flags: {
  readonly baseDir: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly board: Option.Option<string>;
}) =>
  withWorkerHome(flags, ({ home, auth, secrets }) =>
    Effect.gen(function* () {
      const board = yield* pickBoard(home, Option.getOrUndefined(flags.board));
      // Removing it from worker.json makes the running server say goodbye and close the
      // tunnel; this works offline too. Sessions go last, so a redial in between can't be
      // handed a fresh one: the mint refuses once the board is gone from the file.
      writeWorkerFile(home, removeWorkerBoard(yield* readBoards(home), board.boardEnvironmentId));
      yield* secrets
        .remove(tunnelCredentialSecretName(board.boardEnvironmentId))
        .pipe(Effect.ignore);
      const revoked = yield* revokeBoardSessions(auth, board.boardEnvironmentId).pipe(
        Effect.orElseSucceed(() => 0),
      );
      yield* Console.log(
        `Left ${board.boardLabel}: ${revoked} session${revoked === 1 ? "" : "s"} it held here revoked. Its cards stay on the board until someone removes this worker there.`,
      );
    }),
  );

const boardArgument = Argument.String("board").pipe(
  Argument.withDescription("The board's label, address or environment id."),
  Argument.optional,
);

const leaveCommand = Command.make("leave", { ...authLocationFlags, board: boardArgument }).pipe(
  Command.withDescription("Stop working for a board and revoke everything it held here."),
  Command.withHandler(leaveBoard),
);

const boardsRemoveCommand = Command.make("remove", {
  ...authLocationFlags,
  board: boardArgument,
}).pipe(Command.withDescription("Same as `leave`."), Command.withHandler(leaveBoard));

const boardsCommand = Command.make("boards", { ...authLocationFlags }).pipe(
  Command.withDescription("List the boards this worker serves."),
  Command.withHandler((flags) =>
    withWorkerHome(flags, ({ home }) =>
      Effect.gen(function* () {
        const file = yield* readBoards(home);
        if (file.boards.length === 0) {
          yield* Console.log("This worker serves no boards. Join one with `t3o-worker join`.");
          return;
        }
        for (const board of file.boards) {
          yield* Console.log(`${board.boardLabel}  ${board.boardUrl}  (joined ${board.joinedAt})`);
        }
      }),
    ),
  ),
  Command.withSubcommands([boardsRemoveCommand]),
);

/** `status` is a list of sections, so T3O-71 can add capacity beside the tunnels. */
const workerStatusSections: Array<(home: string) => ReadonlyArray<string>> = [
  (home) => {
    const status = readWorkerStatus(home);
    if (status === null) {
      return ["Server: no status yet. Is the T3o service running with this home?"];
    }
    let alive = false;
    try {
      process.kill(status.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    return [
      `Server: ${alive ? `running (pid ${status.pid})` : "not running"}, last report ${status.updatedAt}`,
    ];
  },
  (home) => {
    let file: ReturnType<typeof readWorkerFile>;
    try {
      file = readWorkerFile(home);
    } catch (error) {
      return [`Boards: ${error instanceof Error ? error.message : String(error)}`];
    }
    const status = readWorkerStatus(home);
    if (file.boards.length === 0) return ["Boards: none."];
    return [
      "Boards:",
      ...file.boards.flatMap((board) => {
        const entry = status?.boards.find(
          (candidate) => candidate.boardEnvironmentId === board.boardEnvironmentId,
        );
        return [
          `  ${board.boardLabel}  ${entry?.boardUrl ?? board.boardUrl}`,
          `    ${entry?.state ?? "unknown"}${entry?.lastConnectedAt ? `, last connected ${entry.lastConnectedAt}` : ""}`,
          ...(entry?.lastError ? [`    last error: ${entry.lastError}`] : []),
        ];
      }),
    ];
  },
];

const statusCommand = Command.make("status", { ...authLocationFlags }).pipe(
  Command.withDescription("Show the service and each board's tunnel, with its last error."),
  Command.withHandler((flags) =>
    withWorkerHome(flags, ({ home }) =>
      Console.log(workerStatusSections.flatMap((section) => section(home)).join("\n")),
    ),
  ),
);

const configKeysHelp =
  WORKER_CONFIG_KEYS.length === 0
    ? "No settings yet."
    : WORKER_CONFIG_KEYS.map((entry) => `${entry.key}: ${entry.description}`).join("\n");

const configCommand = Command.make("config", {
  ...authLocationFlags,
  action: Argument.Literals("action", ["list", "get", "set", "unset"]).pipe(
    Argument.withDefault("list"),
  ),
  key: Argument.String("key").pipe(Argument.optional),
  value: Argument.String("value").pipe(Argument.optional),
}).pipe(
  Command.withDescription(
    `Read or change this worker's settings in worker.json.\n\n${configKeysHelp}`,
  ),
  Command.withHandler((flags) =>
    withWorkerHome(flags, ({ home }) =>
      Effect.gen(function* () {
        const file = yield* readBoards(home);
        const key = Option.getOrUndefined(flags.key);
        if (flags.action === "list") {
          const entries = Object.entries(file.config);
          yield* Console.log(
            entries.length === 0
              ? `No settings set (${workerFilePath(home)}). ${configKeysHelp}`
              : entries.map(([name, value]) => `${name} = ${JSON.stringify(value)}`).join("\n"),
          );
          return;
        }
        const known = WORKER_CONFIG_KEYS.find((entry) => entry.key === key);
        if (key === undefined || known === undefined) {
          return yield* fail(
            `Unknown setting${key === undefined ? "" : ` ${key}`}. ${configKeysHelp}`,
          );
        }
        if (flags.action === "get") {
          yield* Console.log(JSON.stringify(file.config[key] ?? null));
          return;
        }
        const config = { ...file.config };
        if (flags.action === "unset") {
          delete config[key];
        } else {
          const raw = Option.getOrUndefined(flags.value);
          if (raw === undefined)
            return yield* fail(`Give a value: t3o-worker config set ${key} <value>`);
          config[key] = known.parse(raw);
        }
        writeWorkerFile(home, { ...file, config });
      }),
    ),
  ),
);

export const workerCommand = Command.make("worker").pipe(
  Command.withDescription(
    "T3o: work for one or more boards over an outbound tunnel (join, leave, boards, status, config).",
  ),
  Command.withSubcommands([joinCommand, leaveCommand, boardsCommand, statusCommand, configCommand]),
);

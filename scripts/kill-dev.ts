#!/usr/bin/env node
/**
 * `npm run kill` — free this checkout's dev ports.
 *
 * Resolves the same ports `npm run dev` would prefer (see `dev-runner.ts`:
 * `T3CODE_PORT` for the backend, otherwise `13773`/`5733` plus this
 * worktree's offset), finds whatever is listening on them, and terminates it
 * together with the rest of its dev process tree — the `vp run` supervisor
 * above it and the Vite/backend children below — so a half-killed run cannot
 * respawn onto the port a second later.
 *
 * Ports may be given explicitly (`npm run kill -- 3773 5733`), which skips
 * port resolution entirely.
 */
// @effect-diagnostics nodeBuiltinImport:off - signalling a pid has no Effect platform service.
import * as NodeProcess from "node:process";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveGitWorktreePath } from "@t3tools/shared/devHome";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { BASE_SERVER_PORT, BASE_WEB_PORT, resolveOffset } from "./dev-runner.ts";

/** How long a terminated process gets to exit before it is killed outright. */
const TERMINATE_GRACE = Duration.seconds(5);
const TERMINATE_POLL_INTERVAL = Duration.millis(250);

/**
 * A process group whose leader is one of these is a shell session, not a dev
 * run: `npm run dev` normally gets a process group of its own (job control),
 * but a shell started without it leaves its children sharing the shell's group.
 * Killing that group would kill the terminal. `sh -c <cmd>` is exempt — it is a
 * wrapper npm itself inserts, not a session.
 */
const SESSION_LEADER_PATTERN =
  /^-?(?:[\w./\\-]*[\\/])?(bash|zsh|sh|dash|ksh|fish|login|sshd|systemd|tmux|screen|init)\b/;

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly command: string;
}

export class KillDevUnsupportedPlatformError extends Schema.TaggedErrorClass<KillDevUnsupportedPlatformError>()(
  "KillDevUnsupportedPlatformError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `npm run kill supports linux, macOS and Windows; this is ${this.platform}. Find the listener by hand (e.g. \`lsof -iTCP -sTCP:LISTEN\`) and kill it.`;
  }
}

export class KillDevConfigurationError extends Schema.TaggedErrorClass<KillDevConfigurationError>()(
  "KillDevConfigurationError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read dev port configuration: T3CODE_PORT_OFFSET, T3CODE_DEV_INSTANCE.";
  }
}

/**
 * Ports to clear. An explicit list wins outright — that is the escape hatch for
 * an instance whose ports were shifted by collision scanning, which this script
 * cannot rediscover (the scan picks the first *free* port, so replaying it
 * would walk past the very port we want to free).
 */
export function resolveKillPorts({
  explicitPorts,
  serverPortOverride,
  offset,
}: {
  readonly explicitPorts: ReadonlyArray<number>;
  readonly serverPortOverride: number | undefined;
  readonly offset: number;
}): ReadonlyArray<number> {
  const ports =
    explicitPorts.length > 0
      ? explicitPorts
      : [serverPortOverride ?? BASE_SERVER_PORT + offset, BASE_WEB_PORT + offset];

  return [...new Set(ports)].sort((left, right) => left - right);
}

/** `lsof -t` / `netstat -ano` both end up as one pid per captured field. */
export function parsePids(output: string): ReadonlyArray<number> {
  const pids = new Set<number>();
  for (const line of output.split("\n")) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 1) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/** Windows has no `lsof`; pull the owning pid out of `netstat -ano` instead. */
export function parseWindowsListenerPids(output: string, port: number): ReadonlyArray<number> {
  const pids = new Set<number>();
  for (const line of output.split("\n")) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 5 || columns[3] !== "LISTENING") {
      continue;
    }
    const localAddress = columns[1] ?? "";
    if (!localAddress.endsWith(`:${String(port)}`)) {
      continue;
    }
    const pid = Number(columns[4]);
    if (Number.isInteger(pid) && pid > 1) {
      pids.add(pid);
    }
  }
  return [...pids];
}

/** `ps -eo pid=,ppid=,pgid=,args=` — the ids, then the command line with its spaces. */
export function parseProcessTable(output: string): ReadonlyArray<ProcessEntry> {
  const entries: Array<ProcessEntry> = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      command: (match[4] ?? "").trim(),
    });
  }
  return entries;
}

function descendantsOf(table: ReadonlyArray<ProcessEntry>, roots: Iterable<number>): Set<number> {
  const childrenByParent = new Map<number, Array<number>>();
  for (const entry of table) {
    const siblings = childrenByParent.get(entry.ppid);
    if (siblings) {
      siblings.push(entry.pid);
    } else {
      childrenByParent.set(entry.ppid, [entry.pid]);
    }
  }

  const collected = new Set<number>();
  const queue = [...roots];
  while (queue.length > 0) {
    const pid = queue.pop();
    if (pid === undefined || collected.has(pid)) {
      continue;
    }
    collected.add(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return collected;
}

/** Every pid between this process and init — the one chain we must never kill. */
export function ownAncestry(table: ReadonlyArray<ProcessEntry>, selfPid: number): Set<number> {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const chain = new Set<number>();
  let current: number | undefined = selfPid;
  while (current !== undefined && current > 1 && !chain.has(current)) {
    chain.add(current);
    current = byPid.get(current)?.ppid;
  }
  return chain;
}

/**
 * The listeners plus the rest of their dev run.
 *
 * `npm run dev` and everything under it — the `sh -c` wrapper, `dev-runner`,
 * `vp run`, the `node --watch` supervisor, the server itself — share one
 * process group, so the group is the unit to kill. Killing only the listener
 * leaves `node --watch` alive, and it restarts the server onto the same port
 * within a second. Where the group cannot be trusted (it is this script's own,
 * or it is led by a shell session) we fall back to the listener and its
 * descendants, and the caller reports the port as still held if that was not
 * enough.
 */
export function selectKillTargets({
  table,
  listenerPids,
  selfPid,
}: {
  readonly table: ReadonlyArray<ProcessEntry>;
  readonly listenerPids: ReadonlyArray<number>;
  readonly selfPid: number;
}): ReadonlyArray<number> {
  const byPid = new Map(table.map((entry) => [entry.pid, entry]));
  const protectedPids = ownAncestry(table, selfPid);
  const selfPgid = byPid.get(selfPid)?.pgid;

  const targets = new Set<number>();
  for (const listenerPid of listenerPids) {
    const listener = byPid.get(listenerPid);
    const group =
      listener === undefined ? [] : table.filter((entry) => entry.pgid === listener.pgid);
    const leader = listener === undefined ? undefined : byPid.get(listener.pgid);
    const groupIsKillable =
      listener !== undefined &&
      listener.pgid > 1 &&
      listener.pgid !== selfPgid &&
      !(
        leader !== undefined &&
        !leader.command.includes(" -c ") &&
        SESSION_LEADER_PATTERN.test(leader.command)
      ) &&
      !group.some((entry) => protectedPids.has(entry.pid));

    if (groupIsKillable) {
      for (const entry of group) {
        targets.add(entry.pid);
      }
      continue;
    }

    for (const pid of descendantsOf(table, [listenerPid])) {
      targets.add(pid);
    }
  }

  // A process table we could not read (empty `table`) still has to kill the
  // listeners themselves — the lookups above only return what they can see.
  for (const listenerPid of listenerPids) {
    targets.add(listenerPid);
  }

  return [...targets]
    .filter((pid) => !protectedPids.has(pid) && pid > 1)
    .sort((left, right) => left - right);
}

const collectOutput = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (accumulator, chunk) => accumulator + chunk,
    ),
  );

/**
 * Runs a lookup command and returns its stdout. Failure is not fatal here: a
 * missing `lsof`, or an exit code that only means "nothing matched", both leave
 * us with the same answer as an empty listing.
 */
function readCommandOutput(
  executable: string,
  args: ReadonlyArray<string>,
): Effect.Effect<string, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(executable, args));
    const [stdout] = yield* Effect.all([collectOutput(child.stdout), child.exitCode], {
      concurrency: "unbounded",
    });
    return stdout;
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.seconds(10)),
    Effect.map(Option.getOrElse(() => "")),
    Effect.catchCause(() => Effect.succeed("")),
  );
}

function readListenerPids(
  port: number,
  platform: string,
): Effect.Effect<ReadonlyArray<number>, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (platform === "win32") {
    return readCommandOutput("netstat", ["-ano", "-p", "tcp"]).pipe(
      Effect.map((output) => parseWindowsListenerPids(output, port)),
    );
  }

  return readCommandOutput("lsof", ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-t"]).pipe(
    Effect.map(parsePids),
  );
}

function readProcessTable(
  platform: string,
): Effect.Effect<ReadonlyArray<ProcessEntry>, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (platform === "win32") {
    // Windows gets no tree walk: `taskkill /T` already terminates the child
    // tree, and there is no cheap ppid+args listing to climb upwards with.
    return Effect.succeed([]);
  }
  return readCommandOutput("ps", ["-eo", "pid=,ppid=,pgid=,args="]).pipe(
    Effect.map(parseProcessTable),
  );
}

function signal(pid: number, signalName: NodeJS.Signals): Effect.Effect<boolean> {
  return Effect.sync(() => {
    try {
      NodeProcess.kill(pid, signalName);
      return true;
    } catch {
      // Already gone, or not ours to signal. Either way there is nothing to do.
      return false;
    }
  });
}

const isAlive = (pid: number): Effect.Effect<boolean> =>
  Effect.sync(() => {
    try {
      NodeProcess.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

function terminate(
  pids: ReadonlyArray<number>,
  platform: string,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    if (platform === "win32") {
      yield* Effect.forEach(
        pids,
        (pid) => readCommandOutput("taskkill", ["/PID", String(pid), "/T", "/F"]),
        { discard: true },
      );
      return;
    }

    yield* Effect.forEach(pids, (pid) => signal(pid, "SIGTERM"), { discard: true });

    const deadline =
      Duration.toMillis(TERMINATE_GRACE) / Duration.toMillis(TERMINATE_POLL_INTERVAL);
    let survivors = pids;
    for (let attempt = 0; attempt < deadline && survivors.length > 0; attempt += 1) {
      yield* Effect.sleep(TERMINATE_POLL_INTERVAL);
      survivors = yield* Effect.filter(survivors, isAlive);
    }

    if (survivors.length > 0) {
      yield* Effect.logInfo(
        `[kill] SIGKILL after ${Duration.format(TERMINATE_GRACE)}: ${survivors.join(", ")}`,
      );
      yield* Effect.forEach(survivors, (pid) => signal(pid, "SIGKILL"), { discard: true });
    }
  });
}

export function runKillDev(input: {
  readonly ports: ReadonlyArray<number>;
  readonly dryRun: boolean;
}) {
  return Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
      return yield* new KillDevUnsupportedPlatformError({ platform });
    }

    const environment = yield* HostProcessEnvironment;
    const worktreePath = yield* resolveGitWorktreePath(yield* HostProcessWorkingDirectory);
    const { offset, source } = yield* resolveOffset({
      portOffset: parsePort(environment.T3CODE_PORT_OFFSET),
      devInstance: environment.T3CODE_DEV_INSTANCE,
      worktreePath,
    }).pipe(Effect.catchCause((cause) => new KillDevConfigurationError({ cause })));

    const ports = resolveKillPorts({
      explicitPorts: input.ports,
      serverPortOverride: parsePort(environment.T3CODE_PORT),
      offset,
    });

    yield* Effect.logInfo(
      `[kill] ports=${ports.join(", ")} source=${input.ports.length > 0 ? "explicit arguments" : source}`,
    );

    const table = yield* readProcessTable(platform);
    const selfPid = NodeProcess.pid;

    for (const port of ports) {
      const listenerPids = yield* readListenerPids(port, platform);
      if (listenerPids.length === 0) {
        yield* Effect.logInfo(`[kill] port ${String(port)}: nothing listening`);
        continue;
      }

      const targets = selectKillTargets({ table, listenerPids, selfPid });
      const describe = targets
        .map((pid) => {
          const command = table.find((entry) => entry.pid === pid)?.command;
          return command ? `${String(pid)} (${command.slice(0, 80)})` : String(pid);
        })
        .join("\n         ");

      if (input.dryRun) {
        yield* Effect.logInfo(`[kill] port ${String(port)}: would kill\n         ${describe}`);
        continue;
      }

      yield* Effect.logInfo(`[kill] port ${String(port)}: killing\n         ${describe}`);
      yield* terminate(targets, platform);

      const remaining = yield* readListenerPids(port, platform);
      yield* remaining.length === 0
        ? Effect.logInfo(`[kill] port ${String(port)}: free`)
        : Effect.logWarning(
            `[kill] port ${String(port)}: still held by ${remaining.join(", ")} — another user's process, or one this shell may not signal.`,
          );
    }
  });
}

function parsePort(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : undefined;
}

const killDevCli = Command.make("kill-dev", {
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("List what would be killed, then exit without signalling anything."),
    Flag.withDefault(false),
  ),
  ports: Argument.integer("port").pipe(
    Argument.withDescription(
      "Ports to free. Defaults to this checkout's dev server and web ports.",
    ),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Kill whatever holds this checkout's dev ports, with its process tree."),
  Command.withHandler((input) => runKillDev(input)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(killDevCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}

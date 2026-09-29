#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalFetch:off globalTimers:off -- A CI probe that drives a packaged app from outside it.
/**
 * T3o: boots the backend of a packaged T3o desktop app and proves it works
 * (card T3O-1).
 *
 * The desktop app runs its server by launching its own executable as Node
 * (`ELECTRON_RUN_AS_NODE=1`) on `apps/server/dist/bin.mjs` inside the app
 * archive, so that is exactly what this does: same executable, same archive,
 * same asar-aware Node. It passes when the server answers HTTP and the board's
 * migration ledger in `boards.sqlite` is populated, i.e. the fork's server
 * (not upstream's) booted and migrated its database.
 *
 *   node scripts/t3o-smoke-packaged-backend.ts --app <installed or extracted app>
 *
 * `--app` is the `.app` bundle on macOS, and the directory holding the app
 * executable on Linux (an extracted AppImage, `/opt/T3o`) and Windows (the
 * NSIS install directory).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { T3O_EXECUTABLE_NAME, T3O_PRODUCT_NAME } from "@t3tools/shared/t3oIdentity";

const BOOT_TIMEOUT_MS = 120_000;

export interface PackagedBackend {
  readonly executable: string;
  readonly entry: string;
}

/** Where the Electron executable and the server entry live in a packaged T3o app. */
export function resolvePackagedBackend(platform: NodeJS.Platform, app: string): PackagedBackend {
  const serverEntry = (archive: string) =>
    NodePath.join(archive, "apps", "server", "dist", "bin.mjs");
  switch (platform) {
    case "darwin":
      return {
        executable: NodePath.join(app, "Contents", "MacOS", T3O_PRODUCT_NAME),
        entry: serverEntry(NodePath.join(app, "Contents", "Resources", "app.asar")),
      };
    case "win32":
      // Windows runs the server from its own sidecar archive, not app.asar.
      return {
        executable: NodePath.join(app, `${T3O_PRODUCT_NAME}.exe`),
        entry: serverEntry(NodePath.join(app, "resources", "server.asar")),
      };
    default:
      return {
        executable: NodePath.join(app, T3O_EXECUTABLE_NAME),
        entry: serverEntry(NodePath.join(app, "resources", "app.asar")),
      };
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

async function waitForHttp(url: string, exited: () => string | null): Promise<number> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit !== null) throw new Error(`The backend exited before answering: ${exit}`);
    try {
      const response = await fetch(url);
      return response.status;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`The backend did not answer ${url} within ${BOOT_TIMEOUT_MS / 1000}s.`);
}

function boardMigrationCount(home: string): number {
  const database = new NodeSqlite.DatabaseSync(NodePath.join(home, "userdata", "boards.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database.prepare("SELECT COUNT(*) AS n FROM t3o_sql_migrations").get() as
      | { readonly n: number }
      | undefined;
    return row?.n ?? 0;
  } finally {
    database.close();
  }
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const appIndex = argv.indexOf("--app");
  const app = appIndex >= 0 ? argv[appIndex + 1] : undefined;
  if (!app) throw new Error("Usage: t3o-smoke-packaged-backend.ts --app <path>");

  // oxlint-disable-next-line t3code/no-global-process-runtime -- A standalone CI probe with no Effect runtime.
  const backend = resolvePackagedBackend(process.platform, NodePath.resolve(app));
  if (!NodeFS.existsSync(backend.executable)) {
    throw new Error(`No app executable at ${backend.executable}.`);
  }

  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-smoke-"));
  const port = await freePort();
  const output: string[] = [];
  let exit: string | null = null;
  const child = NodeChildProcess.spawn(
    backend.executable,
    [backend.entry, "serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", T3CODE_HOME: home },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.once("exit", (code, signal) => {
    exit = `code ${String(code)}, signal ${String(signal)}`;
  });

  try {
    const status = await waitForHttp(`http://127.0.0.1:${port}/`, () => exit);
    if (status >= 500) throw new Error(`The backend answered HTTP ${status}.`);
    const migrations = boardMigrationCount(home);
    if (migrations === 0) throw new Error("The board migration ledger is empty.");
    console.log(
      `[t3o-smoke] ${backend.executable}: answered HTTP ${status} on ${port}; ${migrations} board migrations applied.`,
    );
  } catch (error) {
    console.error(output.join(""));
    throw error;
  } finally {
    child.kill();
    NodeFS.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

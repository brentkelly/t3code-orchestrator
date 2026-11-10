// @effect-diagnostics nodeBuiltinImport:off - a standalone entry with no Effect runtime.
// @effect-diagnostics globalConsole:off - writes its one error line straight to stderr.
/**
 * T3o (T3O-58): `node dist/t3oGitCredential.mjs [--file <gitenv>] get|store|erase` is a git
 * credential helper; `... gh <args>` runs the real gh with the gitenv token for its repo.
 * Its own bundle entry so git and gh never wait for the server CLI to boot.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import { initGitenvFile } from "@t3tools/shared/gitenv";

import {
  credentialAnswer,
  findRealGh,
  ghToken,
  parseCredentialRequest,
  resolveGitenvFile,
} from "./t3o/gitCredential.ts";

// oxlint-disable t3code/no-global-process-runtime -- a plain CLI entry outside any Effect runtime.
const { file, rest } = resolveGitenvFile(process.argv.slice(2), process.env, NodeOS.homedir());
initGitenvFile(file);
const [mode, ...args] = rest;

if (mode === "gh") {
  runGh(args);
} else if (mode === "get" || mode === "store" || mode === "erase") {
  const input = NodeFS.readFileSync(0, "utf8");
  if (mode === "get") {
    const answer = credentialAnswer(parseCredentialRequest(input), process.cwd());
    if (answer !== null) process.stdout.write(answer);
  }
} else {
  console.error("usage: t3oGitCredential.mjs [--file <gitenv>] get|store|erase|gh [args...]");
  process.exit(2);
}

function runGh(ghArgs: ReadonlyArray<string>): void {
  const realGh = findRealGh(
    process.env.PATH,
    [process.argv[1] ?? ""],
    process.platform === "win32" ? "gh.exe" : "gh",
  );
  if (realGh === null) {
    console.error("t3o gh shim: no GitHub CLI found on PATH besides this shim.");
    process.exit(127);
  }
  const match = ghToken(ghArgs, process.env, process.cwd());
  const env = { ...process.env };
  if (match !== undefined) {
    env.GH_TOKEN = match.token;
    // gh prefers GH_TOKEN anyway; dropping the other keeps a stale ambient one out of children.
    delete env.GITHUB_TOKEN;
  }
  const child = NodeChildProcess.spawn(realGh, ghArgs, { stdio: "inherit", env });
  // The terminal sends SIGINT to the whole process group; gh gets it directly.
  process.on("SIGINT", () => {});
  for (const signal of ["SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`t3o gh shim: could not start ${realGh}: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal !== null) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

// @effect-diagnostics nodeBuiltinImport:off
/**
 * The thread gateway is the board's ONE seam onto threads (T3O-58).
 *
 * Swapping the thread engine is meant to be "write another gateway", not "edit
 * the supervisor". That only holds while nothing else in board code reaches
 * past the gateway, so this suite reads the source and fails the build when
 * something does:
 *
 * - no import of upstream orchestration, persistence or provider code outside
 *   `ThreadGatewayV2.ts`;
 * - no SQL against a table the board does not own.
 *
 * Tests and testkits are exempt: a suite that builds the real engine stack has
 * to import it.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

const SERVER_SRC = NodePath.resolve(import.meta.dirname, "..");
const ROOTS = ["board", NodePath.join("mcp", "toolkits", "board")];

/** The gateway implementation itself — the one place the thread engine lives. */
const GATEWAY_IMPLEMENTATION = NodePath.join("board", "ThreadGatewayV2.ts");

/**
 * Upstream modules board code may still import, with the reason. Each is an
 * error type for the board's OWN storage, not a way to reach threads.
 */
const ALLOWED_UPSTREAM_IMPORTS = new Map([
  ["persistence/Errors.ts", "the SQL error type the board's own tables fail with"],
  [
    "orchestration-v2/ThreadManagementService.ts",
    "named in the board MCP tools' dependencies, which McpToolAccess requires of every tool",
  ],
]);

/**
 * Files whose SQL reads upstream's database file on purpose, with the reason.
 * None of them touches a thread.
 */
const ALLOWED_UPSTREAM_SQL = new Map([
  [
    NodePath.join("board", "boardDatabase.ts"),
    "moves pre-t3o-26 board tables and the board ledger out of upstream's file",
  ],
  [NodePath.join("board", "migrations"), "one-time copies of legacy board rows out of main"],
]);

const isProductionSource = (file: string) =>
  file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".testkit.ts");

const listSources = (root: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(NodePath.join(SERVER_SRC, root), { recursive: true, encoding: "utf8" })
    .map((entry) => NodePath.join(root, entry))
    .filter(isProductionSource);

const sources = ROOTS.flatMap(listSources);

/** Source without comments, so prose that names an upstream table is fine. */
const code = (file: string) =>
  NodeFS.readFileSync(NodePath.join(SERVER_SRC, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

const upstreamImports = (file: string): ReadonlyArray<string> => {
  const found: Array<string> = [];
  for (const match of code(file).matchAll(/from\s+"([^"]+)"/g)) {
    const specifier = match[1]!;
    if (!specifier.startsWith(".")) continue;
    const target = NodePath.relative(
      SERVER_SRC,
      NodePath.resolve(NodePath.dirname(NodePath.join(SERVER_SRC, file)), specifier),
    );
    if (/^(orchestration(-v2)?|persistence|provider)[\\/]/.test(target)) found.push(target);
  }
  return found;
};

/** A schema-qualified `main.` reference, or an upstream table by name. */
const UPSTREAM_SQL = /\bmain\.\w+|\b(?:projection_(?!state\b)\w+|orchestration_\w+)\b/g;

describe("the thread gateway boundary", () => {
  it("finds the board's sources", () => {
    assert.isAbove(sources.length, 20);
    assert.include(sources, GATEWAY_IMPLEMENTATION);
    assert.include(sources, NodePath.join("board", "supervisorReactor.ts"));
  });

  it("only the gateway imports upstream orchestration, persistence or provider code", () => {
    const offenders = sources
      .filter((file) => file !== GATEWAY_IMPLEMENTATION)
      .flatMap((file) =>
        upstreamImports(file)
          .filter((target) => !ALLOWED_UPSTREAM_IMPORTS.has(target.split(NodePath.sep).join("/")))
          .map((target) => `${file} imports ${target}`),
      );
    assert.deepStrictEqual(offenders, []);
  });

  it("no board SQL outside the gateway names a table the board does not own", () => {
    const allowed = (file: string) =>
      file === GATEWAY_IMPLEMENTATION ||
      [...ALLOWED_UPSTREAM_SQL.keys()].some(
        (prefix) => file === prefix || file.startsWith(prefix + NodePath.sep),
      );
    const offenders = sources
      .filter((file) => !allowed(file))
      .flatMap((file) =>
        [...code(file).matchAll(UPSTREAM_SQL)].map((match) => `${file}: ${match[0]}`),
      );
    assert.deepStrictEqual(offenders, []);
  });

  it("catches an offender — the instrument is not blind", () => {
    const gatewayImports = upstreamImports(GATEWAY_IMPLEMENTATION);
    assert.isTrue(gatewayImports.some((target) => target.startsWith("orchestration")));
    // The v2 gateway reads through upstream's services and runs no SQL of its own,
    // so the SQL instrument is proved on a statement that names upstream's table.
    assert.isAbove(
      [..."SELECT * FROM orchestration_v2_projection_threads".matchAll(UPSTREAM_SQL)].length,
      0,
    );
  });
});

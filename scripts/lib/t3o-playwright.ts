// @effect-diagnostics nodeBuiltinImport:off - plain Node, shared by the readiness check and CI.
/* oxlint-disable t3code/no-global-process-runtime -- standalone Node scripts; no Effect runtime. */
// T3o: where the web browser tests' headless chromium should be, for the Playwright that
// apps/web resolves. The readiness check reports it; CI's install step installs it.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { headlessShellDir } from "./t3o-ready.ts";

/** The `playwright-core` directory apps/web's `playwright` resolves, or null before install. */
export function playwrightCore(root: string): string | null {
  try {
    const web = NodeModule.createRequire(NodePath.join(root, "apps/web/package.json"));
    const playwright = web.resolve("playwright/package.json");
    return NodePath.dirname(
      NodeModule.createRequire(playwright).resolve("playwright-core/package.json"),
    );
  } catch {
    return null;
  }
}

export function browsersRoot(): string {
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured && configured !== "0") return configured;
  if (process.platform === "darwin")
    return NodePath.join(NodeOS.homedir(), "Library/Caches/ms-playwright");
  if (process.platform === "win32") {
    return NodePath.join(process.env.LOCALAPPDATA ?? NodeOS.homedir(), "ms-playwright");
  }
  return NodePath.join(
    process.env.XDG_CACHE_HOME ?? NodePath.join(NodeOS.homedir(), ".cache"),
    "ms-playwright",
  );
}

export type TestBrowser =
  | { readonly kind: "no-playwright" }
  | { readonly kind: "installed" | "missing"; readonly dir: string; readonly path: string };

/** Whether the headless shell the browser tests launch is in Playwright's browser cache. */
export function testBrowser(root: string): TestBrowser {
  const core = playwrightCore(root);
  if (core === null) return { kind: "no-playwright" };
  const manifest = JSON.parse(NodeFS.readFileSync(NodePath.join(core, "browsers.json"), "utf8"));
  const dir = headlessShellDir(manifest) ?? "chromium_headless_shell";
  const path = NodePath.join(browsersRoot(), dir);
  return { kind: NodeFS.existsSync(path) ? "installed" : "missing", dir, path };
}

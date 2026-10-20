// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3o (t3o-34): a Claude session in a project the gitenv file names runs its
 * `gh` calls as that project's identity. The other adapters carry the same
 * seam on their spawn environments.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { initGitenv, resetGitenvForTesting } from "@t3tools/shared/gitenv";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeClaudeQueryOptions } from "./ClaudeAdapterV2.ts";

const TOKEN = "ghp_claudeSeamProofToken0123456789";

describe("Claude query options and the gitenv file", () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-claude-gitenv-"));
  const project = NodePath.join(stateDir, "project");
  NodeFS.mkdirSync(NodePath.join(project, ".git"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(stateDir, "gitenv"), `${project}=${TOKEN}\n`, {
    mode: 0o600,
  });
  afterEach(() => resetGitenvForTesting());

  const options = (cwd: string | null) =>
    makeClaudeQueryOptions({
      modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-4-6" },
      nativeThreadId: "native-1",
      resume: false,
      cwd,
      environment: { PATH: "/usr/bin" },
    });

  it("gives a session in a named project its token, over the instance environment", () => {
    initGitenv(stateDir);
    expect(options(project).env).toEqual({
      PATH: "/usr/bin",
      GH_TOKEN: TOKEN,
      GITHUB_TOKEN: TOKEN,
    });
  });

  it("leaves any other session's environment as it was", () => {
    initGitenv(stateDir);
    expect(options(stateDir).env).toEqual({ PATH: "/usr/bin" });
    expect(options(null).env).toEqual({ PATH: "/usr/bin" });
  });
});

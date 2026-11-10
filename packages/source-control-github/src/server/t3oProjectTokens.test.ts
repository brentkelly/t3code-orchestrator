// @effect-diagnostics nodeBuiltinImport:off - gitenv and origins are real files under a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import { initGitenv, resetGitenvForTesting } from "@t3tools/shared/gitenv";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubAppSignIn from "./GitHubAppSignIn.ts";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as T3oProjectTokens from "./t3oProjectTokens.ts";

const ZEALD_TOKEN = "github_pat_zealdOwner0123456789abcdef";
const DEAD_TOKEN = "github_pat_deadRepo0123456789abcdefgh";

function makeProjects() {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-58-")));
  const project = (name: string, origin: string | null) => {
    const root = NodePath.join(base, name);
    NodeFS.mkdirSync(NodePath.join(root, ".git"), { recursive: true });
    if (origin !== null) {
      NodeFS.writeFileSync(
        NodePath.join(root, ".git", "config"),
        `[remote "origin"]\n\turl = ${origin}\n`,
      );
    }
    return { projectId: ProjectId.make(name), title: name, workspaceRoot: root };
  };
  const stateDir = NodePath.join(base, "state");
  NodeFS.mkdirSync(stateDir);
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "gitenv"),
    `github.com/Zeald=${ZEALD_TOKEN}\ngithub.com/Zeald/dead=${DEAD_TOKEN}\n`,
    { mode: 0o600 },
  );
  initGitenv(stateDir);
  return [
    project("z5", "git@github.com:Zeald/core.z5.git"),
    project("hub", "https://github.com/Zeald/12z.hub"),
    project("dead", "git@github.com:Zeald/dead.git"),
    project("t3o", "git@github.com:brentkelly/t3o.git"),
    project("local", null),
  ];
}

function harness() {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const credentials = Layer.succeed(
    GitHubCredentials.GitHubCredentials,
    GitHubCredentials.GitHubCredentials.of({
      get: (host) =>
        Effect.succeed({
          host,
          token: Redacted.make("ambient"),
          source: "gh" as const,
          fingerprint: `${host}:ambient`,
        }),
      saved: () => Effect.succeedNone,
      fingerprint: (host, token) => Effect.succeed(`${host}:${token}`),
      invalidate: () => Effect.void,
    }),
  );
  const appSignIn = Layer.mock(GitHubAppSignIn.GitHubAppSignIn)({
    enabled: false,
    token: () => Effect.succeedNone,
    invalidate: () => Effect.void,
  });
  const logins: Record<string, string> = {
    [`Bearer ${ZEALD_TOKEN}`]: "zeald-bot",
    "Bearer ambient": "brentkelly",
  };
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      const login = logins[request.headers.authorization ?? ""];
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(login === undefined ? { message: "Bad" } : { login }), {
            status: login === undefined ? 401 : 200,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );
  const layer = GitHubRest.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, appSignIn, http)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return { layer, requests };
}

afterEach(() => {
  resetGitenvForTesting();
});

describe("T3oProjectTokens", () => {
  it.effect("labels each project's source and checks each distinct token once", () => {
    const projects = makeProjects();
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      const status = yield* T3oProjectTokens.make;
      const rows = yield* status(projects);
      expect(rows.map(({ projectId, ...row }) => row)).toEqual([
        {
          title: "z5",
          repo: "Zeald/core.z5",
          entryKey: "github.com/Zeald",
          source: "owner",
          check: { status: "ok", login: "zeald-bot" },
        },
        {
          title: "hub",
          repo: "Zeald/12z.hub",
          entryKey: "github.com/Zeald",
          source: "owner",
          check: { status: "ok", login: "zeald-bot" },
        },
        {
          title: "dead",
          repo: "Zeald/dead",
          entryKey: "github.com/Zeald/dead",
          source: "repo",
          check: { status: "rejected" },
        },
        {
          title: "t3o",
          repo: "brentkelly/t3o",
          entryKey: null,
          source: "gh",
          check: { status: "ok", login: "brentkelly" },
        },
        {
          title: "local",
          repo: null,
          entryKey: null,
          source: "none",
          check: { status: "no-remote" },
        },
      ]);
      // z5 and hub share the owner token: three distinct tokens, three requests.
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(rows)).not.toContain(ZEALD_TOKEN);
    }).pipe(Effect.provide(layer));
  });
});

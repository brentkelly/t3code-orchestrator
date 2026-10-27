// @effect-diagnostics nodeBuiltinImport:off - gitenv reads a real file under a temp state dir.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { initGitenv, resetGitenvForTesting } from "@t3tools/shared/gitenv";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";
import {
  T3oGitenvProject,
  t3oGitenvBatchKey,
  t3oWithGitenvProject,
} from "./t3oGitenvCredential.ts";

const PROJECT_TOKEN = "github_pat_projectToken0123456789";

/** A project with a gitenv entry, one without, and the state dir holding the file. */
function makeFixture() {
  const base = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-67-")));
  const stateDir = NodePath.join(base, "state");
  const project = NodePath.join(base, "project");
  const other = NodePath.join(base, "other");
  for (const dir of [stateDir, NodePath.join(project, ".git"), NodePath.join(other, ".git")]) {
    NodeFS.mkdirSync(dir, { recursive: true });
  }
  NodeFS.writeFileSync(NodePath.join(stateDir, "gitenv"), `${project}=${PROJECT_TOKEN}\n`, {
    mode: 0o600,
  });
  initGitenv(stateDir);
  return { project, other };
}

function harness(status = 200) {
  const requests: Array<HttpClientRequest.HttpClientRequest> = [];
  const invalidated: Array<string> = [];
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
      invalidate: (host) => Effect.sync(() => void invalidated.push(host)),
    }),
  );
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push(request);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ data: {} }), {
            status,
            headers: { "content-type": "application/json" },
          }),
        ),
      );
    }),
  );
  const layer = GitHubRest.layer.pipe(
    Layer.provide(Layer.mergeAll(credentials, http)),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
  );
  return { layer, requests, invalidated };
}

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

afterEach(() => {
  resetGitenvForTesting();
});

describe("GitHubRequestPolicy.credential under gitenv", () => {
  it.effect("uses the project's gitenv token and keeps its fingerprint apart", () => {
    const { project } = makeFixture();
    const { layer, requests } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const held = yield* api
        .credential("GitHub.com")
        .pipe(Effect.provideService(T3oGitenvProject, project));
      expect(Redacted.value(held.token)).toBe(PROJECT_TOKEN);
      expect(held.fingerprint).toBe(`github.com:${sha256(PROJECT_TOKEN)}`);

      // Every request through the policy (REST here, GraphQL alike) carries the project's token.
      yield* api
        .rest({ host: "github.com", operation: "mergePullRequest", path: "user" })
        .pipe(Effect.provideService(T3oGitenvProject, project));
      expect(requests[0]!.headers.authorization).toBe(`Bearer ${PROJECT_TOKEN}`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to the host credential without a project, an entry, or github.com", () => {
    const { project, other } = makeFixture();
    const { layer } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const ambient = (held: { readonly token: Redacted.Redacted<string> }) =>
        expect(Redacted.value(held.token)).toBe("ambient");
      ambient(yield* api.credential("github.com"));
      ambient(
        yield* api.credential("github.com").pipe(Effect.provideService(T3oGitenvProject, other)),
      );
      // gitenv is github.com-only: an enterprise host never receives the project's token.
      ambient(
        yield* api
          .credential("git.acme.internal")
          .pipe(Effect.provideService(T3oGitenvProject, project)),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a pinned credential still outranks gitenv", () => {
    const { project } = makeFixture();
    const { layer } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const held = yield* api.credential("github.com").pipe(
        Effect.provideService(T3oGitenvProject, project),
        Effect.provideService(GitHubRequestPolicy.PinnedGitHubCredential, {
          host: "github.com",
          token: Redacted.make("pinned"),
          credentialFingerprint: "github.com:pinned",
        }),
      );
      expect(Redacted.value(held.token)).toBe("pinned");
    }).pipe(Effect.provide(layer));
  });
});

describe("a refused token", () => {
  it.effect("keeps the ambient cache when GitHub refuses the gitenv token", () => {
    const { project } = makeFixture();
    const { layer, invalidated } = harness(401);
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const read = api.rest({ host: "github.com", operation: "read", path: "user" });
      yield* Effect.flip(read.pipe(Effect.provideService(T3oGitenvProject, project)));
      expect(invalidated).toEqual([]);
      // The ambient token itself refused still drops the cache, as upstream intends.
      yield* Effect.flip(read);
      expect(invalidated).toEqual(["github.com"]);
    }).pipe(Effect.provide(layer));
  });
});

describe("t3oWithGitenvProject", () => {
  it.effect("runs each Effect method under its call's cwd and leaves the rest alone", () => {
    const service = t3oWithGitenvProject({
      kind: "github",
      read: (_input: { readonly cwd: string }) => Effect.service(T3oGitenvProject),
      bare: () => Effect.service(T3oGitenvProject),
      rewrite: (input: { readonly cwd: string }) => `plain ${input.cwd}`,
    });
    return Effect.gen(function* () {
      expect(service.kind).toBe("github");
      expect(yield* service.read({ cwd: "/repo" })).toBe("/repo");
      expect(yield* service.bare()).toBeNull();
      expect(service.rewrite({ cwd: "/repo" })).toBe("plain /repo");
    });
  });
});

describe("t3oGitenvBatchKey", () => {
  it("names the matched checkout, and nothing when no entry applies", () => {
    const { project, other } = makeFixture();
    expect(t3oGitenvBatchKey(Context.make(T3oGitenvProject, project))).toBe(project);
    expect(t3oGitenvBatchKey(Context.make(T3oGitenvProject, other))).toBe("");
    expect(t3oGitenvBatchKey(Context.empty())).toBe("");
  });
});

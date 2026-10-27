/**
 * T3O-24: the board resolves its pull requests on `origin`, not on the
 * project identity, which upstream points at an `upstream` remote first.
 */
import { type RepositoryIdentity, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { boardRepositoryOf } from "./boardRepository.ts";

function identity(
  canonicalKey: string,
  remoteName: string,
  remoteUrl: string,
  provider = "github",
): RepositoryIdentity {
  const [, owner, name] = canonicalKey.split("/");
  return {
    canonicalKey,
    locator: { source: "git-remote", remoteName, remoteUrl },
    provider: SourceControlProviderKind.make(provider),
    displayName: canonicalKey.split("/").slice(1).join("/"),
    ...(owner ? { owner } : {}),
    ...(name ? { name } : {}),
  };
}

const upstream = identity(
  "github.com/pingdotgg/t3code",
  "upstream",
  "https://github.com/pingdotgg/t3code.git",
);

describe("boardRepositoryOf", () => {
  it("addresses origin in a fork, host-qualified", () => {
    expect(
      boardRepositoryOf(upstream, "git@github.com:brentkelly/t3code-orchestrator.git"),
    ).toEqual({
      repository: "brentkelly/t3code-orchestrator",
      path: "brentkelly/t3code-orchestrator",
      host: "github.com",
    });
  });

  it("is the identity, hostless, when the identity already is origin", () => {
    const own = identity("github.com/acme/repo", "origin", "git@github.com:acme/repo.git");
    expect(boardRepositoryOf(own, "https://github.com/Acme/repo.git")).toEqual({
      repository: "acme/repo",
      path: "acme/repo",
    });
  });

  it("falls back to the identity when there is no origin", () => {
    expect(boardRepositoryOf(upstream, null)).toEqual({
      repository: "pingdotgg/t3code",
      path: "pingdotgg/t3code",
    });
    expect(boardRepositoryOf(upstream, "  ")).toEqual({
      repository: "pingdotgg/t3code",
      path: "pingdotgg/t3code",
    });
  });

  it("resolves origin even for a project with no recognised identity", () => {
    expect(boardRepositoryOf(null, "https://gitlab.com/team/app.git")).toEqual({
      repository: "team/app",
      path: "team/app",
      host: "gitlab.com",
    });
    expect(boardRepositoryOf(null, null)).toBeNull();
  });

  it("keeps a self-hosted Forgejo fork's port, taking the identity's refined kind", () => {
    const forgejoUpstream = identity(
      "code.example/team/repo",
      "upstream",
      "http://code.example:3000/team/repo.git",
      "forgejo",
    );
    expect(boardRepositoryOf(forgejoUpstream, "http://code.example:3000/me/repo.git")).toEqual({
      repository: "me/repo",
      path: "me/repo",
      host: "code.example:3000",
    });
  });
});

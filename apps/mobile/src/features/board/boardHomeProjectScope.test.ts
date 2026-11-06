import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHomeProjectScopes } from "../home/homeThreadList";
import { boardProjectIdsForHomeScope } from "./boardHomeProjectScope";

const envA = EnvironmentId.make("environment-a");
const envB = EnvironmentId.make("environment-b");
const projectLocal = ProjectId.make("project-local");
const projectRemote = ProjectId.make("project-remote");

function project(
  environmentId: EnvironmentId,
  id: ProjectId,
  title: string,
  repositoryIdentity?: EnvironmentProject["repositoryIdentity"],
): EnvironmentProject {
  return {
    environmentId,
    id,
    title,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: repositoryIdentity ?? null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("boardProjectIdsForHomeScope", () => {
  it("returns null when Home has no project filter", () => {
    expect(
      boardProjectIdsForHomeScope({
        scopes: [],
        selectedProjectKey: null,
        environmentId: envA,
      }),
    ).toBeNull();
  });

  it("does not fall through to every project when the Home key is a scope key", () => {
    const projects = [
      project(envA, projectLocal, "t3code", {
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:pingdotgg/t3code.git",
        },
      }),
      project(envB, projectRemote, "t3code", {
        canonicalKey: "github.com/pingdotgg/t3code",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:pingdotgg/t3code.git",
        },
      }),
    ];
    const scopes = buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: "repository",
    });
    expect(scopes).toHaveLength(1);
    const selectedProjectKey = scopes[0]!.key;
    expect(selectedProjectKey === projectLocal).toBe(false);
    expect(selectedProjectKey).not.toBe(`${envA}:${projectLocal}`);

    expect(
      boardProjectIdsForHomeScope({
        scopes,
        selectedProjectKey,
        environmentId: envA,
      }),
    ).toEqual([projectLocal]);
  });

  it("returns an empty list when the selected key matches no scope", () => {
    const scopes = buildHomeProjectScopes({
      projects: [project(envA, projectLocal, "t3code")],
      environmentId: envA,
      projectGroupingMode: "separate",
    });
    expect(
      boardProjectIdsForHomeScope({
        scopes,
        selectedProjectKey: "missing-scope",
        environmentId: envA,
      }),
    ).toEqual([]);
  });
});

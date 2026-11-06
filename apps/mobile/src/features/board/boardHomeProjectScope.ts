import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { findHomeProjectScope, type HomeProjectScope } from "../home/homeThreadList";

/**
 * Home's selected project key is a scope key from `buildHomeProjectScopes`
 * (repository grouping, or `environmentId:` plus a workspace path). Board
 * cards are keyed by `project.id`. Map the Home filter onto the project ids
 * that belong to this environment in that scope.
 *
 * `null` selected key → unscoped (`null`). A key that matches no scope →
 * empty list, so the board does not fall through to every project.
 */
export function boardProjectIdsForHomeScope(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedProjectKey: string | null;
  readonly environmentId: EnvironmentId;
}): ReadonlyArray<ProjectId> | null {
  if (input.selectedProjectKey === null) return null;
  const scope = findHomeProjectScope(input.scopes, input.selectedProjectKey);
  if (scope === null) return [];
  return scope.projects
    .filter((project) => project.environmentId === input.environmentId)
    .map((project) => project.id);
}

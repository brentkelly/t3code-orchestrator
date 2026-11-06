import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { ProjectId, type EnvironmentId } from "@t3tools/contracts";

import { findHomeProjectScope, type HomeProjectScope } from "../home/homeThreadList";
import { getProjectScopeSelectionTarget } from "../threads/new-task-project-selection";

/**
 * Map Home's scope key to this environment's project ids.
 * Null key is unscoped; an unmatched key is empty, never every project.
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

/**
 * New-card project: unscoped Home uses this environment's first project;
 * a selected scope uses Home's picker target on this connected environment.
 */
export function boardCreateProjectForHomeScope(input: {
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedProjectKey: string | null;
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}): EnvironmentProject | null {
  if (input.selectedProjectKey === null) {
    return input.projects.find((project) => project.environmentId === input.environmentId) ?? null;
  }
  const scope = findHomeProjectScope(input.scopes, input.selectedProjectKey);
  if (scope === null) return null;
  const target = getProjectScopeSelectionTarget(
    scope,
    input.environmentId,
    new Set([input.environmentId]),
  );
  return target.environmentId === input.environmentId ? target : null;
}

/**
 * Encode the Home scope for the archive route. `null` omits the param
 * (every project). `[]` becomes `""`, which parse must keep as empty rather
 * than treating as unscoped.
 */
export function encodeBoardArchiveProjectIds(
  projectIds: ReadonlyArray<ProjectId> | null,
): string | undefined {
  if (projectIds === null) return undefined;
  return projectIds.join(",");
}

export function parseBoardArchiveProjectIds(
  value: string | undefined,
): ReadonlyArray<ProjectId> | null {
  if (value === undefined) return null;
  if (value.length === 0) return [];
  const ids: ProjectId[] = [];
  for (const part of value.split(",")) {
    if (part.length === 0) continue;
    try {
      ids.push(ProjectId.make(part));
    } catch {
      return [];
    }
  }
  return ids;
}

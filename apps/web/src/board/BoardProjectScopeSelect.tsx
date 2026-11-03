/**
 * The project scope picker the root board and the List view share
 * (`?project`): All projects, or one. A stale deep link (a deleted, hidden or
 * other environment's project) keeps a visible entry so the user can switch
 * back to All projects.
 */
import type { ProjectIconColor, ProjectId } from "@t3tools/contracts";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { cn } from "../lib/utils";
import { projectAccent } from "./projectAccent";

const ALL_PROJECTS = "__all__";

export function BoardProjectScopeSelect({
  projects,
  scopeProjectId,
  scopeIsStale,
  scopeIsHidden,
  accentNameFor,
  onChange,
}: {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly scopeProjectId: ProjectId | null;
  readonly scopeIsStale: boolean;
  readonly scopeIsHidden: boolean;
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
  readonly onChange: (projectId: string | null) => void;
}) {
  const staleLabel = scopeIsHidden ? "Hidden project" : "Unknown project";
  return (
    <Select
      items={[
        { value: ALL_PROJECTS, label: "All projects" },
        ...projects.map((project) => ({ value: project.id as string, label: project.title })),
        ...(scopeIsStale && scopeProjectId !== null
          ? [{ value: scopeProjectId as string, label: staleLabel }]
          : []),
      ]}
      modal={false}
      onValueChange={(value: string | null) =>
        onChange(value === null || value === ALL_PROJECTS ? null : value)
      }
      value={scopeProjectId ?? ALL_PROJECTS}
    >
      <SelectTrigger aria-label="Project scope" size="xs" variant="ghost">
        <span
          className={cn(
            "size-2 rounded-full",
            scopeProjectId === null
              ? "bg-muted-foreground/40"
              : projectAccent(scopeProjectId, accentNameFor(scopeProjectId)).dot,
          )}
        />
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            <span className="inline-flex items-center gap-1.5">
              <span
                className={cn(
                  "size-2 rounded-full",
                  projectAccent(project.id, accentNameFor(project.id)).dot,
                )}
              />
              {project.title}
            </span>
          </SelectItem>
        ))}
        {scopeIsStale && scopeProjectId !== null ? (
          <SelectItem value={scopeProjectId}>{staleLabel}</SelectItem>
        ) : null}
      </SelectPopup>
    </Select>
  );
}

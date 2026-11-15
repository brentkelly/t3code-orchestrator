/**
 * T3o: Settings → Board → Projects: each board project's card key prefix and visibility, with
 * links to its own pages (pipeline, CI, resources, t3o.json import) and its icon and colour.
 */
import {
  DEFAULT_BOARD_KEY_PREFIX,
  type BoardSettings,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { EyeIcon, EyeOffIcon, SettingsIcon, WorkflowIcon } from "lucide-react";
import * as Option from "effect/Option";

import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  normalizeKeyPrefixInput,
  setBoardProjectSetting,
} from "../../components/settings/BoardSettingsPanel.logic";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { SettingsSection } from "../../components/settings/settingsLayout";
import { Button } from "../../components/ui/button";
import { useClientSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { environmentShell } from "../../state/shell";
import { projectAccent, projectIconColorOf } from "../projectAccent";
import { BoardButton } from "../ui/BoardButton";
import { BoardInput } from "../ui/BoardInput";
import {
  useBoardEnvironment,
  useBoardSettings,
  useUpdateBoardSettings,
} from "../useBoardEnvironmentId";
import { BoardImportNotices } from "./BoardImportNotice";

export function BoardProjectsPage() {
  const resolution = useBoardEnvironment();
  // Without a reachable board server there is nothing to read or save.
  return resolution.kind === "ready" ? (
    <BoardProjectsSections environmentId={resolution.environmentId} />
  ) : null;
}

function BoardProjectsSections({ environmentId }: { environmentId: EnvironmentId }) {
  const board = useBoardSettings((settings) => settings.board);
  const update = useUpdateBoardSettings();
  return (
    <>
      {/* Committed t3o.json files waiting to import. */}
      <BoardImportNotices />
      <ProjectsSection board={board} environmentId={environmentId} update={update} />
    </>
  );
}

type UpdateFn = ReturnType<typeof useUpdateBoardSettings>;

function ProjectsSection({
  board,
  environmentId,
  update,
}: {
  board: BoardSettings;
  environmentId: EnvironmentId;
  update: UpdateFn;
}) {
  const anchor = searchableSetting("board-projects");
  return (
    <SettingsSection id="board-projects" title={anchor.title} variant="plain">
      <p className="mb-2 max-w-xl px-3 text-board-13 leading-board-1-55 text-muted-foreground/80 sm:px-4">
        The prefix for each project's card keys (e.g. T3 → T3-42). Cards take their colour from the
        project's icon; the gear opens the project's settings to change it. The flow icon opens its
        pipeline and CI. The eye hides a project and its cards from the board without touching them.
      </p>
      <ProjectRows board={board} environmentId={environmentId} update={update} />
    </SettingsSection>
  );
}

function ProjectRows({
  board,
  environmentId,
  update,
}: {
  board: BoardSettings;
  environmentId: EnvironmentId;
  update: UpdateFn;
}) {
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const projects = Option.getOrNull(shellState.snapshot)?.projects ?? [];
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);

  const setProject = (
    projectId: ProjectId,
    patch: Parameters<typeof setBoardProjectSetting>[2],
  ) => {
    update({ board: { projects: setBoardProjectSetting(board.projects, projectId, patch) } });
  };

  if (projects.length === 0) {
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        No projects in this environment yet.
      </p>
    );
  }

  return (
    <div className="mx-3 flex flex-col gap-2 sm:mx-4">
      {projects.map((project) => {
        const entry = board.projects[project.id];
        const hidden = entry?.hidden ?? false;
        return (
          <div
            key={project.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                projectAccent(project.id, projectIconColorOf(project)).dot,
              )}
            />
            <span
              className={cn(
                "min-w-0 truncate text-board-13-5 font-medium",
                hidden ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {project.title}
            </span>
            {hidden ? (
              <span className="shrink-0 rounded-full border border-border px-1.75 py-px text-board-11 font-medium text-muted-foreground">
                Hidden
              </span>
            ) : null}
            <span className="min-w-2 flex-1" />
            <BoardInput
              key={`${project.id}:${entry?.keyPrefix ?? ""}`}
              defaultValue={entry?.keyPrefix ?? ""}
              placeholder={DEFAULT_BOARD_KEY_PREFIX}
              aria-label={`Card key prefix for ${project.title}`}
              className="h-7.5 w-24"
              look="key-prefix"
              onBlur={(event) => {
                const next = normalizeKeyPrefixInput(event.target.value);
                if (next !== (entry?.keyPrefix ?? null))
                  setProject(project.id, { keyPrefix: next });
              }}
            />
            <div className="flex shrink-0 items-center gap-0.5">
              {/* The project's pipeline, CI and t3o.json. */}
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                title={`${project.title} pipeline & CI`}
                aria-label={`Open ${project.title} pipeline & CI`}
                render={
                  <Link
                    to="/settings/board/projects/$projectId/$tab"
                    params={{ projectId: project.id, tab: "pipeline" }}
                  />
                }
              >
                <WorkflowIcon />
              </Button>
              <BoardButton
                variant="ghost"
                size="icon-sm"
                look={hidden ? "muted-pressed" : "muted"}
                title={hidden ? "Show on the board" : "Hide from the board"}
                aria-label={
                  hidden
                    ? `Show ${project.title} on the board`
                    : `Hide ${project.title} from the board`
                }
                aria-pressed={hidden}
                onClick={() => setProject(project.id, { hidden: !hidden })}
              >
                {hidden ? <EyeOffIcon /> : <EyeIcon />}
              </BoardButton>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                title={`${project.title} icon & colour (project settings)`}
                aria-label={`Open ${project.title} project settings`}
                render={
                  <Link
                    to="/projects/$projectKey"
                    params={{
                      projectKey: deriveLogicalProjectKeyFromSettings(
                        { ...project, environmentId },
                        projectGroupingSettings,
                      ),
                    }}
                  />
                }
              >
                <SettingsIcon />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

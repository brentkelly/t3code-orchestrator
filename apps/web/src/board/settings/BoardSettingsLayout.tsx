/**
 * T3o: Settings → Board as a layout: General, Pipeline, Projects, Workers and one page per
 * project. Projects pages pick their project with the settings scope picker's menu.
 */
import { AuthSettingsWriteScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { createContext, useContext, useState } from "react";

import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { ScopeMenu } from "../../components/settings/SettingsScopeSentence";
import { cn } from "../../lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { environmentShell } from "../../state/shell";
import { BoardServerStatusNotice } from "../BoardServerSettings";
import { projectAccent, projectIconColorOf } from "../projectAccent";
import { useBoardEnvironment } from "../useBoardEnvironmentId";

interface BoardSettingsContextValue {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
  /** Projects whose committed t3o.json differs and wasn't dismissed. */
  readonly importWaiting: ReadonlySet<string>;
  readonly setImportWaiting: (projectId: ProjectId, waiting: boolean) => void;
}

const BoardSettingsContext = createContext<BoardSettingsContextValue | null>(null);

/** The board server's environment and whether this client may edit its
    settings. Only rendered under the layout, once the server resolves. */
export function useBoardSettingsContext(): BoardSettingsContextValue {
  const value = useContext(BoardSettingsContext);
  if (value === null) throw new Error("useBoardSettingsContext outside the board settings layout");
  return value;
}

/** The board environment's projects, for the sub-nav and the project pages. */
export function useBoardSettingsProjects(environmentId: EnvironmentId) {
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  return Option.getOrNull(shellState.snapshot)?.projects ?? [];
}

export function BoardSettingsLayout() {
  const resolution = useBoardEnvironment();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    // The Workers table has five columns of meters; it gets the wider page.
    <SettingsPageContainer width={pathname === "/settings/board/workers" ? "expanded" : "readable"}>
      {/* Which server's board this device shows, and whether it is reachable. */}
      <BoardServerStatusNotice className="mx-3 sm:mx-4" />
      {resolution.kind === "ready" ? (
        <BoardSettingsReady environmentId={resolution.environmentId} />
      ) : (
        <>
          <Outlet />
          {resolution.kind === "none" ? (
            <p className="px-3 text-sm text-muted-foreground sm:px-4">
              Connect an environment to configure its board.
            </p>
          ) : null}
        </>
      )}
    </SettingsPageContainer>
  );
}

function BoardSettingsReady(props: { readonly environmentId: EnvironmentId }) {
  const canWrite = useEnvironmentScope(props.environmentId, AuthSettingsWriteScope);
  const [importWaiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());
  const value: BoardSettingsContextValue = {
    environmentId: props.environmentId,
    canWrite,
    importWaiting,
    setImportWaiting: (projectId, waiting) =>
      setWaiting((current) => {
        if (current.has(projectId) === waiting) return current;
        const next = new Set(current);
        if (waiting) next.add(projectId);
        else next.delete(projectId);
        return next;
      }),
  };
  return (
    <BoardSettingsContext.Provider value={value}>
      <BoardProjectPicker environmentId={props.environmentId} importWaiting={importWaiting} />
      <Outlet />
    </BoardSettingsContext.Provider>
  );
}

const ALL_PROJECTS = "all";

/** The settings scope picker's look, for the board's projects: All projects is the list, and a
    project opens its own page on the tab already open. The board is one server, so there's no
    environment to pick. */
function BoardProjectPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly importWaiting: ReadonlySet<string>;
}) {
  const projects = useBoardSettingsProjects(props.environmentId);
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const match = /^\/settings\/board\/projects\/([^/]+)\/([^/]+)/.exec(pathname);
  if (pathname !== "/settings/board/projects" && match === null) return null;
  const selectedId = match === null ? null : decodeURIComponent(match[1] ?? "");
  const tab = match?.[2] ?? "pipeline";
  const selected = projects.find((project) => project.id === selectedId);
  const dot = (project: (typeof projects)[number]) => (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        projectAccent(project.id, projectIconColorOf(project)).dot,
      )}
    />
  );
  return (
    <p className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 text-sm text-muted-foreground sm:px-4">
      <span className="shrink-0">Applying settings for</span>
      <ScopeMenu
        ariaLabel="Board project"
        icon={selected === undefined ? null : dot(selected)}
        label={selected?.title ?? (selectedId === null ? "All projects" : "Unavailable project")}
        value={selectedId ?? ALL_PROJECTS}
        searchLabel="Search projects"
        allOption={{ value: ALL_PROJECTS, label: "All projects" }}
        options={projects.map((project) => ({
          value: project.id,
          label: project.title,
          ...(props.importWaiting.has(project.id)
            ? { secondary: "A t3o.json is waiting to import" }
            : {}),
          icon: dot(project),
        }))}
        onChange={(next) =>
          void (next === ALL_PROJECTS
            ? navigate({ to: "/settings/board/projects" })
            : navigate({
                to: "/settings/board/projects/$projectId/$tab",
                params: { projectId: next, tab },
              }))
        }
      />
    </p>
  );
}

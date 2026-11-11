/**
 * T3o: Settings → Board as a layout: General and one page
 * per project, under `/settings/board/`. The sub-nav lists the board's
 * projects; a blue dot marks one whose committed `t3o.json` differs from its
 * pipeline (known once General or the project's Import tab has looked).
 */
import { AuthSettingsWriteScope, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { createContext, useContext, useState, type ReactNode } from "react";

import { SettingsPageContainer } from "../../components/settings/settingsLayout";
import { cn } from "../../lib/utils";
import { useEnvironmentScope } from "../../state/session";
import { environmentShell } from "../../state/shell";
import { BoardHint } from "../BoardHint";
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
  return (
    <SettingsPageContainer>
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
      <BoardSettingsNav environmentId={props.environmentId} importWaiting={importWaiting} />
      <Outlet />
    </BoardSettingsContext.Provider>
  );
}

const NAV_LINK =
  "rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-accent hover:text-foreground";
const NAV_ACTIVE = "bg-accent font-medium text-foreground";

function BoardSettingsNav(props: {
  readonly environmentId: EnvironmentId;
  readonly importWaiting: ReadonlySet<string>;
}) {
  const projects = useBoardSettingsProjects(props.environmentId);
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <nav
      aria-label="Board settings"
      className="mx-3 flex flex-wrap items-center gap-1 border-b border-border pb-2 sm:mx-4"
    >
      <NavLink to="/settings/board">General</NavLink>
      {projects.length > 0 ? <span className="mx-1 h-4 w-px bg-border" /> : null}
      {projects.map((project) => (
        <Link
          // Active on every tab of the project's page, not only the one it links to.
          className={cn(
            NAV_LINK,
            "inline-flex items-center gap-1.5",
            pathname.startsWith(`/settings/board/projects/${encodeURIComponent(project.id)}/`) &&
              NAV_ACTIVE,
          )}
          key={project.id}
          params={{ projectId: project.id, tab: "pipeline" }}
          to="/settings/board/projects/$projectId/$tab"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              projectAccent(project.id, projectIconColorOf(project)).dot,
            )}
          />
          {project.title}
          {props.importWaiting.has(project.id) ? (
            <BoardHint label="A t3o.json is waiting to import">
              <span
                aria-label="A t3o.json is waiting to import"
                className="size-1.5 shrink-0 rounded-full bg-attention"
              />
            </BoardHint>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

function NavLink(props: { readonly to: "/settings/board"; readonly children: ReactNode }) {
  return (
    <Link
      activeOptions={{ exact: true }}
      activeProps={{ className: NAV_ACTIVE }}
      className={NAV_LINK}
      to={props.to}
    >
      {props.children}
    </Link>
  );
}

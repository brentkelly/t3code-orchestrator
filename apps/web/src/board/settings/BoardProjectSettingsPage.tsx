/**
 * T3o: Settings → Board → Projects → <project> (T3O-49): the project's
 * differences from the global pipeline, in three deep-linkable tabs —
 * Pipeline (switches and overrides), CI (steps and fix agent) and Import &
 * export (`t3o.json`). Controls need the settings-write scope.
 */
import {
  boardProjectConfigDifferenceCount,
  type BoardProjectStageConfigShell,
  type ProjectId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { Button } from "../../components/ui/button";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { boardToast } from "../boardToast";
import { BoardImportNoticeForProject, useBoardImportCandidates } from "./BoardImportNotice";
import { BoardProjectCiTab } from "./BoardProjectCiTab";
import { BoardProjectImportTab } from "./BoardProjectImportTab";
import { BoardProjectPipelineTab } from "./BoardProjectPipelineTab";
import {
  BOARD_PROJECT_SETTINGS_TABS,
  parseBoardProjectSettingsTab,
  type BoardProjectSettingsTab,
} from "./boardProjectSettings.logic";
import { useBoardSettingsContext, useBoardSettingsProjects } from "./BoardSettingsLayout";
import { useBoardProjectConfig } from "./useBoardProjectConfig";
import { projectAccent, projectIconColorOf } from "../projectAccent";

const TAB_LABELS: Readonly<Record<BoardProjectSettingsTab, string>> = {
  pipeline: "Pipeline",
  ci: "CI",
  import: "Import & export",
};

export function BoardProjectSettingsPage(props: {
  readonly projectId: string;
  readonly tab: string;
}) {
  const { environmentId } = useBoardSettingsContext();
  const projectId = props.projectId as ProjectId;
  const tab = parseBoardProjectSettingsTab(props.tab);
  const project = useBoardSettingsProjects(environmentId).find(
    (candidate) => candidate.id === projectId,
  );
  const config = useBoardProjectConfig(environmentId, projectId);
  const ids = useMemo(() => [projectId], [projectId]);
  const imports = useBoardImportCandidates(ids);
  const tabCounts: Readonly<Record<BoardProjectSettingsTab, number>> = {
    pipeline:
      Object.keys(config.shell.stageSwitches).length + Object.keys(config.shell.overrides).length,
    ci: config.shell.ciSteps.length,
    import: 0,
  };
  if (project === undefined) {
    return (
      <p className="px-3 text-sm text-muted-foreground sm:px-4">No such project on this board.</p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ProjectHeader
        config={config.shell}
        projectId={projectId}
        accentDot={projectAccent(project.id, projectIconColorOf(project)).dot}
        title={project.title}
        lastChangedBy={config.full?.lastChangedBy ?? null}
      />
      <BoardImportNoticeForProject imports={imports} title={project.title} />
      <nav
        aria-label={`${project.title} settings`}
        className="mx-3 flex gap-0.5 border-b border-border sm:mx-4"
      >
        {BOARD_PROJECT_SETTINGS_TABS.map((candidate) => {
          const count = tabCounts[candidate];
          return (
            <Link
              aria-current={candidate === tab ? "page" : undefined}
              className={cn(
                "-mb-px inline-flex items-center gap-1.5 border-b-2 px-2.5 py-2 text-[13px] font-medium",
                candidate === tab
                  ? "border-foreground text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              key={candidate}
              params={{ projectId, tab: candidate }}
              to="/settings/board/projects/$projectId/$tab"
            >
              {TAB_LABELS[candidate]}
              {count > 0 ? (
                <span className="rounded-full bg-accent px-1.5 text-[11px] leading-[18px] font-medium text-muted-foreground tabular-nums">
                  {count}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>
      {tab === "pipeline" ? (
        <BoardProjectPipelineTab
          config={config}
          projectId={projectId}
          projectTitle={project.title}
        />
      ) : tab === "ci" ? (
        <BoardProjectCiTab config={config} projectId={projectId} projectTitle={project.title} />
      ) : (
        <BoardProjectImportTab
          config={config.shell}
          imports={imports}
          projectId={projectId}
          projectTitle={project.title}
        />
      )}
    </div>
  );
}

function ProjectHeader(props: {
  readonly projectId: ProjectId;
  readonly accentDot: string;
  readonly title: string;
  readonly config: BoardProjectStageConfigShell;
  readonly lastChangedBy: {
    readonly actor: { readonly name: string | null; readonly kind: string };
    readonly at: string;
  } | null;
}) {
  const { environmentId, canWrite } = useBoardSettingsContext();
  const reset = useAtomCommand(boardEnvironment.resetProject, { reportFailure: false });
  const [confirming, setConfirming] = useState(false);
  const differences = boardProjectConfigDifferenceCount({
    stageSwitches: props.config.stageSwitches,
    overrides: props.config.overrides,
    ci: {
      steps: props.config.ciSteps as never,
      ...(props.config.ciStopOnFailure === false ? { stopOnFailure: false } : {}),
    },
  });
  const onReset = () => {
    setConfirming(false);
    void reset({
      environmentId,
      input: { projectId: props.projectId, expectedConfigVersion: props.config.version },
    }).then((result) => {
      if (result._tag === "Failure") {
        boardToast({
          title: "Couldn't reset",
          description: describeBoardCommandFailure(result),
          tone: "error",
        });
      }
    });
  };
  return (
    <div className="mx-3 flex flex-wrap items-start gap-x-3 gap-y-1 sm:mx-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <span className={cn("size-2.5 shrink-0 rounded-full", props.accentDot)} />
          {props.title}
        </h2>
        {props.lastChangedBy !== null ? (
          <span className="pl-[18px] text-xs text-muted-foreground">
            Last changed by {props.lastChangedBy.actor.name ?? props.lastChangedBy.actor.kind} ·{" "}
            {new Date(props.lastChangedBy.at).toLocaleString()}
          </span>
        ) : null}
      </div>
      <span className="flex-1" />
      <div className="flex flex-col items-end gap-0.5">
        <span className="text-[13px] text-foreground">
          {differences === 0
            ? "Follows the global pipeline"
            : `${differences} ${differences === 1 ? "difference" : "differences"} from global`}
        </span>
        {canWrite && differences > 0 ? (
          confirming ? (
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                Clear every switch, override and CI step?
              </span>
              <Button size="xs" variant="destructive" onClick={onReset}>
                Reset
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <button
              className="cursor-pointer text-xs text-muted-foreground hover:text-foreground hover:underline"
              onClick={() => setConfirming(true)}
              type="button"
            >
              Reset everything to global…
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

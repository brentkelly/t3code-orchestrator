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
        title={project.title}
        lastChangedBy={config.full?.lastChangedBy ?? null}
      />
      <BoardImportNoticeForProject imports={imports} title={project.title} />
      <nav aria-label={`${project.title} settings`} className="mx-3 flex gap-1 sm:mx-4">
        {BOARD_PROJECT_SETTINGS_TABS.map((candidate) => (
          <Link
            className={cn(
              "rounded-md px-2.5 py-1 text-[13px]",
              candidate === tab
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            key={candidate}
            params={{ projectId, tab: candidate }}
            to="/settings/board/projects/$projectId/$tab"
          >
            {TAB_LABELS[candidate]}
            {candidate === "ci" && config.shell.ciSteps.length > 0 ? (
              <span className="ml-1 text-muted-foreground">{config.shell.ciSteps.length}</span>
            ) : null}
          </Link>
        ))}
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
    ci: { steps: props.config.ciSteps as never },
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
    <div className="mx-3 flex flex-wrap items-center gap-x-3 gap-y-1 sm:mx-4">
      <h2 className="text-base font-semibold text-foreground">{props.title}</h2>
      <span className="text-xs text-muted-foreground">
        {differences === 0
          ? "Follows the global pipeline"
          : `${differences} ${differences === 1 ? "difference" : "differences"} from global`}
      </span>
      {props.lastChangedBy !== null ? (
        <span className="text-xs text-muted-foreground">
          Last changed by {props.lastChangedBy.actor.name ?? props.lastChangedBy.actor.kind} ·{" "}
          {new Date(props.lastChangedBy.at).toLocaleString()}
        </span>
      ) : null}
      <span className="flex-1" />
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
          <Button size="xs" variant="outline" onClick={() => setConfirming(true)}>
            Reset everything to global…
          </Button>
        )
      ) : null}
    </div>
  );
}

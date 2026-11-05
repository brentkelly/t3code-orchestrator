/**
 * T3o: Settings → Board → Project pipelines (T3O-43). One read-only row per
 * project saying what its committed `t3o.json` changes from the global
 * pipeline. Edits happen in the file; the button opens it.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { ChevronDownIcon, ChevronRightIcon, FileCodeIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { BoardHint } from "../../board/BoardHint";
import { useBoardSettings } from "../../board/useBoardEnvironmentId";
import { useOpenInPreferredEditor } from "../../editorPreferences";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { environmentShell } from "../../state/shell";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  boardProjectPipelineSummary,
  type BoardProjectPipelineSummary,
} from "./boardProjectPipelines.logic";

export function BoardProjectPipelinesSection({ environmentId }: { environmentId: EnvironmentId }) {
  const board = useBoardSettings((settings) => settings.board);
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const projects = Option.getOrNull(shellState.snapshot)?.projects ?? [];
  const stages = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const projectStageConfigs = useAtomValue(boardEnvironment.projectStageConfigsAtom(environmentId));
  const summaries = useMemo(() => {
    const view = { stages, projectStageConfigs, cards: [] };
    return projects.map((project) => ({
      project,
      summary: boardProjectPipelineSummary({ view, projectId: project.id, settings: board }),
    }));
  }, [board, projectStageConfigs, projects, stages]);
  if (projects.length === 0) return null;
  return (
    <SettingsSection id="board-project-pipelines" title="Project pipelines" variant="plain">
      <p className="mb-2 max-w-xl px-3 text-[13px] leading-[1.55] text-muted-foreground/80 sm:px-4">
        A project can add stages, drop stages and override stage settings with a t3o.json at its
        repo root. The board reads it from this server's checkout, so a branch's edits apply after
        they merge.
      </p>
      <div className="mx-3 flex flex-col divide-y divide-border rounded-xl border border-border bg-card shadow-xs sm:mx-4">
        {summaries.map(({ project, summary }) => (
          <ProjectPipelineRow
            environmentId={environmentId}
            key={project.id}
            summary={summary}
            title={project.title}
          />
        ))}
      </div>
    </SettingsSection>
  );
}

function ProjectPipelineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly summary: BoardProjectPipelineSummary;
}) {
  const { summary } = props;
  const [open, setOpen] = useState(false);
  const expandable = !summary.followsGlobal;
  return (
    <div className="flex flex-col px-4 py-2.5">
      <button
        className="flex items-center gap-2 text-left disabled:cursor-default"
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {expandable ? (
          open ? (
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 truncate text-[13.5px] text-foreground">{props.title}</span>
        <span className="flex-1" />
        {summary.followsGlobal ? (
          <span className="text-xs text-muted-foreground">Follows the global pipeline exactly</span>
        ) : (
          <span className="flex flex-wrap justify-end gap-1">
            {summary.chips.map((chip) => (
              <Badge key={chip} size="sm" variant="outline">
                {chip}
              </Badge>
            ))}
          </span>
        )}
      </button>
      {open && expandable ? (
        <ProjectPipelineDetail environmentId={props.environmentId} summary={summary} />
      ) : null}
    </div>
  );
}

function ProjectPipelineDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: BoardProjectPipelineSummary;
}) {
  const { summary } = props;
  const { environment } = useSettingsScope();
  const availableEditors = environment?.serverConfig?.availableEditors ?? [];
  const openInEditor = useOpenInPreferredEditor(props.environmentId, availableEditors);
  return (
    <div className="mt-2 flex flex-col gap-3 pl-5.5 text-[12.5px]">
      {summary.warnings.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-warning-foreground">Ignored entries</span>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {summary.warnings.map((warning) => (
              <li className="font-mono text-[11.5px]" key={warning}>
                {warning}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.sequence.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-foreground">Stages</span>
          <div className="flex flex-wrap items-center gap-1">
            {summary.sequence.map((step, index) => (
              <span className="inline-flex items-center gap-1" key={step.stageId}>
                {index === 0 ? null : <span className="text-muted-foreground/60">→</span>}
                <span
                  className={cn(
                    "rounded-md border border-border px-1.5 py-px",
                    step.change === "added" &&
                      "border-foreground/30 bg-foreground/8 text-foreground",
                    step.change === "removed" && "text-muted-foreground line-through",
                  )}
                >
                  {step.label}
                </span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {summary.overrides.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-foreground">Overridden settings</span>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_minmax(0,1.2fr)] gap-x-3 gap-y-1">
            <span className="text-[11px] text-muted-foreground">Setting</span>
            <span className="text-[11px] text-muted-foreground">This project</span>
            <span className="text-[11px] text-muted-foreground">Global</span>
            {summary.overrides.map((override) => (
              <OverrideCells key={`${override.stageLabel}:${override.field}`} {...override} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate font-mono text-[11.5px] text-muted-foreground">
          {summary.path}
          {summary.commitSha === null ? "" : ` @ ${summary.commitSha.slice(0, 10)}`}
        </span>
        <span className="flex-1" />
        <Button
          disabled={summary.path === null || availableEditors.length === 0}
          onClick={async () => {
            if (summary.path === null) return;
            const result = await openInEditor(summary.path);
            if (result._tag === "Success") return;
            toastManager.add({ type: "error", title: "Unable to open t3o.json" });
          }}
          size="xs"
          variant="outline"
        >
          <FileCodeIcon />
          Open t3o.json
        </Button>
      </div>
    </div>
  );
}

function OverrideCells(props: {
  readonly stageLabel: string;
  readonly field: string;
  readonly projectValue: string;
  readonly globalValue: string;
}) {
  return (
    <>
      <BoardHint label={`${props.stageLabel} · ${props.field}`}>
        <span className="min-w-0 truncate text-foreground">
          {props.stageLabel} · <span className="font-mono text-[11.5px]">{props.field}</span>
        </span>
      </BoardHint>
      <BoardHint label={props.projectValue}>
        <span className="min-w-0 truncate text-foreground">{props.projectValue}</span>
      </BoardHint>
      <BoardHint label={props.globalValue}>
        <span className="min-w-0 truncate text-muted-foreground">{props.globalValue}</span>
      </BoardHint>
    </>
  );
}

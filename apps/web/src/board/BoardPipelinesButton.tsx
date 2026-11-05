/**
 * T3o: the All projects view's Pipelines button (T3O-43) — a grid of the
 * projects in view against every stage any of them uses, marking global
 * stages, stages a project's `t3o.json` added, and stages it does not use.
 */
import type { BoardStageView, ProjectIconColor, ProjectId } from "@t3tools/contracts";
import { Columns3Icon } from "lucide-react";
import { useMemo } from "react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { BoardHint } from "./BoardHint";
import {
  boardPipelinesGrid,
  type BoardPipelineCell,
  type BoardPipelineProject,
} from "./boardProjectPipelines";
import { projectAccent } from "./projectAccent";

const CELL_CLASS: Readonly<Record<BoardPipelineCell, string>> = {
  global: "bg-foreground/13",
  added: "bg-foreground/34",
  unused: "shadow-[inset_0_0_0_1px] shadow-foreground/12",
};

const CELL_TIP: Readonly<Record<BoardPipelineCell, string>> = {
  global: "",
  added: " · added in t3o.json",
  unused: " · not in this pipeline",
};

export function BoardPipelinesButton(props: {
  readonly view: BoardStageView;
  readonly projects: ReadonlyArray<BoardPipelineProject>;
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
}) {
  const grid = useMemo(
    () => boardPipelinesGrid(props.view, props.projects),
    [props.view, props.projects],
  );
  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="outline" />}>
        <Columns3Icon />
        Pipelines
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[min(640px,calc(100vw-36px))] p-3.5">
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[12.5px] font-semibold text-foreground">Stages by project</span>
            <span className="text-[11.5px] leading-snug text-muted-foreground">
              The board shows every stage a project in view uses, in pipeline order. Each project's
              stages come from the t3o.json in its repo.
            </span>
          </div>
          <div className="grid grid-cols-[132px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5">
            <span />
            <div className="flex gap-[3px]">
              {grid.stages.map((stage) => (
                <BoardHint key={stage.stageId} label={stage.label}>
                  <span className="min-w-0 flex-1 truncate text-center text-[9.5px] font-medium text-muted-foreground">
                    {stage.label}
                  </span>
                </BoardHint>
              ))}
            </div>
            {grid.rows.map((row) => (
              <PipelineRow
                accentName={props.accentNameFor(row.project.id)}
                cells={row.cells}
                key={row.project.id}
                project={row.project}
                stages={grid.stages}
              />
            ))}
          </div>
          <div className="flex items-center gap-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
            <Legend cell="global" label="Global stage" />
            <Legend cell="added" label="Added by the project" />
            <Legend cell="unused" label="Not used" />
            <span className="flex-1" />
            <span>Settings → Board</span>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function PipelineRow(props: {
  readonly project: BoardPipelineProject;
  readonly accentName: ProjectIconColor | null;
  readonly cells: ReadonlyArray<BoardPipelineCell>;
  readonly stages: ReadonlyArray<{ readonly stageId: string; readonly label: string }>;
}) {
  return (
    <>
      <span className="inline-flex min-w-0 items-center gap-1.5 text-[11.5px] font-medium text-foreground">
        <span
          className={cn(
            "size-[7px] shrink-0 rounded-full",
            projectAccent(props.project.id, props.accentName).dot,
          )}
        />
        <span className="truncate">{props.project.title}</span>
      </span>
      <div className="flex gap-[3px]">
        {props.cells.map((cell, index) => (
          <BoardHint
            key={props.stages[index]?.stageId ?? index}
            label={`${props.stages[index]?.label ?? ""}${CELL_TIP[cell]}`}
          >
            <span className={cn("h-[18px] min-w-0 flex-1 rounded-[5px]", CELL_CLASS[cell])} />
          </BoardHint>
        ))}
      </div>
    </>
  );
}

function Legend(props: { readonly cell: BoardPipelineCell; readonly label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2.5 w-3.5 rounded-[3px]", CELL_CLASS[props.cell])} />
      {props.label}
    </span>
  );
}

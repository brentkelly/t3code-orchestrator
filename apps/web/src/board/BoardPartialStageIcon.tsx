/**
 * T3o: the half-filled circle on a column some, but not all, projects in view
 * use (T3O-49). Its native title gives "N of M projects · only X"; a click
 * opens who is included and who isn't, each row linking to that project's
 * pipeline settings, and "Stage settings" opening the global Pipeline page.
 */
import type { BoardStageId, ProjectIconColor, ProjectId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import type { BoardStageCoverage, BoardStageCoverageEntry } from "./boardProjectPipelines";
import { projectAccent } from "./projectAccent";

export function BoardPartialStageIcon(props: {
  readonly stage: BoardStageId;
  readonly title: string;
  readonly coverage: BoardStageCoverage;
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={props.title}
        className="ml-1 inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/8"
        title={props.title}
      >
        <svg aria-hidden className="size-3" viewBox="0 0 12 12">
          <circle cx="6" cy="6" fill="none" r="4.75" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 1.25 A4.75 4.75 0 0 1 6 10.75 Z" fill="currentColor" />
        </svg>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-[280px] p-3">
        <div className="flex flex-col gap-2 text-[12px]">
          <span className="font-medium text-foreground">{props.title}</span>
          <CoverageList
            accentNameFor={props.accentNameFor}
            entries={props.coverage.included}
            heading="Included"
          />
          <CoverageList
            accentNameFor={props.accentNameFor}
            entries={props.coverage.excluded}
            heading="Not included"
          />
          <Link
            className="border-t border-border pt-2 text-muted-foreground hover:text-foreground"
            hash="board-pipeline"
            to="/settings/board"
          >
            Stage settings ›
          </Link>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function CoverageList(props: {
  readonly heading: string;
  readonly entries: ReadonlyArray<BoardStageCoverageEntry>;
  readonly accentNameFor: (projectId: ProjectId) => ProjectIconColor | null;
}) {
  if (props.entries.length === 0) return null;
  const included = props.heading === "Included";
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
        {props.heading}
      </span>
      {props.entries.map((entry) => (
        <Link
          className="flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-accent"
          key={entry.project.id}
          params={{ projectId: entry.project.id, tab: "pipeline" }}
          to="/settings/board/projects/$projectId/$tab"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              projectAccent(entry.project.id, props.accentNameFor(entry.project.id)).dot,
            )}
          />
          <span className="min-w-0 flex-1 truncate text-foreground">{entry.project.title}</span>
          <span className="text-[11px] text-muted-foreground">
            {entry.how === "switched"
              ? included
                ? "Switched on"
                : "Switched off"
              : included
                ? "On by default"
                : "Off by default"}
          </span>
        </Link>
      ))}
    </div>
  );
}

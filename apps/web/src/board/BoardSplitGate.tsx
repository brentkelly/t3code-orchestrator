/**
 * The split approval gate at the end of the planning thread. Approving creates
 * the children and starts nothing. Planned / Needs planning badges are neutral:
 * they describe content, not a work state.
 */
import type { BoardPlan, BoardSplitRecommendation } from "@t3tools/contracts";
import { CircleAlertIcon, FileCheckIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { BoardHint } from "./BoardHint";
import { boardSplitGateView, type BoardSplitGateSettings } from "./boardSplitGate";

export function BoardSplitGate(props: {
  readonly plans: ReadonlyArray<Pick<BoardPlan, "planId" | "title" | "dependsOn" | "planned">>;
  readonly recommendation: BoardSplitRecommendation;
  readonly ownBranch: string;
  readonly landsOn: string;
  readonly readyLabel: string;
  readonly backlogLabel: string;
  readonly splitRationale: string | null;
  readonly onApprove: (settings: BoardSplitGateSettings) => void;
  readonly onAskForChanges: () => void;
}) {
  const recommended = props.recommendation;
  const [settings, setSettings] = useState<BoardSplitGateSettings>(recommended);
  const view = boardSplitGateView({ ...props, recommendation: recommended, settings });
  return (
    <section
      aria-label="Proposed split"
      className="flex shrink-0 flex-col overflow-hidden rounded-xl border border-attention/50 bg-card shadow-xs"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-2">
        <span className="text-board-13 font-semibold text-foreground">Proposed split</span>
        <span className="truncate text-board-12 text-muted-foreground">
          {view.count} · {view.mix}
        </span>
        <span className="flex-1" />
        <span className="inline-flex shrink-0 items-center gap-1 text-board-11 font-medium text-attention-foreground">
          <CircleAlertIcon className="size-3" />
          Needs your approval
        </span>
      </div>
      {props.splitRationale === null ? null : (
        <p className="border-t border-border px-3 py-2 text-board-12 text-muted-foreground">
          <span className="font-medium text-foreground">Why split: </span>
          {props.splitRationale}
        </p>
      )}
      <ul className="max-h-56 overflow-y-auto">
        {view.rows.map((row) => (
          <li
            className="flex items-center gap-2.5 border-t border-border px-3 py-2"
            key={row.planId}
          >
            <span className="w-5 shrink-0 font-mono text-board-11 text-muted-foreground">
              {row.number}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-board-12-5 font-medium text-foreground">
                {row.title}
              </span>
              {row.after === null ? null : (
                <span className="text-board-11 text-muted-foreground">{row.after}</span>
              )}
            </span>
            {row.planned ? (
              <BoardHint label="Comes with an approved plan">
                <span className="inline-flex h-5 shrink-0 items-center gap-1 rounded-md border border-input bg-card px-1.5 text-board-11 font-medium text-foreground">
                  <FileCheckIcon className="size-3" />
                  Planned
                </span>
              </BoardHint>
            ) : (
              <BoardHint label="Comes with a brief only">
                <span className="inline-flex h-5 shrink-0 items-center rounded-md border border-dashed border-input px-1.5 text-board-11 font-medium text-muted-foreground">
                  Needs planning
                </span>
              </BoardHint>
            )}
            <span className="w-16 shrink-0 text-right text-board-11 font-medium text-muted-foreground">
              {row.lands}
            </span>
          </li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-4 border-t border-border bg-muted px-3 py-2.5">
        <label className="flex cursor-pointer items-start gap-2.5">
          <Switch
            aria-label="Auto-build"
            checked={settings.autoBuild}
            onCheckedChange={(autoBuild) => setSettings({ ...settings, autoBuild })}
            size="sm"
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-board-12 font-medium text-foreground">Auto-build</span>
            <span className="text-board-11-5 leading-board-1-45 text-pretty text-muted-foreground">
              {view.autoBuildNote}
            </span>
          </span>
        </label>
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-board-12 font-medium text-foreground">Merge target</span>
            <span className="flex-1" />
            <span className="truncate font-mono text-board-11 text-foreground">
              {view.resolved}
            </span>
          </div>
          <ToggleGroup
            aria-label="Merge target"
            className="w-full *:flex-1"
            onValueChange={(next) => {
              const value = next[0];
              if (value === "inherit" || value === "own") {
                setSettings({ ...settings, mergeTarget: value });
              }
            }}
            value={[settings.mergeTarget]}
          >
            <Toggle value="inherit">Inherit</Toggle>
            <Toggle value="own">Own branch</Toggle>
          </ToggleGroup>
        </div>
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
        <span className="min-w-0 flex-1 text-board-11-5 leading-board-1-45 text-pretty text-muted-foreground">
          {view.foot}
        </span>
        {view.edited ? (
          <Button onClick={() => setSettings(recommended)} size="sm" variant="ghost-muted">
            Use recommended
          </Button>
        ) : null}
        <Button onClick={props.onAskForChanges} size="sm" variant="outline">
          Ask for changes
        </Button>
        <Button onClick={() => props.onApprove(settings)} size="sm">
          Approve split
        </Button>
      </div>
    </section>
  );
}

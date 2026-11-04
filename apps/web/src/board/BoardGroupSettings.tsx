/**
 * Group settings (T3O-29, the prototype's `groupSettingsVm()`): one set of
 * controls, drawn in the sub-board header's popover and in the group card's
 * popup. Merge target is locked while any descendant has started; auto-merge
 * to trunk is drawn only when the children actually merge into trunk.
 *
 * Each control dispatches `board.card.set-group-settings` with the one field
 * it changes; the decider re-checks the lock and the project rule.
 */
import type { BoardCardShell, BoardState, EnvironmentId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { SettingsIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { boardEnvironment } from "../state/board";
import { useAtomCommand } from "../state/use-atom-command";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import { boardGroupSettingsVm } from "./boardGroups";
import { boardToast } from "./boardToast";

interface BoardGroupSettingsProps {
  readonly environmentId: EnvironmentId;
  readonly card: BoardCardShell;
  readonly shells: ReadonlyArray<BoardCardShell>;
  readonly stages: BoardState;
}

function SettingRow({
  label,
  on,
  note,
  onChange,
}: {
  readonly label: string;
  readonly on: boolean;
  readonly note: string;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <Switch aria-label={label} checked={on} onCheckedChange={onChange} size="sm" />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[12px] font-medium text-foreground">{label}</span>
        <span className="text-[11.5px]/[1.45] text-pretty text-muted-foreground">{note}</span>
      </span>
    </label>
  );
}

export function BoardGroupSettings({
  environmentId,
  card,
  shells,
  stages,
}: BoardGroupSettingsProps) {
  const setGroupSettings = useAtomCommand(boardEnvironment.setGroupSettings);
  const vm = boardGroupSettingsVm(shells, stages, card);
  if (vm === null) return null;
  const set = (patch: {
    readonly target?: "inherit" | "own";
    readonly autoBuild?: boolean;
    readonly autoMerge?: boolean;
    readonly autoPlan?: boolean;
  }) => {
    void setGroupSettings({ environmentId, input: { cardId: card.cardId, ...patch } }).then(
      (result) => {
        if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
        boardToast({
          tone: "error",
          title: `Could not change ${card.key}'s settings`,
          description: describeBoardCommandFailure(result),
        });
      },
    );
  };
  return (
    <div className="flex flex-col gap-3" data-board-group-settings>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[12px] font-medium text-foreground">Merge target</span>
          <span className="flex-1" />
          <span className="truncate font-mono text-[11px] text-foreground">
            → {vm.resolvedTarget}
          </span>
        </div>
        <ToggleGroup
          aria-label="Merge target"
          className="w-full *:flex-1"
          disabled={vm.targetLockReason !== null}
          onValueChange={(next) => {
            const value = next[0];
            if ((value === "inherit" || value === "own") && value !== vm.target) {
              set({ target: value });
            }
          }}
          value={[vm.target]}
        >
          <Toggle value="inherit">Inherit</Toggle>
          <Toggle value="own">Own branch</Toggle>
        </ToggleGroup>
        <span className="text-[11.5px]/[1.45] text-pretty text-muted-foreground">
          {vm.targetLockReason ?? vm.ownReviewNote}
        </span>
      </div>
      <SettingRow
        label="Auto-build"
        note={vm.autoBuild.note}
        on={vm.autoBuild.on}
        onChange={(autoBuild) => set({ autoBuild })}
      />
      {vm.autoMerge === null ? null : (
        <SettingRow
          label="Auto-merge to trunk"
          note={vm.autoMerge.note}
          on={vm.autoMerge.on}
          onChange={(autoMerge) => set({ autoMerge })}
        />
      )}
      <SettingRow
        label="Auto-plan"
        note={vm.autoPlan.note}
        on={vm.autoPlan.on}
        onChange={(autoPlan) => set({ autoPlan })}
      />
    </div>
  );
}

/** The sub-board header's Group settings button and its popover. */
export function BoardGroupSettingsPopover(props: BoardGroupSettingsProps) {
  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="outline" />}>
        <SettingsIcon />
        Group settings
      </PopoverTrigger>
      <PopoverPopup align="end" className="w-[320px] p-3">
        <BoardGroupSettings {...props} />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The Automation section (T3O-38): Auto-plan, Auto-build and Auto-merge as
 * switches, in the card detail's sidebar and — for a group — the sub-board
 * header's popover.
 *
 * A leaf's switches dispatch `board.card.set-automation` on the card; a
 * group's dispatch `board.card.set-group-settings`, which every inheriting
 * child follows live, so a flip that changes work already in flight asks
 * first. The decider re-checks every lock; the rows here only mirror them.
 */
import {
  BoardCardId,
  type BoardAutomationNode,
  type BoardAutomationToggle,
  type BoardCardShell,
  type BoardState,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { boardEnvironment } from "../state/board";
import { useAtomCommand } from "../state/use-atom-command";
import { BoardCollapsibleSection } from "./BoardCardFields";
import { BoardHint } from "./BoardHint";
import {
  boardAutomationRowsSummary,
  boardCardAutomationRows,
  boardGroupAutomationEffects,
  boardGroupAutomationRows,
  boardShellAutomationNode,
  resolveBoardShellAutomation,
  type BoardAutomationRow,
} from "./boardCardAutomation";
import { describeBoardCommandFailure } from "./boardCommandFeedback";
import { boardGroupSettingsVm } from "./boardGroups";
import { boardToast } from "./boardToast";

type AutomationPatch = Partial<Record<BoardAutomationToggle, boolean | null>>;

function reportFailureFor(cardKey: string) {
  return <A, E>(result: AtomCommandResult<A, E>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    boardToast({
      tone: "error",
      title: `Could not change ${cardKey}'s automation`,
      description: describeBoardCommandFailure(result),
    });
  };
}

function useSetCardAutomation(environmentId: EnvironmentId, card: BoardAutomationNode) {
  const setCardAutomation = useAtomCommand(boardEnvironment.setCardAutomation);
  const report = reportFailureFor(card.key ?? card.id);
  return (patch: AutomationPatch) => {
    void setCardAutomation({
      environmentId,
      input: { cardId: BoardCardId.make(card.id), ...patch },
    }).then(report);
  };
}

function AutomationRowView({
  row,
  onChange,
  onInherit,
}: {
  readonly row: BoardAutomationRow;
  readonly onChange: (next: boolean) => void;
  readonly onInherit: () => void;
}) {
  return (
    // A div, not a label: the switch is its own button, and a label wrapping
    // a button makes one row look like one target and behave like two.
    <div className="flex items-start gap-2.5" data-board-automation-row={row.id}>
      <BoardHint label={row.lockReason}>
        <span className="mt-0.5 inline-flex shrink-0">
          <Switch
            aria-label={row.label}
            checked={row.on}
            disabled={row.switchDisabled}
            onCheckedChange={onChange}
            size="sm"
          />
        </span>
      </BoardHint>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-[7px]">
          <span className="text-[12px] font-medium text-foreground">{row.label}</span>
          {row.tag === null ? null : (
            <span className="font-mono text-[10.5px] font-medium text-muted-foreground">
              {row.tag}
            </span>
          )}
        </span>
        <span className="text-[11.5px]/[1.45] text-pretty text-muted-foreground">{row.note}</span>
        {row.canInherit ? (
          <Button className="self-start" onClick={onInherit} size="xs" variant="link">
            Use group's setting
          </Button>
        ) : null}
      </span>
    </div>
  );
}

/** A group flip that changes work in flight, waiting for the human's yes. */
interface PendingGroupChange {
  readonly label: string;
  readonly next: boolean;
  readonly lines: ReadonlyArray<string>;
  readonly apply: () => void;
}

function GroupChangeConfirmDialog({
  groupKey,
  pending,
  onClose,
}: {
  readonly groupKey: string;
  readonly pending: PendingGroupChange | null;
  readonly onClose: () => void;
}) {
  return (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Turn {pending?.next === true ? "on" : "off"} {pending?.label} for {groupKey}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Children that inherit {groupKey}'s setting follow it straight away.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="flex list-disc flex-col gap-1 px-6 pb-4 ps-10 text-[13px] text-foreground">
          {(pending?.lines ?? []).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            autoFocus
            onClick={() => {
              pending?.apply();
              onClose();
            }}
          >
            Turn {pending?.next === true ? "on" : "off"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

interface GroupAutomationProps {
  readonly environmentId: EnvironmentId;
  readonly group: BoardCardShell;
  readonly shells: ReadonlyArray<BoardCardShell>;
  readonly stages: BoardState;
  readonly boardWideAutoMerge: boolean;
}

function groupAutomation(props: GroupAutomationProps) {
  const vm = boardGroupSettingsVm(props.shells, props.stages, props.group, {
    boardWideAutoMerge: props.boardWideAutoMerge,
  });
  const node = boardShellAutomationNode(props.group);
  const ownMerge = resolveBoardShellAutomation({
    shells: props.shells,
    stages: props.stages,
    card: node,
    boardWideAutoMerge: props.boardWideAutoMerge,
  }).autoMerge;
  const rows =
    vm === null ? [] : boardGroupAutomationRows({ vm, groupKey: props.group.key, ownMerge });
  return { vm, node, rows };
}

/** The group's merge target and switches. A flip that changes work in flight
    goes to `requestConfirm`, whose dialog lives outside any popover holding
    this panel, so confirming cannot dismiss the panel mid-click. */
function BoardGroupAutomationPanel(
  props: GroupAutomationProps & {
    readonly requestConfirm: (pending: PendingGroupChange) => void;
  },
) {
  const { environmentId, group } = props;
  const { vm, node, rows } = groupAutomation(props);
  const setGroupSettings = useAtomCommand(boardEnvironment.setGroupSettings);
  const setOwn = useSetCardAutomation(environmentId, node);
  const report = reportFailureFor(group.key);
  if (vm === null) return null;
  const setGroup = (patch: {
    readonly target?: "inherit" | "own";
    readonly autoBuild?: boolean;
    readonly autoMerge?: boolean;
    readonly autoPlan?: boolean;
  }) => {
    void setGroupSettings({ environmentId, input: { cardId: group.cardId, ...patch } }).then(
      report,
    );
  };
  const change = (row: BoardAutomationRow, next: boolean) => {
    if (row.id === "ownMerge") {
      setOwn({ autoMerge: next });
      return;
    }
    const toggle = row.id;
    const apply = () => setGroup({ [toggle]: next });
    const lines = boardGroupAutomationEffects({
      shells: props.shells,
      stages: props.stages,
      group,
      toggle,
      next,
      boardWideAutoMerge: props.boardWideAutoMerge,
    });
    if (lines.length === 0) apply();
    else props.requestConfirm({ label: row.label, next, lines, apply });
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
              setGroup({ target: value });
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
      {rows.map((row) => (
        <AutomationRowView
          key={row.id}
          onChange={(next) => change(row, next)}
          onInherit={() => setOwn({ autoMerge: null })}
          row={row}
        />
      ))}
    </div>
  );
}

/** A leaf card's three switches. */
function CardAutomationRows({
  rows,
  environmentId,
  card,
}: {
  readonly rows: ReadonlyArray<BoardAutomationRow>;
  readonly environmentId: EnvironmentId;
  readonly card: BoardAutomationNode;
}) {
  const set = useSetCardAutomation(environmentId, card);
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => {
        const toggle = row.id === "ownMerge" ? "autoMerge" : row.id;
        return (
          <AutomationRowView
            key={row.id}
            onChange={(next) => set({ [toggle]: next })}
            onInherit={() => set({ [toggle]: null })}
            row={row}
          />
        );
      })}
    </div>
  );
}

/**
 * The detail sidebar's Automation section: collapsed by default, its header
 * naming the toggles that are on. `group` is the card's shell when the card is
 * a group, which swaps in the group's settings.
 */
export function BoardCardAutomation(props: {
  readonly environmentId: EnvironmentId;
  readonly card: BoardAutomationNode;
  readonly group: BoardCardShell | null;
  readonly shells: ReadonlyArray<BoardCardShell>;
  readonly stages: BoardState;
  readonly boardWideAutoMerge: boolean;
  readonly planningFinished: boolean;
  readonly inPlanning: boolean;
}) {
  if (props.group !== null) {
    return <GroupAutomationSection {...props} group={props.group} />;
  }
  const resolved = resolveBoardShellAutomation({
    shells: props.shells,
    stages: props.stages,
    card: props.card,
    boardWideAutoMerge: props.boardWideAutoMerge,
    planningFinished: props.planningFinished,
  });
  const rows = boardCardAutomationRows({ resolved, inPlanning: props.inPlanning });
  return (
    <BoardCollapsibleSection summary={boardAutomationRowsSummary(rows)} title="Automation">
      <CardAutomationRows card={props.card} environmentId={props.environmentId} rows={rows} />
    </BoardCollapsibleSection>
  );
}

function GroupAutomationSection(props: GroupAutomationProps) {
  const { rows } = groupAutomation(props);
  const [pending, setPending] = useState<PendingGroupChange | null>(null);
  return (
    <BoardCollapsibleSection summary={boardAutomationRowsSummary(rows)} title="Automation">
      <BoardGroupAutomationPanel {...props} requestConfirm={setPending} />
      <GroupChangeConfirmDialog
        groupKey={props.group.key}
        onClose={() => setPending(null)}
        pending={pending}
      />
    </BoardCollapsibleSection>
  );
}

/** The sub-board header's Automation button and its popover. */
export function BoardGroupAutomationPopover(props: GroupAutomationProps) {
  const [pending, setPending] = useState<PendingGroupChange | null>(null);
  return (
    <>
      <Popover>
        <PopoverTrigger render={<Button size="xs" variant="outline" />}>
          <SlidersHorizontalIcon />
          Automation
        </PopoverTrigger>
        <PopoverPopup align="end" className="w-[344px] p-3">
          <BoardGroupAutomationPanel {...props} requestConfirm={setPending} />
        </PopoverPopup>
      </Popover>
      <GroupChangeConfirmDialog
        groupKey={props.group.key}
        onClose={() => setPending(null)}
        pending={pending}
      />
    </>
  );
}

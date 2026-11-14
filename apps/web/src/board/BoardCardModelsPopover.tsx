/**
 * The card's per-stage model overrides, keyed by stage id. It renders no trigger:
 * the kebab item and the header pill both open it, and the kebab closes first so
 * `ModelRow`'s own popover and menu do not nest inside a still-open menu.
 */
import type { ReactNode } from "react";

import {
  type BoardCardModelOverrides,
  type BoardCardStageModelOverride,
  type BoardStageId,
  type ProjectId,
} from "@t3tools/contracts";

import {
  ModelRow,
  type ActiveModel,
  type InstanceEntries,
  type ModelOptionsByInstance,
} from "../components/settings/BoardModelRow";
import { boardModelDisplayName } from "../components/settings/boardModelDisplayName";
import { Popover } from "../components/ui/popover";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { useBoardWorkersState } from "./workers/BoardWorkersContext";
import { boardWorkerOnlyProviders } from "./workers/cardWorker";
import type { BoardCardModelRowSpec } from "./boardCardModelRows";
import { useBoardServerProviders, useBoardSettings } from "./useBoardEnvironmentId";
import { BoardPopoverPopup } from "./ui/BoardPopoverPopup";

/**
 * A row with no override names what it defers to and where to change it, never
 * "Select a model", which would read as a required field.
 */
function placeholderFor(
  row: BoardCardModelRowSpec,
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance,
  instanceEntries: InstanceEntries,
): string {
  const later =
    row.laterRounds === null
      ? null
      : boardModelDisplayName(row.laterRounds.model, getModelOptions, instanceEntries);
  if (row.inheritedModel === null) {
    return row.laterRounds === null
      ? "Default (unset in Settings)"
      : `Default (rounds 1–${row.laterRounds.afterRound}), then ${later}`;
  }
  const name = boardModelDisplayName(row.inheritedModel, getModelOptions, instanceEntries);
  if (row.inheritedFromCardKey !== null) {
    return row.laterRounds === null
      ? `${name} (from ${row.inheritedFromCardKey})`
      : `${name} for every round (from ${row.inheritedFromCardKey})`;
  }
  if (row.laterRounds === null) return `${name} (default)`;
  return `${name} (rounds 1–${row.laterRounds.afterRound}), then ${later}`;
}

export function BoardCardModelsPopover({
  open,
  onOpenChange,
  anchor,
  rows,
  overrides,
  onChange,
  stepRunning,
  projectId,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The trigger element the popover positions against. Passed in because this
      popover has two doors — the kebab item and the header pill — and a
      controlled popover can only anchor to one element. */
  readonly anchor: ReactNode;
  readonly rows: ReadonlyArray<BoardCardModelRowSpec>;
  readonly overrides: BoardCardModelOverrides | null;
  /** Writes the whole map; null clears the card back to the workspace
      defaults. The decider normalises an emptied map to null too, so a Reset
      and a clear-the-last-row land in the same state. */
  readonly onChange: (next: BoardCardModelOverrides | null) => void;
  /** Whether a step is in flight, for the "applies to the next run" note.
      Deliberately does NOT disable the controls: setting the model for the next
      round while this one runs is the common intent, not a mistake. */
  readonly stepRunning: boolean;
  /** The card's project (T3O-74): providers turned off for it show disabled. */
  readonly projectId: ProjectId;
}) {
  // Resolved here rather than drilled through the detail view, exactly as the
  // review pane's per-round drawer does — this module is lazily loaded, so the
  // provider list it pulls in costs nothing until the popover is opened.
  const settings = useBoardSettings();
  const ownProviders = useBoardServerProviders();
  // And the instance ids only workers have, so a card can pick a model
  // its worker offers.
  const workers = useBoardWorkersState();
  const serverProviders = [...ownProviders, ...boardWorkerOnlyProviders(workers, ownProviders)];
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(serverProviders),
      settings,
      projectId,
    ),
  );
  const getModelOptions = (active: ActiveModel): ModelOptionsByInstance =>
    getCustomModelOptionsByInstance(settings, serverProviders, active.instanceId, active.model);
  const anySet = rows.some((row) => overrides?.[row.stageId] !== undefined);

  const setRow = (stageId: BoardStageId, next: BoardCardStageModelOverride | null) => {
    const rest = { ...overrides };
    if (next === null) delete rest[stageId];
    else rest[stageId] = next;
    onChange(Object.keys(rest).length === 0 ? null : rest);
  };

  /** Clears only the rows this popover shows; entries for other stages are invisible here. */
  const reset = () => {
    const rest = { ...overrides };
    for (const row of rows) delete rest[row.stageId];
    onChange(Object.keys(rest).length === 0 ? null : rest);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchor}
      <BoardPopoverPopup align="end" className="w-[440px]" inset="3">
        <div className="flex items-center gap-2">
          <span className="text-board-12-5 font-semibold text-foreground">
            Models for this card
          </span>
          <span className="flex-1" />
          {anySet ? (
            <button
              className="h-[22px] shrink-0 rounded-md px-1.75 text-board-11-5 font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={reset}
              type="button"
            >
              Reset
            </button>
          ) : null}
        </div>
        <p className="mt-1.5 text-board-11-5 leading-normal text-pretty text-muted-foreground">
          Overrides the workspace defaults from Settings for this card only.
        </p>
        {rows.map((row) => {
          const override = overrides?.[row.stageId];
          const current = override ?? null;
          return (
            <div className="mt-2.5 flex flex-col" key={row.stageId}>
              <div className="flex items-baseline gap-1.75">
                <span className="text-board-11-5 font-medium text-foreground">{row.label}</span>
                <span className="min-w-0 truncate text-board-11 text-muted-foreground">
                  {row.note}
                </span>
              </div>
              <ModelRow
                ariaLabel={`${row.label} model for this card`}
                getModelOptions={getModelOptions}
                // An override is a model PLUS what it changes: with no
                // model there is nowhere to keep an access level, so the
                // section stays hidden until one is picked — the same rule the
                // per-round drawer follows.
                hideRuntimeMode={current === null}
                instanceEntries={instanceEntries}
                label=""
                modelOptions={current?.options}
                onChange={(selection) =>
                  setRow(
                    row.stageId,
                    selection === null
                      ? null
                      : {
                          ...selection,
                          ...(current?.options === undefined ? {} : { options: current.options }),
                          ...(current?.runtimeMode === undefined
                            ? {}
                            : { runtimeMode: current.runtimeMode }),
                        },
                  )
                }
                onModelOptionsChange={(options) => {
                  if (current === null) return;
                  // `undefined` means the user CLEARED the reasoning selection,
                  // which is a real edit and not "no change": spreading `{}` for
                  // it would leave the stale `options` in place, so clearing
                  // reasoning would silently do nothing.
                  const { options: _dropped, ...withoutOptions } = current;
                  setRow(
                    row.stageId,
                    options === undefined ? withoutOptions : { ...current, options },
                  );
                }}
                onRuntimeModeChange={(runtimeMode) =>
                  setRow(row.stageId, current === null ? null : { ...current, runtimeMode })
                }
                placeholder={placeholderFor(row, getModelOptions, instanceEntries)}
                runtimeMode={
                  current === null
                    ? row.inheritedRuntimeMode
                    : (current.runtimeMode ?? row.stageRuntimeMode)
                }
                selection={
                  current === null ? null : { instanceId: current.instanceId, model: current.model }
                }
              />
              {row.laterRounds !== null &&
              (current !== null || row.inheritedFromCardKey !== null) ? (
                <p className="text-board-11 text-muted-foreground">
                  Runs every round, overriding the later-rounds model from Settings.
                </p>
              ) : null}
            </div>
          );
        })}
        {stepRunning ? (
          <p className="mt-2.5 text-board-11 text-muted-foreground">
            A step is running. It keeps the model it started with. This applies to the next run.
          </p>
        ) : null}
      </BoardPopoverPopup>
    </Popover>
  );
}

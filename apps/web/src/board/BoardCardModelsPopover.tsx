/**
 * The card's per-stage model overrides (t3o-29), opened from the card modal's
 * kebab menu.
 *
 * Two rows — Build and Review — each the same `ModelRow` the pipeline settings
 * and the review pane's per-round drawer use, so model, reasoning and access
 * level all arrive together and look identical everywhere the board sets a
 * model.
 *
 * The rows are role-resolved but the map is keyed by STAGE ID (D1): two rows is
 * a judgement about what belongs in a popover, not a claim about the schema.
 *
 * It renders no trigger of its own. The kebab item and the header pill are both
 * doors into it, and a popover cannot have two triggers, so the caller owns
 * `open`/`onOpenChange` and anchors it. That is also why the kebab CLOSES when
 * this opens: `ModelRow` opens a Popover for the model list and a menu for the
 * traits, and nesting those inside a still-open menu stacks three focus traps
 * where picking a model is an outside-pointerdown on the menu containing it.
 */
import type { ReactNode } from "react";

import { useAtomValue } from "@effect/atom-react";

import {
  type BoardCardModelOverrides,
  type BoardCardStageModelOverride,
  type BoardStageId,
} from "@t3tools/contracts";

import {
  ModelRow,
  type ActiveModel,
  type ModelOptionsByInstance,
} from "../components/settings/BoardModelRow";
import { getTriggerDisplayModelName } from "../components/chat/providerIconUtils";
import { Popover, PopoverPopup } from "../components/ui/popover";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { primaryServerProvidersAtom } from "../state/server";
import { usePrimarySettings } from "../hooks/useSettings";
import type { BoardCardModelRowSpec } from "./boardCardModelRows";

/**
 * The trigger text for a row with no override: the value it will actually run
 * on, and where that came from (D5). Three situations that would otherwise all
 * render as "Select a model".
 *
 * The unnamed case matters most. `ModelRow`'s own default placeholder is
 * "Select a model", which is right where a stage MUST name one — but on an
 * override row it is a lie in both directions: it reads as a required field
 * when leaving it blank is the whole point, and it hides that the workspace
 * has not named a model either. So an override row never says "Select"; it
 * says what it is deferring to, and the place to go fix it.
 */
function placeholderFor(
  row: BoardCardModelRowSpec,
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance,
): string {
  if (row.inheritedModel === null) return "Default (unset in Settings)";
  const active: ActiveModel = {
    instanceId: row.inheritedModel.instanceId,
    model: row.inheritedModel.model,
  };
  const option = getModelOptions(active)
    .get(active.instanceId)
    ?.find((candidate) => candidate.slug === active.model);
  const name = option ? getTriggerDisplayModelName(option) : active.model;
  return row.inheritedFromCardKey === null
    ? `${name} (default)`
    : `${name} (from ${row.inheritedFromCardKey})`;
}

export function BoardCardModelsPopover({
  open,
  onOpenChange,
  anchor,
  rows,
  overrides,
  onChange,
  stepRunning,
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
  /** Whether a step is in flight, for the "applies to the next run" note (D6).
      Deliberately does NOT disable the controls: setting the model for the next
      round while this one runs is the common intent, not a mistake. */
  readonly stepRunning: boolean;
}) {
  // Resolved here rather than drilled through the detail view, exactly as the
  // review pane's per-round drawer does — this module is lazily loaded, so the
  // provider list it pulls in costs nothing until the popover is opened.
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
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

  /** Clear this card's overrides — but only for the rows this popover actually
      shows. The map is keyed by stage id and can in principle hold an entry for
      a stage with no row here; wiping something the user cannot see, and was
      never told about, is not what "Reset" offers to do. It is also the rule
      the summary and the pill already follow, which count visible rows only. */
  const reset = () => {
    const rest = { ...overrides };
    for (const row of rows) delete rest[row.stageId];
    onChange(Object.keys(rest).length === 0 ? null : rest);
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {anchor}
      <PopoverPopup align="end" className="w-[328px] p-3">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold text-foreground">Models for this card</span>
          <span className="flex-1" />
          {anySet ? (
            <button
              className="h-[22px] shrink-0 rounded-md px-[7px] text-[11.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={reset}
              type="button"
            >
              Reset
            </button>
          ) : null}
        </div>
        <p className="mt-1.5 text-[11.5px] leading-[1.5] text-pretty text-muted-foreground">
          Overrides the workspace defaults from Settings for this card only.
        </p>
        {rows.map((row) => {
          const override = overrides?.[row.stageId];
          const current = override ?? null;
          return (
            <div className="mt-2.5 flex flex-col" key={row.stageId}>
              <div className="flex items-baseline gap-[7px]">
                <span className="text-[11.5px] font-medium text-foreground">{row.label}</span>
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                  {row.note}
                </span>
              </div>
              <ModelRow
                ariaLabel={`${row.label} model for this card`}
                getModelOptions={getModelOptions}
                // An override is a model PLUS what it changes (D2): with no
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
                placeholder={placeholderFor(row, getModelOptions)}
                runtimeMode={current?.runtimeMode ?? row.inheritedRuntimeMode}
                selection={
                  current === null ? null : { instanceId: current.instanceId, model: current.model }
                }
              />
            </div>
          );
        })}
        {stepRunning ? (
          <p className="mt-2.5 text-[11px] text-muted-foreground">
            A step is running. It keeps the model it started with — this applies to the next run.
          </p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The board's model-picker row, shared by the pipeline settings panel and the
 * card Review pane's per-round override drawer (t3o-22, D4).
 *
 * It lives in its own module rather than in `BoardPipelineSection` because the
 * Review pane is lazily loaded — a card that never reaches review is supposed
 * to pay nothing for it — and importing the row from the settings section
 * dragged the whole board-pipeline panel, its prompt envelopes and its dialogs
 * into the pane's chunk.
 */
import { useState } from "react";

import { ProviderInstanceId, type RuntimeMode } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import type { ProviderOptionSelection } from "@t3tools/contracts";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { sortProviderInstanceEntries } from "../../providerInstances";
import { cn } from "../../lib/utils";
import { AccessLevelPicker } from "../chat/AccessLevelPicker";
import { ModelPickerContent } from "../chat/ModelPickerContent";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export type InstanceEntries = ReturnType<typeof sortProviderInstanceEntries>;
export type ActiveModel = { instanceId: ProviderInstanceId; model: string };
export type ModelOptionsByInstance = ReturnType<typeof getCustomModelOptionsByInstance>;
export type ModelSelection = ActiveModel | null;

/** The stand-in instance a row with nothing picked opens its popup on. */
const EMPTY_INSTANCE_ID = ProviderInstanceId.make("none");

/**
 * The model row. A stage names the model it runs on EXPLICITLY — there is no
 * "Default" state to fall into, because the board never had a default worth
 * advertising: the old one was a compiled-in codex + `gpt-5.6-luna` pair the
 * user may never have enabled, so "Default" named a model that could not run.
 * An unset stage reads "Select a model" and, while the stage auto-executes,
 * says so in the same required-field language the prompt uses.
 *
 * The trigger is local rather than `ProviderModelPicker`'s, which always
 * renders a concrete model name (falling back to the instance's first option)
 * and so cannot show "nothing picked yet". The popup is the app's own
 * `ModelPickerContent`, so the list, search and favourites are identical.
 */
export function ModelRow(props: {
  label: string;
  ariaLabel: string;
  selection: ModelSelection;
  requiredMessage?: string | null;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  onChange: (selection: ModelSelection) => void;
  /** Reasoning/effort selections for the chosen model, and the setter (t3o-21).
      Rendered as the composer's TraitsPicker; hidden when no model is picked. */
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  onModelOptionsChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
  /** The stage/phase agent authority (t3o-21) — the user's, on the same row as
      the model, exactly like the chat composer. */
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Hide the access-level control. The card's per-round review override
      (t3o-22, D4) re-points the reviewer's model and effort for one round; the
      agent's filesystem authority is a stage-wide safety posture and stays with
      the phase config, so that round's drawer offers only the two it owns. */
  hideRuntimeMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // With nothing picked the popup still needs an instance to open on: use the
  // first available one, with an empty model so no row reads as selected.
  const firstEntry = props.instanceEntries.find((entry) => entry.enabled && entry.isAvailable);
  const active: ActiveModel = props.selection ?? {
    instanceId: firstEntry?.instanceId ?? props.instanceEntries[0]?.instanceId ?? EMPTY_INSTANCE_ID,
    model: "",
  };
  const modelOptions = props.getModelOptions(active);
  const activeEntry =
    props.selection === null
      ? null
      : (props.instanceEntries.find((entry) => entry.instanceId === active.instanceId) ?? null);
  const selectedOption = modelOptions
    .get(active.instanceId)
    ?.find((option) => option.slug === active.model);
  const triggerLabel =
    props.selection === null
      ? "Select a model"
      : selectedOption
        ? getTriggerDisplayModelName(selectedOption)
        : active.model;

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13.5px] text-foreground">{props.label}</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={props.ariaLabel}
                  className="max-w-56 justify-between gap-1.5"
                />
              }
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {activeEntry ? (
                  <ProviderInstanceIcon
                    driverKind={activeEntry.driverKind}
                    displayName={activeEntry.displayName}
                    accentColor={activeEntry.accentColor}
                    showBadge={Boolean(activeEntry.accentColor)}
                    className="size-4"
                    iconClassName="size-4"
                    indicatorBackground="var(--input)"
                  />
                ) : null}
                <span
                  className={cn(
                    "truncate",
                    props.selection === null ? "text-muted-foreground" : "",
                  )}
                >
                  {triggerLabel}
                </span>
              </span>
              <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
            </PopoverTrigger>
            <PopoverPopup
              align="end"
              className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
              viewportClassName="rounded-lg !overflow-hidden p-0"
            >
              <ModelPickerContent
                activeInstanceId={active.instanceId}
                model={active.model}
                lockedProvider={null}
                lockedContinuationGroupKey={null}
                instanceEntries={props.instanceEntries}
                modelOptionsByInstance={modelOptions}
                terminalOpen={false}
                onRequestClose={() => setOpen(false)}
                onInstanceModelChange={(instanceId, model) => {
                  props.onChange({ instanceId, model });
                  setOpen(false);
                }}
              />
            </PopoverPopup>
          </Popover>
          {props.selection !== null && activeEntry !== null ? (
            <TraitsPicker
              provider={activeEntry.driverKind}
              models={activeEntry.models}
              model={active.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={props.modelOptions}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onModelOptionsChange={props.onModelOptionsChange}
            />
          ) : null}
          {props.hideRuntimeMode === true ? null : (
            <AccessLevelPicker
              value={props.runtimeMode}
              onChange={props.onRuntimeModeChange}
              ariaLabel={`${props.ariaLabel} access level`}
              triggerClassName="rounded-lg border border-input bg-popover shadow-xs"
            />
          )}
        </div>
      </div>
      {props.selection === null && props.requiredMessage ? (
        <p className="text-xs text-destructive">{props.requiredMessage}</p>
      ) : null}
    </div>
  );
}

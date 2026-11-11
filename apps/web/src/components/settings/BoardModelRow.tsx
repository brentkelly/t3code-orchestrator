/**
 * The board's model-picker row, shared by the pipeline settings and the card
 * Review pane. Its own module so the lazily loaded Review pane does not pull in
 * the whole pipeline panel.
 */
import { useRef, useState } from "react";

import {
  ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { sortProviderInstanceEntries } from "../../providerInstances";
import { cn } from "../../lib/utils";
import { runtimeModeConfig } from "../chat/runtimeModeConfig";
import { ModelPickerContent } from "../chat/ModelPickerContent";
import { buildTraitsTriggerDisplay } from "@t3tools/client-runtime/model-traits";
import { getTraitsSectionVisibility, TraitsMenuContent } from "../chat/TraitsPicker";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { BoardModelControlsMenu } from "./BoardModelControlsMenu";
import { Popover, PopoverTrigger } from "../ui/popover";
import { useBoardEnvironmentId } from "../../board/useBoardEnvironmentId";
import { BoardBarePopoverPopup } from "../../board/ui/BoardBarePopoverPopup";
import { BoardButton } from "../../board/ui/BoardButton";

export type InstanceEntries = ReturnType<typeof sortProviderInstanceEntries>;
export type ActiveModel = { instanceId: ProviderInstanceId; model: string };
export type ModelOptionsByInstance = ReturnType<typeof getCustomModelOptionsByInstance>;
export type ModelSelection = ActiveModel | null;

/** The stand-in instance a row with nothing picked opens its popup on. */
const EMPTY_INSTANCE_ID = ProviderInstanceId.make("none");

/**
 * The row's one settings control: the chat composer's combined controls menu
 * (reasoning, context window, fast mode, access — each section only when the
 * model supports it or the row owns it), with the current picks summarised on
 * the trigger the way the composer's traits button does, plus the access level.
 */
function ModelControlsMenu(props: {
  ariaLabel: string;
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  onModelOptionsChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
  runtimeMode: RuntimeMode | undefined;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const traits = getTraitsSectionVisibility({
    provider: props.provider,
    models: props.models,
    model: props.model,
    modelOptions: props.modelOptions,
    allowPromptInjectedEffort: false,
  });
  const labels: string[] = [];
  if (traits.hasAnyControls) {
    const display = buildTraitsTriggerDisplay({
      descriptors: traits.descriptors,
      primarySelectDescriptorId: traits.primarySelectDescriptor?.id ?? null,
      ultrathinkPromptControlled: false,
    });
    if (display.label.length > 0) labels.push(display.label);
  }
  if (props.runtimeMode !== undefined) {
    labels.push(runtimeModeConfig[props.runtimeMode].label);
  }
  if (labels.length === 0) {
    return null;
  }
  return (
    <BoardModelControlsMenu
      ariaLabel={props.ariaLabel}
      triggerLabel={<span className="truncate">{labels.join(" · ")}</span>}
      triggerVariant="outline"
      align="end"
      traitsMenuContent={
        traits.hasAnyControls ? (
          <TraitsMenuContent
            provider={props.provider}
            models={props.models}
            model={props.model}
            modelOptions={props.modelOptions}
            allowPromptInjectedEffort={false}
            onModelOptionsChange={props.onModelOptionsChange}
          />
        ) : undefined
      }
      {...(props.runtimeMode === undefined
        ? {}
        : { runtimeMode: props.runtimeMode, onRuntimeModeChange: props.onRuntimeModeChange })}
    />
  );
}

/**
 * The model row. There is no "Default" state: an unset stage reads "Select a
 * model". The trigger is local because `ProviderModelPicker`'s always names a
 * model; the popup is the app's own `ModelPickerContent`.
 */
export function ModelRow(props: {
  label: string;
  ariaLabel: string;
  selection: ModelSelection;
  requiredMessage?: string | null;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  onChange: (selection: ModelSelection) => void;
  /** Reasoning/effort selections for the chosen model, and the setter.
      Rendered inside the composer's combined controls menu; hidden when no
      model is picked. */
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  onModelOptionsChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
  /** The stage/phase agent authority — the user's, in the same menu
      as the model's traits, exactly like the chat composer. */
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  /** Hide the access-level section — the card's per-round review override
       has nowhere to keep one until a model is picked. */
  hideRuntimeMode?: boolean;
  /**
   * What the trigger reads with nothing picked. Override rows name what they
   * inherit and from where, since "nothing picked" can mean the workspace
   * default or a parent card's model.
   */
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const environmentId = useBoardEnvironmentId();
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
      ? (props.placeholder ?? "Select a model")
      : selectedOption
        ? getTriggerDisplayModelName(selectedOption, activeEntry?.driverKind)
        : active.model;

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-board-13-5 text-foreground">{props.label}</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <BoardButton
                  size="xs"
                  variant="outline"
                  aria-label={props.ariaLabel}
                  look="model-picker"
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
            <BoardBarePopoverPopup align="end">
              <ModelPickerContent
                environmentId={environmentId}
                activeInstanceId={active.instanceId}
                model={active.model}
                lockedProvider={null}
                lockedContinuationGroupKey={null}
                instanceEntries={props.instanceEntries}
                modelOptionsByInstance={modelOptions}
                terminalOpen={false}
                onRequestClose={() => setOpen(false)}
                searchInputRef={searchInputRef}
                onInstanceModelChange={(instanceId, model) => {
                  props.onChange({ instanceId, model });
                  setOpen(false);
                }}
              />
            </BoardBarePopoverPopup>
          </Popover>
          {props.selection !== null && activeEntry !== null ? (
            <ModelControlsMenu
              ariaLabel={`${props.ariaLabel} settings`}
              provider={activeEntry.driverKind}
              models={activeEntry.models}
              model={active.model}
              modelOptions={props.modelOptions}
              onModelOptionsChange={props.onModelOptionsChange}
              runtimeMode={props.hideRuntimeMode === true ? undefined : props.runtimeMode}
              onRuntimeModeChange={props.onRuntimeModeChange}
            />
          ) : props.hideRuntimeMode === true ? null : (
            <BoardModelControlsMenu
              ariaLabel={`${props.ariaLabel} settings`}
              triggerLabel={runtimeModeConfig[props.runtimeMode].label}
              triggerVariant="outline"
              align="end"
              runtimeMode={props.runtimeMode}
              onRuntimeModeChange={props.onRuntimeModeChange}
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

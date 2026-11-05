import type { ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import type { ActiveModel, ModelOptionsByInstance } from "./BoardModelRow";

// The label `ModelRow`'s trigger shows, for a selection the row is not rendering: an
// inherited "Opus 5 (default)" must match the picker, which shortens by driver kind.
export function boardModelDisplayName(
  selection: ActiveModel,
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance,
  instanceEntries: ReadonlyArray<Pick<ProviderInstanceEntry, "instanceId" | "driverKind">>,
): string {
  const option = getModelOptions(selection)
    .get(selection.instanceId)
    ?.find((entry) => entry.slug === selection.model);
  if (!option) return selection.model;
  const driverKind = instanceEntries.find(
    (entry) => entry.instanceId === selection.instanceId,
  )?.driverKind;
  return getTriggerDisplayModelName(option, driverKind);
}

import { RuntimeMode } from "@t3tools/contracts";
import { LockIcon, LockOpenIcon, PenLineIcon, SparklesIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The agent authority ("access level") vocabulary — label, one-line
 * description and icon per `RuntimeMode`. The single source of truth: the chat
 * composer footer and the board pipeline settings both render from this, so the
 * four modes read identically everywhere (t3o-21). Previously private to
 * `ChatComposer.tsx`.
 */
export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];

/**
 * The access-level control: a select whose trigger shows the current mode's
 * icon + label and whose popup lists every mode with its description, wrapped
 * in a tooltip that echoes the current mode's description. Controlled — the
 * caller owns the value. Used by the composer footer and the board pipeline
 * settings row so both match the mockup exactly.
 */
export function AccessLevelPicker(props: {
  value: RuntimeMode;
  onChange: (mode: RuntimeMode) => void;
  ariaLabel?: string;
  triggerClassName?: string;
}) {
  const option = runtimeModeConfig[props.value];
  const Icon = option.icon;
  return (
    <Tooltip>
      <Select value={props.value} onValueChange={(value) => props.onChange(value!)}>
        <TooltipTrigger
          render={
            <ComposerSelectControl
              className={cn("font-medium", props.triggerClassName)}
              aria-label={props.ariaLabel ?? "Access level"}
            />
          }
        >
          <ComposerControlIcon icon={Icon} />
          <SelectValue>{option.label}</SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {runtimeModeOptions.map((mode) => {
            const modeOption = runtimeModeConfig[mode];
            const OptionIcon = modeOption.icon;
            return (
              <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid min-w-0 flex-1 gap-0.5">
                    <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                      <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      {modeOption.label}
                    </span>
                    <span className="text-muted-foreground text-xs leading-4">
                      {modeOption.description}
                    </span>
                  </div>
                </div>
              </SelectItem>
            );
          })}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">{option.description}</TooltipPopup>
    </Tooltip>
  );
}

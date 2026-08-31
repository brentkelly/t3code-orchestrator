import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { runtimeModeConfig, runtimeModeOptions } from "./AccessLevelPicker";
import { Fragment, memo, type ReactNode } from "react";
import type { VariantProps } from "class-variance-authority";
import { ChevronDownIcon, EllipsisIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

/**
 * The single "everything about how the agent runs" menu: the model's traits
 * (reasoning, context window, fast mode — whatever the model supports), the
 * chat/plan interaction mode, and the access level, one section each. The
 * chat composer shows it behind a "…" trigger when its footer is too narrow
 * for the individual controls; the board's model rows use it as their only
 * settings control, with a summary label as the trigger.
 *
 * Every section is optional so a caller renders only what it owns: leave
 * `runtimeMode` unset to drop the Access section (the card's per-round review
 * override re-points model and effort for one round but not the stage's
 * authority), and `showInteractionModeToggle` false to drop Mode. When no
 * section is left the menu renders nothing at all.
 */
export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode?: ProviderInteractionMode;
  runtimeMode?: RuntimeMode;
  showInteractionModeToggle?: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode?: () => void;
  onRuntimeModeChange?: (mode: RuntimeMode) => void;
  /** Trigger contents; the bare ellipsis when omitted. */
  triggerLabel?: ReactNode;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  ariaLabel?: string;
  align?: "start" | "end";
}) {
  const showMode = props.showInteractionModeToggle === true && props.interactionMode !== undefined;
  const showAccess = props.runtimeMode !== undefined;
  const sections: Array<{ key: string; node: ReactNode }> = [];
  if (props.traitsMenuContent) {
    sections.push({ key: "traits", node: props.traitsMenuContent });
  }
  if (showMode) {
    sections.push({
      key: "mode",
      node: (
        <>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
          <MenuRadioGroup
            value={props.interactionMode}
            onValueChange={(value) => {
              if (!value || value === props.interactionMode) return;
              props.onToggleInteractionMode?.();
            }}
          >
            <MenuRadioItem value="default">Chat</MenuRadioItem>
            <MenuRadioItem value="plan">Plan</MenuRadioItem>
          </MenuRadioGroup>
        </>
      ),
    });
  }
  if (showAccess) {
    sections.push({
      key: "access",
      node: (
        <>
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!value || value === props.runtimeMode) return;
              props.onRuntimeModeChange?.(value as RuntimeMode);
            }}
          >
            {runtimeModeOptions.map((mode) => (
              <MenuRadioItem key={mode} value={mode}>
                {runtimeModeConfig[mode].label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </>
      ),
    });
  }
  if (sections.length === 0) {
    return null;
  }

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            className={cn(
              "shrink-0 px-2",
              props.triggerLabel === undefined
                ? "text-muted-foreground/70 hover:text-foreground/80"
                : "gap-1.5",
              props.triggerClassName,
            )}
            aria-label={props.ariaLabel ?? "More composer controls"}
          />
        }
      >
        {props.triggerLabel === undefined ? (
          <EllipsisIcon aria-hidden="true" className="size-4" />
        ) : (
          <>
            {props.triggerLabel}
            <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
          </>
        )}
      </MenuTrigger>
      <MenuPopup align={props.align ?? "start"}>
        {sections.map((section, index) => (
          <Fragment key={section.key}>
            {index > 0 ? <MenuDivider /> : null}
            {section.node}
          </Fragment>
        ))}
      </MenuPopup>
    </Menu>
  );
});

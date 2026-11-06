/** T3o: the prototype's bordered card for Settings → Board sections, so every
    section on the page shares one width and look. Sections holding it use the
    `plain` SettingsSection variant: the default `grouped` one draws a second,
    wider border around it. */
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

export function BoardSettingsCard(props: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly id?: string;
}) {
  return (
    <div
      id={props.id}
      className={cn(
        "mx-3 flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:mx-4",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

export function BoardSettingsCardRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13.5px] text-foreground">{props.label}</span>
        {props.description ? (
          <span className="max-w-md text-xs text-muted-foreground">{props.description}</span>
        ) : null}
      </div>
      {props.control}
    </div>
  );
}

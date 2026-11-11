/**
 * The board surface's own header row. The board mounts without a sidebar, so
 * the brand lives here. Right-hand controls arrive as `children` because the
 * bar also renders with no environment connected.
 */
import { SearchIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { BoardModeTabs } from "./BoardModeTabs";
import { BoardInput } from "./ui/BoardInput";

export function BoardTopBar({
  children,
  mode = "board",
}: {
  readonly children?: ReactNode;
  /** Which board-owned surface this bar heads: the board or the List view. */
  readonly mode?: "board" | "list";
}) {
  return (
    <WorkspacePageHeader className="gap-2" electron={isElectron}>
      <BoardBrand />
      <BoardModeTabs mode={mode} />
      <span className="flex-1" />
      {children}
    </WorkspacePageHeader>
  );
}

/**
 * The wordmark, static: the mode tabs beside it own navigation. Drawn here
 * rather than exported from the sidebar's private copy, which is pristine
 * upstream.
 */
function BoardBrand() {
  return (
    <span
      aria-label="T3 Code"
      className="flex h-7 shrink-0 items-center gap-1 pr-0.5 text-foreground"
    >
      <T3Wordmark />
      <span className="-translate-y-px text-sm font-medium tracking-tight text-muted-foreground max-sm:sr-only">
        Code
      </span>
    </span>
  );
}

function T3Wordmark() {
  return (
    <svg
      aria-label="T3"
      className="h-2.5 w-auto shrink-0"
      viewBox="15.5309 37 94.3941 56.96"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M33.4509 93V47.56H15.5309V37H64.3309V47.56H46.4109V93H33.4509ZM86.7253 93.96C82.832 93.96 78.9653 93.4533 75.1253 92.44C71.2853 91.3733 68.032 89.88 65.3653 87.96L70.4053 78.04C72.5386 79.5867 75.0186 80.8133 77.8453 81.72C80.672 82.6267 83.5253 83.08 86.4053 83.08C89.6586 83.08 92.2186 82.44 94.0853 81.16C95.952 79.88 96.8853 78.12 96.8853 75.88C96.8853 73.7467 96.0586 72.0667 94.4053 70.84C92.752 69.6133 90.0853 69 86.4053 69H80.4853V60.44L96.0853 42.76L97.5253 47.4H68.1653V37H107.365V45.4L91.8453 63.08L85.2853 59.32H89.0453C95.9253 59.32 101.125 60.8667 104.645 63.96C108.165 67.0533 109.925 71.0267 109.925 75.88C109.925 79.0267 109.099 81.9867 107.445 84.76C105.792 87.48 103.259 89.6933 99.8453 91.4C96.432 93.1067 92.0586 93.96 86.7253 93.96Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * The filter box. Narrows the board to the cards whose title or key matches
 * (`boardCardFilter`); Escape and the clear button are the way back out, so a
 * board emptied by a stale query is never a board with no cards.
 */
export function BoardCardFilterField({
  onQueryChange,
  query,
}: {
  readonly onQueryChange: (query: string) => void;
  readonly query: string;
}) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-input bg-popover px-2 shadow-xs/5 focus-within:border-ring sm:h-6.5 dark:bg-input/32">
      <SearchIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      <BoardInput
        aria-label="Filter cards"
        className="inline-flex w-24 min-w-0 sm:w-28 [&_input]:h-6"
        look="filter"
        nativeInput
        onChange={(event) => onQueryChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && query.length > 0) {
            // Stop here: the board's Escape otherwise closes things behind it.
            event.preventDefault();
            event.stopPropagation();
            onQueryChange("");
          }
        }}
        placeholder="Filter cards"
        size="compact"
        type="search"
        unstyled
        value={query}
      />
      {query.length > 0 ? (
        <button
          aria-label="Clear filter"
          className="inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => onQueryChange("")}
          type="button"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * The card's base-branch picker. Shares the data layer (`usePaginatedBranches`,
 * `VcsRef.isDefault`) rather than `BranchToolbarBranchSelector`, which is welded to
 * a thread and upstream-owned. Real repos have hundreds of branches, so it searches.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, GitBranchIcon, SearchIcon } from "lucide-react";
import { useDeferredValue, useRef, useState } from "react";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { usePaginatedBranches } from "../state/queries";
import {
  boardBaseBranchOptions,
  boardBaseBranchSelectedName,
  boardBaseBranchSelectionValue,
  shouldLoadNextBranchPageAfterScroll,
} from "./boardBaseBranch";
import { BoardButton } from "./ui/BoardButton";
import {
  BoardComboboxCodeItem,
  BoardComboboxPaddedList,
  BoardComboboxSearchInput,
} from "./ui/BoardCombobox";

export function BoardBaseBranchSelect({
  environmentId,
  workspaceRoot,
  baseBranch,
  onSelect,
  disabled = false,
  className,
  inline = false,
  size = "sm",
  align = "start",
}: {
  readonly environmentId: EnvironmentId;
  /** The PROJECT's checkout, which is where the card's branches are cut — never
      the card's own worktree. Null when the project is not on disk, which
      disables the control rather than querying refs of nothing. */
  readonly workspaceRoot: string | null;
  /** The card's pin, or null to follow the project default. */
  readonly baseBranch: string | null;
  /** The value to store (null follows the project default) and the branch it
      resolves to, which the card detail compares against its cut point. */
  readonly onSelect: (baseBranch: string | null, localName: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  /** Set into a line of meta text rather than standing as a control. */
  readonly inline?: boolean;
  readonly size?: "xs" | "sm";
  readonly align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim();

  const target = { environmentId, cwd: workspaceRoot, query: deferredQuery };
  const branchState = usePaginatedBranches(target);
  const options = boardBaseBranchOptions(branchState.refs);
  const selectedName = boardBaseBranchSelectedName({ baseBranch, options });
  // The label falls back to the card's pin so a branch that has since been
  // deleted still reads as what the card is actually set to, rather than
  // silently rendering as the default it is not.
  const label = selectedName ?? (branchState.isPending ? "Loading…" : "Default branch");

  const hasNextPage = branchState.data?.nextCursor != null;
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  const maybeFetchNextPage = (event: { readonly currentTarget: HTMLDivElement }) => {
    const element = event.currentTarget;
    scrollElementRef.current = element;
    const previousScrollTop = previousScrollTopRef.current;
    previousScrollTopRef.current = element.scrollTop;
    if (!open || !hasNextPage || branchState.isFetchingNextPage) return;
    if (
      !shouldLoadNextBranchPageAfterScroll({
        previousScrollTop,
        scrollTop: element.scrollTop,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
      })
    ) {
      return;
    }
    branchState.loadNext();
  };

  const itemValues = options.map((option) => option.localName);

  return (
    <Combobox
      items={itemValues}
      onOpenChange={(next: boolean) => {
        previousScrollTopRef.current = null;
        setOpen(next);
        if (!next) setQuery("");
      }}
      open={open}
      value={selectedName ?? ""}
    >
      <ComboboxTrigger
        render={
          <BoardButton
            className={className}
            look={inline ? "branch-picker-inline" : "branch-picker"}
            size={size === "xs" ? "xs" : "sm"}
            variant="outline"
          />
        }
        aria-label="Base branch"
        disabled={disabled || workspaceRoot === null}
      >
        <GitBranchIcon className="size-3 shrink-0 opacity-70" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align={align} className="flex w-72 flex-col">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <BoardComboboxSearchInput
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search branches..."
              value={query}
            />
          </div>
        </div>
        <ComboboxEmpty>
          {branchState.isPending ? "Loading branches…" : "No branches found."}
        </ComboboxEmpty>
        {/* Our own scroll container: `ComboboxList`'s `ScrollArea` wrapper would
            put `onScroll` on a different element from the one paged by `scrollHeight`. */}
        <div
          className="max-h-56 min-h-0 overflow-y-auto overscroll-contain"
          onScroll={maybeFetchNextPage}
        >
          <BoardComboboxPaddedList>
            {options.map((option) => (
              <BoardComboboxCodeItem
                key={option.localName}
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  onSelect(boardBaseBranchSelectionValue(option), option.localName);
                }}
                value={option.localName}
              >
                <div className="flex w-full min-w-0 items-center justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate">{option.localName}</span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {option.isDefault ? (
                      <span className="text-board-10 text-muted-foreground/45">default</span>
                    ) : null}
                    {option.localName === selectedName ? (
                      <CheckIcon className="size-3 text-muted-foreground" />
                    ) : null}
                  </span>
                </div>
              </BoardComboboxCodeItem>
            ))}
          </BoardComboboxPaddedList>
        </div>
        {branchState.error === null ? null : <ComboboxStatus>{branchState.error}</ComboboxStatus>}
      </ComboboxPopup>
    </Combobox>
  );
}

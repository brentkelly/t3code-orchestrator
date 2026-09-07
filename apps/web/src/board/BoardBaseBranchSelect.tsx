/**
 * The card's base-branch picker (T3O-5, D11) — the create dialog's row and the
 * open card's `Base · <branch>` control, one component.
 *
 * REUSE IS AT THE DATA LAYER, not at `BranchToolbarBranchSelector`. That
 * component cannot be shared: it is welded to a thread (switch-ref, create-ref,
 * PR checkout, env-mode, start-from-origin, the composer draft store), and
 * refactoring it to be shareable would be exactly the churn on an
 * upstream-owned file that a future sync has to reconcile. What IS shared is
 * everything underneath it, none of which needed a change: `usePaginatedBranches`
 * (which takes a `cwd`, not a thread), `VcsRef.isDefault` for the `default`
 * hint, `deriveLocalBranchNameFromRemoteRef` and
 * `shouldLoadNextBranchPageAfterScroll`, and the `Combobox` primitives.
 *
 * A search input is not optional (D15): the mockup shows four branches and real
 * repositories have hundreds, which is why the query is paginated and
 * server-filtered.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, GitBranchIcon, SearchIcon } from "lucide-react";
import { useCallback, useDeferredValue, useMemo, useRef, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "../components/ui/combobox";
import { cn } from "../lib/utils";
import { shouldLoadNextBranchPageAfterScroll } from "../state/paginatedBranches";
import { usePaginatedBranches } from "../state/queries";
import {
  boardBaseBranchOptions,
  boardBaseBranchSelectedName,
  boardBaseBranchSelectionValue,
} from "./boardBaseBranch";

export function BoardBaseBranchSelect({
  environmentId,
  workspaceRoot,
  baseBranch,
  onSelect,
  disabled = false,
  className,
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
  /** What to store — the local branch name, or null when the user picked the
      project's current default (D12) — and, separately, the branch that value
      RESOLVES to. The card detail needs both: it stores the first and compares
      the second against the branch the card was actually cut from, so putting
      a retargeted card back on its cut point asks for no rebase it does not
      need. */
  readonly onSelect: (baseBranch: string | null, localName: string) => void;
  readonly disabled?: boolean;
  readonly className?: string;
  readonly size?: "xs" | "sm";
  readonly align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query).trim();

  const target = useMemo(
    () => ({ environmentId, cwd: workspaceRoot, query: deferredQuery }),
    [deferredQuery, environmentId, workspaceRoot],
  );
  const branchState = usePaginatedBranches(target);
  const options = useMemo(() => boardBaseBranchOptions(branchState.refs), [branchState.refs]);
  const selectedName = boardBaseBranchSelectedName({ baseBranch, options });
  // The label falls back to the card's pin so a branch that has since been
  // deleted still reads as what the card is actually set to, rather than
  // silently rendering as the default it is not.
  const label = selectedName ?? (branchState.isPending ? "Loading…" : "Default branch");

  const hasNextPage = branchState.data?.nextCursor != null;
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const previousScrollTopRef = useRef<number | null>(null);
  const maybeFetchNextPage = useCallback(
    (event: { readonly currentTarget: HTMLDivElement }) => {
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
    },
    [branchState, hasNextPage, open],
  );

  const itemValues = useMemo(() => options.map((option) => option.localName), [options]);

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
        render={<Button size={size === "xs" ? "xs" : "sm"} variant="outline" />}
        aria-label="Base branch"
        className={cn("min-w-0 max-w-full justify-start font-mono", className)}
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
            <ComboboxInput
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent text-sm"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search branches..."
              showTrigger={false}
              size="sm"
              unstyled
              value={query}
            />
          </div>
        </div>
        <ComboboxEmpty>
          {branchState.isPending ? "Loading branches…" : "No branches found."}
        </ComboboxEmpty>
        {/* The scroll container is ours, not `ComboboxList`'s: that one wraps
            its list in a `ScrollArea`, so the element `onScroll` fires on is
            not the one whose `scrollHeight` decides when to fetch the next
            page. `ComboboxListVirtualized` is the same list without the
            wrapper, for exactly this case. */}
        <div
          className="max-h-56 min-h-0 overflow-y-auto overscroll-contain"
          onScroll={maybeFetchNextPage}
        >
          <ComboboxListVirtualized className="p-1">
            {options.map((option) => (
              <ComboboxItem
                className="pe-1.5 font-mono"
                hideIndicator
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
                      <span className="text-[10px] text-muted-foreground/45">default</span>
                    ) : null}
                    {option.localName === selectedName ? (
                      <CheckIcon className="size-3 text-muted-foreground" />
                    ) : null}
                  </span>
                </div>
              </ComboboxItem>
            ))}
          </ComboboxListVirtualized>
        </div>
        {branchState.error === null ? null : <ComboboxStatus>{branchState.error}</ComboboxStatus>}
      </ComboboxPopup>
    </Combobox>
  );
}

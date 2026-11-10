/**
 * A searchable add control: a button opening a filtered option list. Pure:
 * options in, a pick out. `BoardPickerSearchBody` is the contents alone, for
 * menus that already own a popover.
 */
import type { ProjectIconColor, ProjectId } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { BoardHint } from "./BoardHint";
import { boardCardMatchesQuery, normaliseBoardCardQuery } from "./boardCardFilter";
import { projectAccent } from "./projectAccent";

export interface BoardPickerOption {
  readonly id: string;
  /** Short leading identifier (a card key); empty hides the column. */
  readonly key: string;
  readonly title: string;
  /** The owning project when the option is outside the current card's project
      (cross-project dependencies are legal). Absent for same-project options. */
  readonly project?:
    | { readonly id: ProjectId; readonly title: string; readonly accent: ProjectIconColor | null }
    | undefined;
}

/** Rows the popover builds at once; more are reached by typing. Keeps the cost
    flat now that the dependency picker offers every project's cards. */
const PICKER_RENDER_LIMIT = 50;

/** The rows to render for a query, and how many matches are left off the end.
    Matching is `boardCardMatchesQuery`, the same rule the board's own filter
    box uses, so a card found by one is a card found by the other. */
export function boardPickerVisibleOptions(
  options: ReadonlyArray<BoardPickerOption>,
  query: string,
  limit: number = PICKER_RENDER_LIMIT,
): { readonly visible: ReadonlyArray<BoardPickerOption>; readonly hidden: number } {
  const normalised = normaliseBoardCardQuery(query);
  const matched = options.filter((option) => boardCardMatchesQuery(option, normalised));
  return { visible: matched.slice(0, limit), hidden: Math.max(matched.length - limit, 0) };
}

export function BoardPickerSearchBody({
  placeholder,
  options,
  onPick,
  onQueryChange,
  pending = false,
}: {
  readonly placeholder: string;
  readonly options: ReadonlyArray<BoardPickerOption>;
  readonly onPick: (id: string) => void;
  /** For a caller that searches beyond `options` as the user types (T3O-41). */
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly pending?: boolean | undefined;
}) {
  const [query, setQuery] = useState("");
  const { visible: filtered, hidden } = boardPickerVisibleOptions(options, query);
  return (
    <>
      <Input
        autoFocus
        className="h-7 text-sm"
        onChange={(event) => {
          setQuery(event.target.value);
          onQueryChange?.(event.target.value);
        }}
        placeholder={placeholder}
        value={query}
      />
      <div className="mt-1.5 flex max-h-64 flex-col gap-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <span className="px-1.5 py-1 text-[12.5px] text-muted-foreground">
            {pending ? "Searching…" : "No matches."}
          </span>
        ) : (
          <>
            {filtered.map((option) => (
              <button
                className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-accent"
                key={option.id}
                onClick={() => onPick(option.id)}
                type="button"
              >
                {option.project === undefined ? null : (
                  <BoardHint label={`In ${option.project.title}`}>
                    <span
                      className={cn(
                        "size-[7px] shrink-0 rounded-full",
                        projectAccent(option.project.id, option.project.accent).dot,
                      )}
                    />
                  </BoardHint>
                )}
                {option.key.length > 0 ? (
                  <span className="shrink-0 font-medium text-muted-foreground">{option.key}</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{option.title}</span>
              </button>
            ))}
            {hidden > 0 ? (
              <span className="px-1.5 py-1 text-[12.5px] text-muted-foreground">
                {hidden} more. Keep typing to narrow.
              </span>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}

export function BoardSearchAddPicker({
  label,
  placeholder,
  options,
  onPick,
  onQueryChange,
  pending,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly options: ReadonlyArray<BoardPickerOption>;
  readonly onPick: (id: string) => void;
  readonly onQueryChange?: ((query: string) => void) | undefined;
  readonly pending?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  // Bumped on OPEN only. Keying the body on `open` itself would also remount it
  // while the popover is animating closed, blanking the list under the user.
  const [openCount, setOpenCount] = useState(0);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setOpenCount((count) => count + 1);
      }}
    >
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
        <PlusIcon />
        {label}
      </PopoverTrigger>
      <PopoverPopup className="w-64 p-1.5">
        {/* Remounted per open so the query resets — the body owns its filter state. */}
        <BoardPickerSearchBody
          key={openCount}
          onPick={(id) => {
            onPick(id);
            setOpen(false);
          }}
          onQueryChange={onQueryChange}
          options={options}
          pending={pending}
          placeholder={placeholder}
        />
      </PopoverPopup>
    </Popover>
  );
}

/**
 * T3o searchable add control (t3o-06): a button that opens a popover with a
 * filter box over a set of options — shared by the detail pane's dependency
 * and thread-adoption pickers and the create dialog's initial-dependency
 * picker. Pure: options in, a pick out.
 *
 * `BoardPickerSearchBody` is the popover's contents on their own, so the card
 * thread pane's add MENU (t3o-14) can swap the same search into a popover it
 * already owns rather than nesting a second one inside a menu item.
 */
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { BoardHint } from "./BoardHint";

export interface BoardPickerOption {
  readonly id: string;
  /** Short leading identifier (a card key); empty hides the column. */
  readonly key: string;
  readonly title: string;
  /** The parent card's key when the option is a sub-board child (t3o-25), so
      a child offered among top-level cards names whose board it lives on. */
  readonly parentKey?: string | undefined;
}

export function BoardPickerSearchBody({
  placeholder,
  options,
  onPick,
}: {
  readonly placeholder: string;
  readonly options: ReadonlyArray<BoardPickerOption>;
  readonly onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = options.filter((option) => {
    if (q.length === 0) return true;
    return option.title.toLowerCase().includes(q) || option.key.toLowerCase().includes(q);
  });
  return (
    <>
      <Input
        autoFocus
        className="h-7 text-sm"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        value={query}
      />
      <div className="mt-1.5 flex max-h-64 flex-col gap-0.5 overflow-y-auto">
        {filtered.length === 0 ? (
          <span className="px-1.5 py-1 text-[12.5px] text-muted-foreground">No matches.</span>
        ) : (
          filtered.map((option) => (
            <button
              className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-accent"
              key={option.id}
              onClick={() => onPick(option.id)}
              type="button"
            >
              {option.key.length > 0 ? (
                <span className="shrink-0 font-medium text-muted-foreground">{option.key}</span>
              ) : null}
              <span className="min-w-0 flex-1 truncate">{option.title}</span>
              {option.parentKey !== undefined ? (
                <BoardHint label={`Part of ${option.parentKey}'s sub-board`}>
                  <span className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                    {option.parentKey}
                  </span>
                </BoardHint>
              ) : null}
            </button>
          ))
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
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly options: ReadonlyArray<BoardPickerOption>;
  readonly onPick: (id: string) => void;
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
          options={options}
          placeholder={placeholder}
        />
      </PopoverPopup>
    </Popover>
  );
}

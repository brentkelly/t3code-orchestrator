/**
 * T3o searchable add control (t3o-06): a button that opens a popover with a
 * filter box over a set of options — shared by the detail pane's dependency
 * and thread-adoption pickers and the create dialog's initial-dependency
 * picker. Pure: options in, a pick out.
 */
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";

export interface BoardPickerOption {
  readonly id: string;
  /** Short leading identifier (a card key); empty hides the column. */
  readonly key: string;
  readonly title: string;
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
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const filtered = options.filter((option) => {
    if (q.length === 0) return true;
    return option.title.toLowerCase().includes(q) || option.key.toLowerCase().includes(q);
  });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger render={<Button size="xs" variant="ghost" />}>
        <PlusIcon />
        {label}
      </PopoverTrigger>
      <PopoverPopup className="w-64 p-1.5">
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
                onClick={() => {
                  onPick(option.id);
                  setOpen(false);
                  setQuery("");
                }}
                type="button"
              >
                {option.key.length > 0 ? (
                  <span className="shrink-0 font-medium text-muted-foreground">{option.key}</span>
                ) : null}
                <span className="min-w-0 flex-1 truncate">{option.title}</span>
              </button>
            ))
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * T3o label picker (t3o-06a): searchable, multi-select (toggle membership),
 * create-inline when the query matches nothing, per-label colour editing from
 * the swatch, delete, and a restore section for tombstoned labels. Ported from
 * the prototype's `labelPickerVm`. Board-owned.
 *
 * This is the component t3o-06 mounts in the card detail pane; it is
 * self-contained and stateless beyond its query/colour-editor UI state, so the
 * host wires the four label commands (create / update / delete / undelete) plus
 * the card's `labels` update to the callbacks. Colour editing dispatches a
 * `board.label.update`, so a recolour repaints every card via the catalogue
 * delta — there is no local-only colour state.
 */
import { BOARD_LABEL_SWATCHES, type BoardLabel, type BoardLabelId } from "@t3tools/contracts";
import { CheckIcon, PaletteIcon, RotateCcwIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { boardLabelForeground } from "./labelColour";
import { boardLabelPickerModel } from "./labelPickerModel";

export interface BoardLabelPickerProps {
  readonly catalogue: ReadonlyArray<BoardLabel>;
  readonly selectedLabelIds: ReadonlyArray<BoardLabelId>;
  readonly onToggle: (labelId: BoardLabelId) => void;
  readonly onCreate: (name: string) => void;
  readonly onRecolour: (labelId: BoardLabelId, colour: string) => void;
  readonly onDelete: (labelId: BoardLabelId) => void;
  readonly onUndelete: (labelId: BoardLabelId) => void;
}

export function BoardLabelPicker(props: BoardLabelPickerProps) {
  const [query, setQuery] = useState("");
  const [editingColourFor, setEditingColourFor] = useState<BoardLabelId | null>(null);
  const model = boardLabelPickerModel({
    catalogue: props.catalogue,
    selectedLabelIds: props.selectedLabelIds,
    query,
  });

  return (
    <div className="flex w-64 flex-col gap-1.5 p-1">
      <Input
        autoFocus
        className="h-7 text-sm"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && model.canCreate) {
            event.preventDefault();
            props.onCreate(model.createName);
            setQuery("");
          }
        }}
        placeholder="Search or create a label"
        value={query}
      />

      <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
        {model.matches.map(({ label, selected }) => (
          <div className="flex flex-col" key={label.labelId}>
            <div className="flex items-center gap-1">
              <button
                className="flex min-w-0 flex-1 items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] capitalize hover:bg-accent"
                onClick={() => props.onToggle(label.labelId)}
                type="button"
              >
                <span
                  className="size-3 shrink-0 rounded-sm"
                  style={{ backgroundColor: label.colour }}
                />
                <span className="min-w-0 flex-1 truncate">{label.name}</span>
                {selected ? <CheckIcon className="size-3.5 shrink-0 text-foreground" /> : null}
              </button>
              <Button
                onClick={() =>
                  setEditingColourFor((current) =>
                    current === label.labelId ? null : label.labelId,
                  )
                }
                size="icon-xs"
                title="Edit colour"
                variant="ghost"
              >
                <PaletteIcon />
              </Button>
              <Button
                onClick={() => props.onDelete(label.labelId)}
                size="icon-xs"
                title="Delete label"
                variant="ghost"
              >
                <TrashIcon />
              </Button>
            </div>
            {editingColourFor === label.labelId ? (
              <div className="grid grid-cols-8 gap-1 p-1.5">
                {BOARD_LABEL_SWATCHES.map((swatch) => (
                  <button
                    aria-label={`Set colour ${swatch}`}
                    className={cn(
                      "size-5 rounded-sm border-2",
                      label.colour === swatch ? "border-foreground" : "border-transparent",
                    )}
                    key={swatch}
                    onClick={() => {
                      props.onRecolour(label.labelId, swatch);
                      setEditingColourFor(null);
                    }}
                    style={{ backgroundColor: swatch }}
                    type="button"
                  />
                ))}
              </div>
            ) : null}
          </div>
        ))}

        {model.canCreate ? (
          <button
            className="flex items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-accent"
            onClick={() => {
              props.onCreate(model.createName);
              setQuery("");
            }}
            type="button"
          >
            <span
              className="inline-flex h-4 items-center rounded px-1.5 text-[10px] font-medium capitalize"
              style={{ backgroundColor: "#a1a1aa", color: boardLabelForeground("#a1a1aa") }}
            >
              {model.createName}
            </span>
            <span className="text-muted-foreground">Create label</span>
          </button>
        ) : null}
      </div>

      {model.deleted.length > 0 ? (
        <div className="flex flex-col gap-0.5 border-t border-border pt-1">
          <span className="px-1.5 text-[10.5px] font-medium text-muted-foreground">Deleted</span>
          {model.deleted.map((label) => (
            <div className="flex items-center gap-1" key={label.labelId}>
              <span className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-[12.5px] capitalize text-muted-foreground">
                <span
                  className="size-3 shrink-0 rounded-sm opacity-55"
                  style={{ backgroundColor: label.colour }}
                />
                <span className="min-w-0 flex-1 truncate line-through">{label.name}</span>
              </span>
              <Button
                onClick={() => props.onUndelete(label.labelId)}
                size="icon-xs"
                title="Restore label"
                variant="ghost"
              >
                <RotateCcwIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

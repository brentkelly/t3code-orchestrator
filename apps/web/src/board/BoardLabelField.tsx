/**
 * T3o label field (t3o-06a) — the prototype's card-modal label control: the
 * card's labels as pills, and one autocomplete beneath them. Selecting a row
 * toggles membership and leaves the list open (labels are a set, so you pick
 * several in one visit); typing a name nobody has used offers to create it.
 *
 * Replaces the earlier row of catalogue toggle buttons: a board with twenty
 * labels cannot render twenty buttons in a 244px rail, but it can render the
 * two a card actually carries.
 *
 * Colour editing lives on the row's pencil and dispatches a
 * `board.label.update`, so a recolour repaints every card via the catalogue
 * delta — there is no local-only colour state. Delete and restore stay
 * (a tombstoned label is never a one-way door, t3o-06a); the bin is quiet
 * until you hover the row, so the resting control is the prototype's.
 */
import { BOARD_LABEL_SWATCHES, type BoardLabel, type BoardLabelId } from "@t3tools/contracts";
import { CheckIcon, PencilIcon, RotateCcwIcon, TrashIcon } from "lucide-react";
import { useState } from "react";

import { Input } from "../components/ui/input";
import { cn } from "../lib/utils";
import { boardLabelChipStyle, indexBoardLabels, resolveBoardLabels } from "./labelColour";
import { boardLabelPickerModel } from "./labelPickerModel";

export interface BoardLabelFieldProps {
  readonly catalogue: ReadonlyArray<BoardLabel>;
  readonly selectedLabelIds: ReadonlyArray<BoardLabelId>;
  readonly onToggle: (labelId: BoardLabelId) => void;
  readonly onCreate: (name: string) => void;
  readonly onRecolour: (labelId: BoardLabelId, colour: string) => void;
  readonly onDelete: (labelId: BoardLabelId) => void;
  readonly onUndelete: (labelId: BoardLabelId) => void;
}

export function BoardLabelField(props: BoardLabelFieldProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [editingColourFor, setEditingColourFor] = useState<BoardLabelId | null>(null);
  const model = boardLabelPickerModel({
    catalogue: props.catalogue,
    selectedLabelIds: props.selectedLabelIds,
    query,
  });
  const pills = resolveBoardLabels(props.selectedLabelIds, indexBoardLabels(props.catalogue));

  const close = () => {
    setOpen(false);
    setQuery("");
    setEditingColourFor(null);
  };
  /** Enter takes the first match, or creates the typed name; either way the
      query clears and the list stays open for the next one. */
  const commitQuery = () => {
    const first = model.matches[0];
    if (first !== undefined) props.onToggle(first.label.labelId);
    else if (model.canCreate) props.onCreate(model.createName);
    else return;
    setQuery("");
  };

  return (
    <div className="flex flex-col gap-1.5">
      {pills.length === 0 ? null : (
        <div className="flex flex-wrap gap-[5px]">
          {pills.map((label) => (
            <span
              className={cn(
                "inline-flex h-[18px] max-w-full items-center truncate rounded-[5px] px-1.5 text-[10px] font-medium uppercase tracking-[0.03em]",
                label.colour === null && "border border-dashed border-border bg-muted/60",
                label.deleted && "opacity-55",
              )}
              key={label.labelId}
              style={label.colour === null ? undefined : boardLabelChipStyle(label.colour)}
              title={
                label.missing
                  ? "Unknown label"
                  : label.deleted
                    ? `${label.name} (deleted)`
                    : label.name
              }
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      <div className="relative">
        <Input
          className="h-[30px] text-[12.5px]"
          onBlur={close}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              commitQuery();
            }
          }}
          placeholder="Search or create a label"
          value={query}
        />

        {open ? (
          // `onMouseDown` is prevented on every row, so a click never blurs
          // the input — the list survives picking several labels in a row.
          <div className="absolute inset-x-0 top-[calc(100%+4px)] z-10 flex max-h-[230px] flex-col gap-px overflow-y-auto rounded-[10px] border border-border bg-popover p-1 shadow-lg">
            {model.matches.map(({ label, selected }) => (
              <div className="flex flex-col" key={label.labelId}>
                <div
                  className={cn(
                    "group flex h-7 cursor-pointer items-center gap-2 rounded-[7px] px-1.5 text-[12.5px] text-foreground hover:bg-accent",
                    selected && "font-medium",
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    props.onToggle(label.labelId);
                    setQuery("");
                  }}
                  role="presentation"
                >
                  <span
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ backgroundColor: label.colour }}
                  />
                  <span className="min-w-0 flex-1 truncate text-left">{label.name}</span>
                  {selected ? (
                    <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                  <span
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setEditingColourFor((current) =>
                        current === label.labelId ? null : label.labelId,
                      );
                    }}
                    role="presentation"
                    title="Change colour"
                  >
                    <PencilIcon className="size-3" />
                  </span>
                  <span
                    className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      props.onDelete(label.labelId);
                    }}
                    role="presentation"
                    title="Delete label"
                  >
                    <TrashIcon className="size-3" />
                  </span>
                </div>
                {editingColourFor === label.labelId ? (
                  <div className="flex flex-wrap gap-[5px] py-1.5 pr-1.5 pl-6">
                    {BOARD_LABEL_SWATCHES.map((swatch) => (
                      <span
                        className={cn(
                          "size-5 cursor-pointer rounded-md border-2",
                          label.colour === swatch ? "border-foreground" : "border-transparent",
                        )}
                        key={swatch}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          props.onRecolour(label.labelId, swatch);
                          setEditingColourFor(null);
                        }}
                        role="presentation"
                        style={{ backgroundColor: swatch }}
                        title={swatch}
                      />
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {model.canCreate ? (
              <div
                className="flex h-7 cursor-pointer items-center gap-2 rounded-[7px] px-1.5 text-[12.5px] text-foreground hover:bg-accent"
                onMouseDown={(event) => {
                  event.preventDefault();
                  props.onCreate(model.createName);
                  setQuery("");
                }}
                role="presentation"
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  Create “{model.createName}”
                </span>
              </div>
            ) : null}

            {model.matches.length === 0 && !model.canCreate ? (
              <div className="px-1.5 py-2 text-[12.5px] text-muted-foreground">
                No labels yet — type a name to create one.
              </div>
            ) : null}

            {model.deleted.length > 0 ? (
              <div className="mt-1 flex flex-col gap-px border-t border-border pt-1">
                <span className="px-1.5 text-[10.5px] font-medium text-muted-foreground">
                  Deleted
                </span>
                {model.deleted.map((label) => (
                  <div
                    className="flex h-7 items-center gap-2 rounded-[7px] px-1.5 text-[12.5px] text-muted-foreground"
                    key={label.labelId}
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-[3px] opacity-55"
                      style={{ backgroundColor: label.colour }}
                    />
                    <span className="min-w-0 flex-1 truncate text-left line-through">
                      {label.name}
                    </span>
                    <span
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] hover:bg-accent hover:text-foreground"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        props.onUndelete(label.labelId);
                      }}
                      role="presentation"
                      title="Restore label"
                    >
                      <RotateCcwIcon className="size-3" />
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

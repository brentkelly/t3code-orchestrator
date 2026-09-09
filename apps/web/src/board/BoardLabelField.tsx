/**
 * T3o label field (t3o-06a, reshaped by T3O-31) — one control for both the
 * create dialog and the card modal's rail: a trigger button showing the card's
 * labels as chips (or a muted "Add labels"), and a popover behind it holding
 * the search box and the catalogue.
 *
 * The always-visible search input it replaces was the first text box in the
 * create dialog, so a typed title landed in it and was lost. Behind a trigger
 * there is nothing to type into by accident, and the search box only takes
 * focus once you have said you want it.
 *
 * Selection is loud on purpose. The list stays open across picks (labels are a
 * set, so you choose several in one visit), which means a quiet selection
 * reads as a click that did nothing: a picked row gets a filled checkbox, a
 * tint of its own colour, a colour-matched ring and a left bar
 * (`boardLabelRowStyle`).
 *
 * Colour editing lives on the row's pencil and dispatches a
 * `board.label.update`, so a recolour repaints every card via the catalogue
 * delta — there is no local-only colour state. Delete and restore stay
 * (a tombstoned label is never a one-way door, t3o-06a); the bin is quiet
 * until you hover the row.
 */
import { BOARD_LABEL_SWATCHES, type BoardLabel, type BoardLabelId } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  PencilIcon,
  RotateCcwIcon,
  TagIcon,
  TrashIcon,
} from "lucide-react";
import { useState } from "react";

import { Input } from "../components/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import {
  boardLabelChipRows,
  boardLabelChipStyle,
  boardLabelForeground,
  boardLabelRowStyle,
  indexBoardLabels,
} from "./labelColour";
import { boardLabelPickerModel } from "./labelPickerModel";
import { BoardHint } from "./BoardHint";

/** The trigger shows at most this many chips; the rest collapse into `+N`, so
    the trigger's height never depends on how many labels a card carries. */
const TRIGGER_CHIPS = 2;

/** A chip inside the trigger — the card chip's shape, one notch taller so it
    sits comfortably in a full-height control. */
const TRIGGER_CHIP_CLASS =
  "inline-flex h-[18px] max-w-24 shrink-0 items-center truncate rounded-[5px] px-1.5 text-[10px] font-medium tracking-[0.03em] uppercase";

/** One catalogue row's height, shared by the live rows, the create row and the
    restore rows so the list reads as one list. */
const ROW_CLASS = "flex h-[30px] items-center gap-2 rounded-[7px] px-2 text-[12.5px]";

/** Every control in the popover acts on CLICK, not on mousedown: a keyboard
    activation dispatches a click and no mousedown, so a mousedown-only button
    would sit in the tab order doing nothing. `mousedown` is still prevented —
    but only to suppress the focus shift, so a mouse pick leaves the caret in
    the search box and you can type, pick, type again. Same pair as
    `CommandPaletteResults`/`ComposerCommandMenu`. */
const keepFocus = (event: { preventDefault: () => void }) => {
  event.preventDefault();
};

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [editingColourFor, setEditingColourFor] = useState<BoardLabelId | null>(null);
  const model = boardLabelPickerModel({
    catalogue: props.catalogue,
    selectedLabelIds: props.selectedLabelIds,
    query,
  });
  const chips = boardLabelChipRows(
    props.selectedLabelIds,
    indexBoardLabels(props.catalogue),
    TRIGGER_CHIPS,
  );
  const selectedNames = [...chips.visible.map((label) => label.name), ...chips.overflowNames];

  /** Enter takes the first match, or creates the typed name; either way the
      query clears and the popover stays open for the next one. */
  const commitQuery = () => {
    const first = model.matches[0];
    if (first !== undefined) props.onToggle(first.label.labelId);
    else if (model.canCreate) props.onCreate(model.createName);
    else return;
    setQuery("");
  };

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        // Every visit starts clean: a query left behind would silently hide
        // most of the catalogue the next time the popover opened.
        setQuery("");
        setEditingColourFor(null);
      }}
      open={open}
    >
      {/* Height tracks the `Input` beside it — its 34px/30px field plus the
          1px border — so row 2 reads as one row rather than two controls. */}
      <PopoverTrigger
        aria-label={
          selectedNames.length === 0 ? "Add labels" : `Labels: ${selectedNames.join(", ")}`
        }
        className="flex h-9 w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border border-input bg-background pr-2 pl-2.5 text-foreground shadow-xs/5 transition-colors hover:bg-accent focus-visible:border-ring focus-visible:outline-none sm:h-8 dark:bg-input/32"
        type="button"
      >
        <TagIcon className="size-[13px] shrink-0 text-muted-foreground" />
        {selectedNames.length === 0 ? (
          <span className="min-w-0 flex-1 text-left text-[12.5px] text-muted-foreground">
            Add labels
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {chips.visible.map((label) => (
              <span
                className={cn(
                  TRIGGER_CHIP_CLASS,
                  label.colour === null &&
                    "border border-dashed border-border bg-muted/60 text-muted-foreground",
                  label.deleted && "opacity-55",
                )}
                key={label.labelId}
                style={label.colour === null ? undefined : boardLabelChipStyle(label.colour)}
              >
                {label.name}
              </span>
            ))}
            {chips.overflow > 0 ? (
              <span className={cn(TRIGGER_CHIP_CLASS, "bg-muted text-muted-foreground")}>
                +{chips.overflow}
              </span>
            ) : null}
          </span>
        )}
        <ChevronDownIcon className="size-[14px] shrink-0 text-muted-foreground" />
      </PopoverTrigger>

      {/* `align="end"` pins the popover to the trigger's right edge, which is
          where the field sits in the create dialog's Title/Label row. */}
      <PopoverPopup
        align="end"
        className="w-[280px] max-w-[calc(100vw-80px)] p-1.5"
        viewportClassName="p-0"
      >
        <div className="flex min-w-0 flex-col gap-[5px]">
          <Input
            autoFocus
            className="h-[30px] rounded-lg text-[12.5px]"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commitQuery();
              }
            }}
            placeholder="Search or create a label"
            value={query}
          />

          {/* Rows act on click and only suppress mousedown's focus shift
              (`keepFocus`), so mouse and keyboard run the same code. */}
          <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto">
            {model.matches.map(({ label, selected }) => (
              <div className="flex flex-col" key={label.labelId}>
                <div
                  className={cn("group", ROW_CLASS, !selected && "hover:bg-accent")}
                  style={boardLabelRowStyle(label.colour, selected)}
                >
                  <button
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2 text-left text-foreground",
                      selected ? "font-semibold" : "font-normal",
                    )}
                    onClick={() => {
                      props.onToggle(label.labelId);
                      setQuery("");
                    }}
                    onMouseDown={keepFocus}
                    type="button"
                  >
                    {/* The checkbox is the selection state. It fills with the
                        label's own colour, and the tick's colour is COMPUTED
                        from that fill — a flat white tick disappears on the
                        amber and yellow swatches. */}
                    <span
                      className={cn(
                        "inline-flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border",
                        selected ? "border-transparent" : "border-input bg-background",
                      )}
                      style={
                        selected
                          ? {
                              backgroundColor: label.colour,
                              borderColor: label.colour,
                            }
                          : undefined
                      }
                    >
                      {selected ? (
                        <CheckIcon
                          className="size-[11px]"
                          style={{ color: boardLabelForeground(label.colour) }}
                        />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{label.name}</span>
                  </button>
                  <BoardHint label="Change colour">
                    <button
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        setEditingColourFor((current) =>
                          current === label.labelId ? null : label.labelId,
                        );
                      }}
                      onMouseDown={keepFocus}
                      type="button"
                    >
                      <PencilIcon className="size-3" />
                    </button>
                  </BoardHint>
                  <BoardHint label="Delete label">
                    <button
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-accent hover:text-foreground"
                      onClick={() => {
                        props.onDelete(label.labelId);
                      }}
                      onMouseDown={keepFocus}
                      type="button"
                    >
                      <TrashIcon className="size-3" />
                    </button>
                  </BoardHint>
                </div>
                {editingColourFor === label.labelId ? (
                  <div className="flex flex-wrap gap-[5px] py-1.5 pr-1.5 pl-7">
                    {BOARD_LABEL_SWATCHES.map((swatch) => (
                      <BoardHint key={swatch} label={swatch}>
                        <button
                          className={cn(
                            "size-5 rounded-md border-2",
                            label.colour === swatch ? "border-foreground" : "border-transparent",
                          )}
                          onClick={() => {
                            props.onRecolour(label.labelId, swatch);
                            setEditingColourFor(null);
                          }}
                          onMouseDown={keepFocus}
                          style={{ backgroundColor: swatch }}
                          type="button"
                        />
                      </BoardHint>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}

            {model.canCreate ? (
              <button
                className={cn(ROW_CLASS, "text-foreground hover:bg-accent")}
                onClick={() => {
                  props.onCreate(model.createName);
                  setQuery("");
                }}
                onMouseDown={keepFocus}
                type="button"
              >
                <span className="min-w-0 flex-1 truncate text-left">
                  Create “{model.createName}”
                </span>
              </button>
            ) : null}

            {model.matches.length === 0 && !model.canCreate ? (
              <div className="px-2 py-2 text-[12.5px] text-muted-foreground">
                No labels yet — type a name to create one.
              </div>
            ) : null}

            {model.deleted.length > 0 ? (
              <div className="mt-1 flex flex-col gap-px border-t border-border pt-1">
                <span className="px-2 text-[10.5px] font-medium text-muted-foreground">
                  Deleted
                </span>
                {model.deleted.map((label) => (
                  <div className={cn(ROW_CLASS, "text-muted-foreground")} key={label.labelId}>
                    <span
                      className="size-2.5 shrink-0 rounded-[3px] opacity-55"
                      style={{ backgroundColor: label.colour }}
                    />
                    <span className="min-w-0 flex-1 truncate text-left line-through">
                      {label.name}
                    </span>
                    <BoardHint label="Restore label">
                      <button
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-[5px] hover:bg-accent hover:text-foreground"
                        onClick={() => {
                          props.onUndelete(label.labelId);
                        }}
                        onMouseDown={keepFocus}
                        type="button"
                      >
                        <RotateCcwIcon className="size-3" />
                      </button>
                    </BoardHint>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * T3o card label chips (t3o-06a): a card renders 0..n chips resolved from the
 * board's label catalogue by id. Designed for the cap — the first two show,
 * the rest collapse into a `+N` overflow, so a heavily-labelled card cannot
 * push the summary out of the card. A tombstoned or unknown label renders
 * muted (its history stays honest) rather than disappearing. Chip foreground
 * is computed from the fill colour's luminance, never hand-picked.
 */
import type { BoardLabel, BoardLabelId } from "@t3tools/contracts";

import { cn } from "../lib/utils";
import { boardLabelChipStyle, resolveBoardLabels } from "./labelColour";
import { BoardHint } from "./BoardHint";

const VISIBLE_CHIPS = 2;

/** The prototype's card chip: small, uppercase, letter-spaced. */
const CHIP_CLASS =
  "inline-flex h-4 max-w-24 shrink-0 items-center truncate rounded-[5px] px-1.5 text-[10px] font-medium tracking-[0.03em] uppercase";

export function BoardLabelChips({
  labelIds,
  labelsById,
}: {
  readonly labelIds: ReadonlyArray<BoardLabelId>;
  readonly labelsById: ReadonlyMap<BoardLabelId, BoardLabel>;
}) {
  if (labelIds.length === 0) return null;
  const resolved = resolveBoardLabels(labelIds, labelsById);
  const visible = resolved.slice(0, VISIBLE_CHIPS);
  const overflow = resolved.length - visible.length;
  return (
    <>
      {visible.map((label) =>
        label.colour === null ? (
          <BoardHint
            key={label.labelId}
            label={label.missing ? "Unknown label" : `${label.name} (deleted)`}
          >
            <span
              className={cn(
                CHIP_CLASS,
                "border border-dashed border-border bg-muted/60 text-muted-foreground",
              )}
            >
              {label.name}
            </span>
          </BoardHint>
        ) : (
          <BoardHint
            key={label.labelId}
            label={label.deleted ? `${label.name} (deleted)` : label.name}
          >
            <span
              className={cn(CHIP_CLASS, label.deleted && "opacity-55")}
              style={boardLabelChipStyle(label.colour)}
            >
              {label.name}
            </span>
          </BoardHint>
        ),
      )}
      {overflow > 0 ? (
        <BoardHint
          label={resolved
            .slice(VISIBLE_CHIPS)
            .map((label) => label.name)
            .join(", ")}
        >
          <span className={cn(CHIP_CLASS, "bg-muted text-muted-foreground")}>+{overflow}</span>
        </BoardHint>
      ) : null}
    </>
  );
}

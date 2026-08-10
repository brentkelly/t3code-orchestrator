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
import { boardLabelForeground, resolveBoardLabels } from "./labelColour";

const VISIBLE_CHIPS = 2;

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
          <span
            key={label.labelId}
            className={cn(
              "inline-flex h-4 max-w-24 shrink-0 items-center truncate rounded px-1.5 text-[10px] font-medium capitalize",
              "border border-dashed border-border bg-muted/60 text-muted-foreground",
            )}
            title={label.missing ? "Unknown label" : `${label.name} (deleted)`}
          >
            {label.name}
          </span>
        ) : (
          <span
            key={label.labelId}
            className={cn(
              "inline-flex h-4 max-w-24 shrink-0 items-center truncate rounded px-1.5 text-[10px] font-medium capitalize",
              label.deleted && "opacity-55",
            )}
            style={{ backgroundColor: label.colour, color: boardLabelForeground(label.colour) }}
            title={label.deleted ? `${label.name} (deleted)` : label.name}
          >
            {label.name}
          </span>
        ),
      )}
      {overflow > 0 ? (
        <span
          className="inline-flex h-4 shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground"
          title={resolved
            .slice(VISIBLE_CHIPS)
            .map((label) => label.name)
            .join(", ")}
        >
          +{overflow}
        </span>
      ) : null}
    </>
  );
}

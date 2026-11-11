/**
 * The pure view logic behind `BoardLabelPicker`. Selecting toggles membership.
 */
import type { BoardLabel, BoardLabelId } from "@t3tools/contracts";

export interface BoardLabelPickerRow {
  readonly label: BoardLabel;
  readonly selected: boolean;
}

export interface BoardLabelPickerModel {
  /** Live labels matching the query, each flagged with current membership. */
  readonly matches: ReadonlyArray<BoardLabelPickerRow>;
  /** Tombstoned labels matching the query — the restore section (reverse
      state: a deleted label is never a one-way door). */
  readonly deleted: ReadonlyArray<BoardLabel>;
  /** The query names a label that does not yet exist (case-insensitively),
      so an inline create is offered. */
  readonly canCreate: boolean;
  /** Trimmed query — the name a create would use. */
  readonly createName: string;
}

export function boardLabelPickerModel(input: {
  readonly catalogue: ReadonlyArray<BoardLabel>;
  readonly selectedLabelIds: ReadonlyArray<BoardLabelId>;
  readonly query: string;
}): BoardLabelPickerModel {
  const trimmed = input.query.trim();
  const needle = trimmed.toLowerCase();
  const selected = new Set(input.selectedLabelIds);
  const matchesQuery = (label: BoardLabel) =>
    needle.length === 0 || label.name.toLowerCase().includes(needle);

  const live = input.catalogue.filter((label) => label.deletedAt === null);
  const matches = live
    .filter(matchesQuery)
    .map((label) => ({ label, selected: selected.has(label.labelId) }));
  const deleted = input.catalogue.filter(
    (label) => label.deletedAt !== null && matchesQuery(label),
  );

  const canCreate =
    trimmed.length > 0 && !live.some((label) => label.name.toLowerCase() === needle);

  return { matches, deleted, canCreate, createName: trimmed };
}

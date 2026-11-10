/**
 * Collapsing repeated rows in the card Activity rail (T3O-35).
 *
 * A long planning session asks 20-30 questions, and every one of them writes a
 * `card-input-requested` row that renders the same sentence as the one above
 * it. The rail is a deterministic projection, so it cannot suppress the events
 * — but it can say the same thing once. Consecutive rows that would render
 * IDENTICALLY collapse to their newest member plus a "+N more" toggle.
 *
 * Identity is the rendered row, not the kind: two rows collapse only when their
 * kind, actor and payload all match, so "asked for input on Planning" never
 * swallows "asked for input on Code review", and a run interrupted by a
 * different row stays two runs. `threadId` is deliberately not part of the
 * identity — the rail never shows it, so two rows that differ only there are
 * the same sentence twice.
 *
 * The run keeps its NEWEST member as the visible row, which is both the current
 * state and the only choice that keeps the rail's timestamps monotonic: the
 * rows after a run are newer than all of it.
 */
import type { BoardCardActivityEntry } from "@t3tools/contracts";

/**
 * The shortest run worth collapsing. Two rows collapse to one row plus a
 * toggle, which is the same height for less information — so the floor is
 * three.
 */
const BOARD_ACTIVITY_COLLAPSE_MIN_RUN = 3;

export interface BoardActivityGroup {
  /** Stable across re-renders and across the run GROWING, so an expanded run
      that gains another identical row stays expanded: it is the id of the
      run's oldest member, the one member a later event cannot change. */
  readonly key: string;
  /** Chronological, never empty. */
  readonly entries: ReadonlyArray<BoardCardActivityEntry>;
  /** Whether the run is long enough to be worth hiding. */
  readonly collapsible: boolean;
}

/** Everything about a row that the rail turns into visible text.
 *
 * JSON is the delimiter: nesting the payload as a sorted array of pairs makes
 * the encoding unambiguous without inventing a separator that a payload value
 * could itself contain. Key order is normalised because the order the projector
 * happens to write fields in is not part of what the row says. */
function rowSignature(entry: BoardCardActivityEntry): string {
  const payload = entry.payload as Record<string, unknown>;
  const fields = Object.keys(payload)
    .sort()
    .map((key) => [key, payload[key] ?? null] as const);
  const actor = entry.actor;
  return JSON.stringify([
    entry.kind,
    actor.kind,
    actor.name ?? null,
    actor.providerInstanceId ?? null,
    fields,
  ]);
}

/** What the rail draws for one group at a given expansion state: the rows it
    shows, and the toggle's label when the run is long enough to have one. */
export interface BoardActivityGroupView {
  readonly rows: ReadonlyArray<BoardCardActivityEntry>;
  /** `null` when the run is too short to hide anything, so no toggle renders. */
  readonly toggleLabel: string | null;
}

/**
 * Collapsed, a run is its newest member plus "+N more"; expanded it is every
 * member plus "Show less". The toggle hangs off the run's LAST visible row in
 * both states, which is that same newest member — so opening a run never moves
 * the control out from under the cursor.
 */
export function boardActivityGroupView(
  group: BoardActivityGroup,
  expanded: boolean,
): BoardActivityGroupView {
  if (!group.collapsible) return { rows: group.entries, toggleLabel: null };
  if (expanded) return { rows: group.entries, toggleLabel: "Show less" };
  return {
    rows: [group.entries[group.entries.length - 1]!],
    toggleLabel: `+${group.entries.length - 1} more`,
  };
}

/** Pressing one run's toggle. Expansion is per-run and keyed by the run's
    oldest member, so opening one run never closes another. */
export function toggleBoardActivityGroup(
  expandedKeys: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(expandedKeys);
  if (!next.delete(key)) next.add(key);
  return next;
}

/**
 * Fold an activity list into runs of identical consecutive rows. Every entry
 * comes back exactly once, in order — a run shorter than `minRun` is still a
 * group, just one the rail renders in full.
 */
export function groupBoardActivity(
  entries: ReadonlyArray<BoardCardActivityEntry>,
  minRun: number = BOARD_ACTIVITY_COLLAPSE_MIN_RUN,
): ReadonlyArray<BoardActivityGroup> {
  const floor = Math.max(2, minRun);
  const groups: BoardActivityGroup[] = [];
  let run: BoardCardActivityEntry[] = [];
  let signature: string | null = null;

  const flush = () => {
    if (run.length === 0) return;
    const members = run;
    groups.push({
      key: members[0]!.activityId,
      entries: members,
      collapsible: members.length >= floor,
    });
    run = [];
  };

  for (const entry of entries) {
    const next = rowSignature(entry);
    if (signature !== next) {
      flush();
      signature = next;
    }
    run.push(entry);
  }
  flush();
  return groups;
}

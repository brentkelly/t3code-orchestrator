/**
 * Collapses consecutive Activity rows that render identically (kind, actor and
 * payload; `threadId` is never shown) into the newest one plus "+N more". The
 * newest keeps the rail's timestamps monotonic.
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

/** Everything about a row that renders as text. JSON over sorted payload pairs
    is an unambiguous encoding, independent of the projector's key order. */
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

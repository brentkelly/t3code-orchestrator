/**
 * Merge-conflict copy for the card pill, its tooltip and the modal banner, so
 * they cannot disagree. Pure: the fact is the shell's `stepConflictFix`.
 */

export interface BoardConflictFixInfo {
  /** The pill on the column card. The same word whether the fix is running or
      waiting for an agent: it asserts the HELD merge, not motion, which is why
      it still says something while the fix sits in the queue. */
  readonly label: string;
  /** The pill's tooltip — the whole story, minus the base branch, which the
      column card does not carry. */
  readonly tooltip: string;
  /** The banner's bold line. */
  readonly headline: string;
  /** What it means for the user: that nothing is expected of them. */
  readonly detail: string;
  /** Why the Merge button is disabled while the fix runs. */
  readonly mergeDisabledReason: string;
}

/**
 * The full conflict story for one card, or null when its merge is not held.
 *
 * `baseRef` is the branch being merged INTO, and only the card modal has it —
 * the shell carries no base and should not grow one for a tooltip. The board
 * says the same thing without naming it.
 */
export function boardConflictFix(input: {
  /** `BoardCardShell.stepConflictFix`: a live conflict fix, running or queued. */
  readonly live: boolean;
  /** `BoardCardShell.stepChecksFix` (T3O-12): a live CI fix. The merge is held
      the same way, so it wears the same amber pill and banner with its own
      words. */
  readonly checks?: boolean | undefined;
  /** Whether that fix is still waiting for an agent slot rather than running.
      Worth its own words: the card does get a queue pill while it holds,
      but that pill says "Queued #3" and nothing about a merge being held, so
      on its own it explains neither the wait nor the dead Merge button. */
  readonly queued?: boolean | undefined;
  /** The pull request's base branch, when the surface knows it. */
  readonly baseRef?: string | null | undefined;
}): BoardConflictFixInfo | null {
  if (input.checks === true) return boardChecksFix(input.queued === true);
  if (!input.live) return null;
  const base = input.baseRef == null || input.baseRef === "" ? "the base branch" : input.baseRef;
  if (input.queued === true) {
    return {
      label: "Conflicts",
      tooltip:
        "The merge hit conflicts. An agent picks it up when one frees up, so nothing is needed from you.",
      headline: `Waiting for an agent to resolve conflicts against ${base}`,
      // The build-queue banner owns the queue mechanics in the wide layout, so this
      // names the wait and stops.
      detail: "The merge holds until an agent is free and the thread finishes.",
      mergeDisabledReason: "Resolving conflicts…",
    };
  }
  return {
    label: "Conflicts",
    tooltip: "The merge hit conflicts. A thread is resolving them, so nothing is needed from you.",
    headline: `Resolving conflicts against ${base}`,
    detail: "The merge holds until the thread finishes.",
    mergeDisabledReason: "Resolving conflicts…",
  };
}

/** The CI-fix story (T3O-12): the merge was refused for failing checks and an
    agent is fixing them. */
function boardChecksFix(queued: boolean): BoardConflictFixInfo {
  return queued
    ? {
        label: "Fixing CI",
        tooltip:
          "The pull request's checks failed. An agent picks it up when one frees up, so nothing is needed from you.",
        headline: "Waiting for an agent to fix the failing checks",
        detail: "The merge holds until an agent is free, the fix is pushed and CI passes.",
        mergeDisabledReason: "Fixing CI…",
      }
    : {
        label: "Fixing CI",
        tooltip:
          "The pull request's checks failed. A thread is fixing them, so nothing is needed from you.",
        headline: "Fixing the failing checks",
        detail: "The merge holds until the fix is pushed and CI passes.",
        mergeDisabledReason: "Fixing CI…",
      };
}

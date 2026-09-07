/**
 * T3o merge-conflict copy (T3O-9). One place that turns "this card's merge is
 * held by conflicts" into the words every surface shows — the column card's
 * pill and its tooltip, and the card modal's banner — so the two can never tell
 * the user two different stories.
 *
 * Pure: the fact itself is `BoardCardShell.stepConflictFix`, derived on the
 * server from the step row's `Conflicts` label (`isBoardConflictFixLive`).
 * Nothing here reads state.
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
  /** Whether that fix is still waiting for an agent slot rather than running.
      Worth its own words: the card does get a build-queue pill while it
      holds, but that pill says "queued for build" and nothing about a merge
      being held, so on its own it explains neither the wait nor the dead Merge
      button. */
  readonly queued?: boolean | undefined;
  /** The pull request's base branch, when the surface knows it. */
  readonly baseRef?: string | null | undefined;
}): BoardConflictFixInfo | null {
  if (!input.live) return null;
  const base = input.baseRef == null || input.baseRef === "" ? "the base branch" : input.baseRef;
  if (input.queued === true) {
    return {
      label: "Conflicts",
      tooltip:
        "The merge hit conflicts. An agent picks it up when one frees up — nothing is needed from you.",
      headline: `Waiting for an agent to resolve conflicts against ${base}`,
      // Names the wait and stops there. The queued case also draws the
      // build-queue banner (t3o-33) a few lines below in the wide layout, and
      // that banner owns the mechanics — the position, the agent count, the two
      // override buttons — so repeating "it starts on its own when an agent
      // frees up" here would print the same sentence twice on one screen.
      detail: "The merge holds until an agent is free and the thread finishes.",
    };
  }
  return {
    label: "Conflicts",
    tooltip: "The merge hit conflicts. A thread is resolving them — nothing is needed from you.",
    headline: `Resolving conflicts against ${base}`,
    detail: "The merge holds until the thread finishes.",
  };
}

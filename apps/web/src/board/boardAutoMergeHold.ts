/**
 * T3o auto-merge copy (T3O-38). One place that turns "this card's merge was
 * refused" into the words every surface shows — the column card's pill and
 * tooltip, the card modal's banner, the Merge button's countdown and the kebab
 * switch — so no two of them can tell the user different stories.
 *
 * Pure: the facts are `BoardCardShell.autoMergeHeldSince` /
 * `autoMergeGaveUp` / `autoMergeArmed` on the board, and
 * `BoardCard.autoMergeHold` in the modal, both derived on the server. Nothing
 * here reads state or a clock — `nowMs` arrives as an argument, the same split
 * `boardCardScheduleLabel` keeps.
 *
 * On COLOUR (D12): both board states are AMBER. `docs/t3o/status-colours.md`
 * gives amber to "blocked or held", and a retrying hold and an exhausted one
 * are both held; the board card has never carried red and this does not give
 * it one. The two states are told apart by their LABEL and ICON instead. The
 * modal banner does split amber → red, exactly as the stalled banner has since
 * t3o-30: amber while the board will end the wait itself, red once it stays
 * put until a human acts.
 */

/** `12m`, `1h 5m`, `2d 3h`. Coarse on purpose: this is an elapsed figure a
    human glances at, and a ticking seconds reading on thirty board cards is a
    continuously repainting animation. */
export function boardAutoMergeElapsedLabel(heldSinceIso: string, nowMs: number): string {
  const atMs = Date.parse(heldSinceIso);
  if (!Number.isFinite(atMs)) return "";
  const minutes = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

export interface BoardAutoMergePill {
  /** `Merge held · 12m` while rungs remain; `Merge needs you` once they are
      gone. The distinction the prototype spent a colour on, carried by the
      words instead. */
  readonly label: string;
  readonly tooltip: string;
  /** Which glyph the pill wears — a clock for a wait, an alert for a stop. */
  readonly icon: "clock" | "alert";
}

/**
 * The board card's pill, or null when its merge is not held.
 *
 * Mutually exclusive with the conflict pill by construction: a conflict fix
 * RUNS, a hold WAITS, and the server never records both — the conflict path
 * clears the hold. They share the same slot, and the caller gives the
 * conflict the slot when it somehow has both, because a running agent is the
 * more specific claim.
 */
export function boardAutoMergePill(input: {
  /** `BoardCardShell.autoMergeHeldSince`. */
  readonly heldSince: string | null | undefined;
  /** `BoardCardShell.autoMergeGaveUp`. */
  readonly gaveUp: boolean | undefined;
  /** A done card is asking for nothing. The server clears the hold as the
      card leaves the merge stage, so this only covers the tick before that
      lands. */
  readonly done: boolean;
  readonly nowMs: number;
}): BoardAutoMergePill | null {
  if (input.done || input.heldSince == null) return null;
  if (input.gaveUp === true) {
    return {
      label: "Merge needs you",
      // The forge's own reason lives on the full card, which only the modal
      // subscribes to (D14's byte budget), so the board says where to find it
      // rather than inventing a summary it does not have.
      tooltip: "Auto-merge stopped. Open the card to see what the forge said.",
      icon: "alert",
    };
  }
  const elapsed = boardAutoMergeElapsedLabel(input.heldSince, input.nowMs);
  return {
    label: elapsed === "" ? "Merge held" : `Merge held · ${elapsed}`,
    tooltip: "The forge refused the merge. The board is retrying — nothing is needed from you.",
    icon: "clock",
  };
}

export interface BoardAutoMergeBannerInput {
  /** The card's hold, straight off the aggregate. */
  readonly reason: string;
  readonly detail: string | null;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly heldSince: string;
  readonly retryAt: string | null;
  readonly nowMs: number;
}

export interface BoardAutoMergeBanner {
  readonly headline: string;
  /** The forge's own words, verbatim. */
  readonly reason: string;
  /** `Held 12m · attempt 5 of 8 · 3 of 5 checks green`. */
  readonly meta: string;
  /** Amber while the board will end the wait itself, red once it will not
      (D12) — the treatment the stalled banner already uses. */
  readonly tone: "warning" | "destructive";
}

/** The card modal's banner. */
export function boardAutoMergeBanner(input: BoardAutoMergeBannerInput): BoardAutoMergeBanner {
  const gaveUp = input.retryAt === null;
  const parts = [
    `Held ${boardAutoMergeElapsedLabel(input.heldSince, input.nowMs)}`,
    `attempt ${input.attempt} of ${input.maxAttempts}`,
    ...(input.detail === null ? [] : [input.detail]),
  ];
  return {
    headline: gaveUp ? "Auto-merge stopped" : "Auto-merge is retrying",
    reason: input.reason,
    meta: parts.join(" · "),
    tone: gaveUp ? "destructive" : "warning",
  };
}

/** `m:ss` until the next attempt, or null once the ladder has stopped. The
    ONE per-second element in the product, and only for the card open in the
    modal — see `BoardCardDetailView` for the carve-out. */
export function boardAutoMergeCountdown(retryAtIso: string | null, nowMs: number): string | null {
  if (retryAtIso === null) return null;
  const atMs = Date.parse(retryAtIso);
  if (!Number.isFinite(atMs)) return null;
  const seconds = Math.max(0, Math.round((atMs - nowMs) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface BoardAutoMergeToggleCopy {
  readonly label: string;
  readonly hint: string;
}

/**
 * The kebab switch's two states. Off states the consequence of leaving it off,
 * because the whole point of the feature is that the alternative is coming
 * back to click Merge; on states what will happen.
 */
export function boardAutoMergeToggleCopy(armed: boolean): BoardAutoMergeToggleCopy {
  return armed
    ? {
        label: "Auto-merge when ready",
        hint: "Merges itself as soon as the forge accepts it, retrying a check that is still running.",
      }
    : {
        label: "Auto-merge when ready",
        hint: "Otherwise this card waits at Ready for merge until you come back and click Merge.",
      };
}

/** The modal header's read-only chip, or null when the card is not armed.
    Names the SOURCE, because a user who cannot find the switch needs to know
    it is a board-wide setting rather than something wrong with their card. */
export function boardAutoMergeHeaderChip(input: {
  readonly armed: boolean;
  readonly fromBoardSetting: boolean;
}): { readonly label: string; readonly tooltip: string } | null {
  if (!input.armed) return null;
  return input.fromBoardSetting
    ? {
        label: "Auto-merge · board",
        tooltip:
          "Every card arriving at Ready for merge is merged automatically. Settings → Board → Pipeline → Ready for merge.",
      }
    : { label: "Auto-merge", tooltip: "This card merges itself as soon as the forge accepts it." };
}

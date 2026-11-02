/**
 * Compact fullscreen chrome (T3O-17): on a short viewport the maximised card
 * sheet collapses the large title and the thread tab strip into the identity
 * row so the chat reclaims the height those two rows spend.
 *
 * The height cutoff is the same query T3O-51 uses for the non-maximised
 * sheet (`max-height: 999.98px`). Compact is derived only — there is no
 * persisted preference and no manual override.
 */

/** Live `matchMedia` query for a short viewport. Same cutoff as T3O-51. */
export const BOARD_CARD_COMPACT_CHROME_QUERY = "(max-height: 999.98px)";

/** Compact chrome is on only while the sheet is actually maximised on a short viewport. */
export function boardCardCompactChrome(maximised: boolean, shortViewport: boolean): boolean {
  return maximised && shortViewport;
}

/** Trigger / row label for the folded thread dropdown: role, then the title. */
export function boardCardCompactThreadLabel(role: string, title: string | null): string {
  return `${role} · ${title ?? "Deleted thread"}`;
}

/** Tab-strip hover and compact-row hint: role, plus the worker when the board has more than one. */
export function boardCardThreadLinkHint(link: {
  readonly tombstoned: boolean;
  readonly role: string;
  readonly ranOn: string | null;
}): string {
  if (link.tombstoned) return "Deleted thread";
  if (link.ranOn === null) return link.role;
  return `${link.role} · ${link.ranOn}`;
}

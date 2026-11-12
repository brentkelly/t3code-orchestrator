/**
 * T3o: `@` mentions of board cards. A card mention is only an inline context token
 * (`[KEY · title](t3-context://v1/card/card_<cardId>)`) with no typed record behind it, so the
 * draft store, contracts and send path carry it unchanged.
 */
import type { BoardCardId, ProjectIconColor, ProjectId } from "@t3tools/contracts";
import {
  formatComposerContextReference,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { cardIdFromMentionContextId as cardIdFromContextId } from "@t3tools/shared/t3oCardContext";

import { extendReplacementRangeForTrailingSpace, type ComposerTrigger } from "../../composer-logic";

export interface BoardCardMentionItem {
  readonly id: string;
  readonly type: "card";
  readonly cardId: BoardCardId;
  readonly key: string;
  readonly projectId: ProjectId;
  readonly accent: ProjectIconColor | null;
  /** The card title, shown in the menu's label slot. */
  readonly label: string;
  /** The project name. */
  readonly description: string;
}

export interface BoardCardMentionCandidate {
  readonly cardId: BoardCardId;
  readonly key: string;
  readonly title: string;
  readonly projectId: ProjectId;
}

const TOKEN_TITLE_MAX_CHARS = 60;
const TITLE_QUERY_MIN_CHARS = 3;
const BOARD_CARD_MENTION_LIMIT = 5;

/** Cut to `max` UTF-16 units with an ellipsis, never leaving half of a surrogate pair. */
export function cutBoardCardTitle(title: string, max: number): string {
  if (title.length <= max) return title;
  let end = max - 1;
  const last = title.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${title.slice(0, end).trimEnd()}…`;
}

export function boardCardMentionLabel(card: { key: string; title: string }): string {
  const cut = cutBoardCardTitle(card.title.replace(/\s+/g, " ").trim(), TOKEN_TITLE_MAX_CHARS);
  return cut.length > 0 ? `${card.key} · ${cut}` : card.key;
}

export function boardCardMentionToken(card: {
  cardId: string;
  key: string;
  title: string;
}): string {
  return formatComposerContextReference({
    kind: "card",
    contextId: toKindScopedComposerContextId("card", card.cardId),
    label: boardCardMentionLabel(card),
  });
}

/** Only the `card_<uuid>` form a card token carries; a hashed context id never names a card. */
export function cardIdFromMentionContextId(contextId: string): BoardCardId | null {
  return cardIdFromContextId(contextId) as BoardCardId | null;
}

/** The key a token's label starts with, for a chip whose card is archived or not on this board. */
export function boardCardKeyFromMentionLabel(label: string): string {
  return label.split(" · ")[0]!.trim() || label;
}

function keyNumber(key: string): number {
  const match = /(\d+)$/.exec(key);
  return match ? Number(match[1]) : 0;
}

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * Card matches for an `@` query, best first: an exact key or number, then a key prefix or
 * number prefix, then titles whose words start with every query word (3+ characters only).
 * Within a band the current project comes first, then the newest card.
 */
export function matchBoardCardMentions<C extends BoardCardMentionCandidate>(input: {
  readonly cards: ReadonlyArray<C>;
  readonly currentProjectId: ProjectId | null;
  readonly query: string;
  readonly limit?: number;
}): C[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  const isNumber = /^\d+$/.test(query);
  const queryWords = query.split(/\s+/).filter(Boolean);
  const matchTitles = query.length >= TITLE_QUERY_MIN_CHARS;
  const ranked: { card: C; band: number; number: number }[] = [];
  for (const card of input.cards) {
    const key = card.key.toLowerCase();
    const number = keyNumber(card.key);
    let band: number | null = null;
    if (key === query || (isNumber && String(number) === query)) band = 0;
    else if (key.startsWith(query) || (isNumber && String(number).startsWith(query))) band = 1;
    else if (matchTitles) {
      const words = titleWords(card.title);
      if (queryWords.every((word) => words.some((candidate) => candidate.startsWith(word)))) {
        band = 2;
      }
    }
    if (band !== null) ranked.push({ card, band, number });
  }
  ranked.sort(
    (a, b) =>
      a.band - b.band ||
      Number(b.card.projectId === input.currentProjectId) -
        Number(a.card.projectId === input.currentProjectId) ||
      b.number - a.number,
  );
  return ranked.slice(0, input.limit ?? BOARD_CARD_MENTION_LIMIT).map((entry) => entry.card);
}

/** Inserts the picked card's token over the `@` query; ChatComposer's other selections mirror this. */
export function t3oSelectCardItem(input: {
  readonly item: BoardCardMentionItem;
  readonly trigger: ComposerTrigger;
  readonly snapshot: { readonly value: string };
  readonly applyPromptReplacement: (
    rangeStart: number,
    rangeEnd: number,
    replacement: string,
    options: { expectedText: string },
  ) => boolean;
  readonly setComposerHighlightedItemId: (id: string | null) => void;
}): void {
  const { item, trigger, snapshot } = input;
  if (trigger.kind !== "path") return;
  const replacement = `${boardCardMentionToken({ cardId: item.cardId, key: item.key, title: item.label })} `;
  const rangeEnd = extendReplacementRangeForTrailingSpace(
    snapshot.value,
    trigger.rangeEnd,
    replacement,
  );
  const applied = input.applyPromptReplacement(trigger.rangeStart, rangeEnd, replacement, {
    expectedText: snapshot.value.slice(trigger.rangeStart, rangeEnd),
  });
  if (applied) input.setComposerHighlightedItemId(null);
}

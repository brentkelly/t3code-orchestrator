import type { BoardCardId, ProjectId } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  toComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardKeyFromMentionLabel,
  boardCardMentionLabel,
  boardCardMentionToken,
  cardIdFromMentionContextId,
  matchBoardCardMentions,
  t3oSelectCardItem,
  type BoardCardMentionItem,
} from "./boardCardMentions";

const here = "project-here" as ProjectId;
const there = "project-there" as ProjectId;
let seq = 0;
const card = (key: string, title: string, projectId: ProjectId = there) => ({
  cardId: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}` as BoardCardId,
  key,
  title,
  projectId,
});

const cards = [
  card("T3O-5", "Fix login flow"),
  card("T3O-58", "Review round one", here),
  card("T3O-580", "Logging overhaul"),
  card("T3O-12", "Board login banner", here),
  card("WEB-58", "Marketing page"),
  card("T3O-7", "Fixture data"),
];
const keys = (query: string, currentProjectId: ProjectId | null = here, limit?: number) =>
  matchBoardCardMentions({
    cards,
    currentProjectId,
    query,
    ...(limit === undefined ? {} : { limit }),
  }).map((c) => c.key);

describe("matchBoardCardMentions", () => {
  it("offers no cards for an empty query", () => {
    expect(keys("")).toEqual([]);
    expect(keys("  ")).toEqual([]);
  });

  it("matches a full key case-insensitively, exact first", () => {
    expect(keys("t3o-58")).toEqual(["T3O-58", "T3O-580"]);
    expect(keys("T3O-58")).toEqual(["T3O-58", "T3O-580"]);
  });

  it("matches a key prefix, current project first, then the newest", () => {
    expect(keys("t3o-5")).toEqual(["T3O-5", "T3O-58", "T3O-580"]);
    expect(keys("t3o", here)).toEqual(["T3O-58", "T3O-12", "T3O-580", "T3O-7", "T3O-5"]);
  });

  it("matches a bare number: exact numbers first, then number prefixes", () => {
    expect(keys("58")).toEqual(["T3O-58", "WEB-58", "T3O-580"]);
    expect(keys("58", null)).toEqual(["T3O-58", "WEB-58", "T3O-580"]);
    expect(keys("1")).toEqual(["T3O-12"]);
  });

  it("matches titles by word prefix only from three characters", () => {
    expect(keys("lo")).toEqual([]);
    expect(keys("log")).toEqual(["T3O-12", "T3O-580", "T3O-5"]);
    expect(keys("logi")).toEqual(["T3O-12", "T3O-5"]);
    expect(keys("ogin")).toEqual([]);
  });

  it("ranks key matches ahead of title matches", () => {
    const withTitle = [...cards, card("FIX-1", "t3o-58 follow-up")];
    expect(
      matchBoardCardMentions({ cards: withTitle, currentProjectId: null, query: "fix" }).map(
        (c) => c.key,
      ),
    ).toEqual(["FIX-1", "T3O-7", "T3O-5"]);
  });

  it("caps the list at five by default", () => {
    expect(keys("t3o")).toHaveLength(5);
    expect(keys("t3o", here, 2)).toEqual(["T3O-58", "T3O-12"]);
  });
});

describe("card mention token", () => {
  const cardId = "0b9a2c1e-4d5f-4a6b-8c7d-9e0f1a2b3c4d";

  it("labels with the key and the title cut to 60 characters", () => {
    expect(boardCardMentionLabel({ key: "T3O-58", title: "Review  round\n1" })).toBe(
      "T3O-58 · Review round 1",
    );
    const long = boardCardMentionLabel({ key: "T3O-1", title: "x".repeat(80) });
    expect(long).toBe(`T3O-1 · ${"x".repeat(59)}…`);
    // An emoji straddling the cut is dropped whole, not split into a lone surrogate.
    const emoji = boardCardMentionLabel({
      key: "T3O-1",
      title: `${"x".repeat(58)}🎉${"y".repeat(9)}`,
    });
    expect(emoji).toBe(`T3O-1 · ${"x".repeat(58)}…`);
  });

  it("round-trips the card id through the token", () => {
    const token = boardCardMentionToken({ cardId, key: "T3O-58", title: "Fix [login] flow" });
    expect(token).toBe(`[T3O-58 · Fix login flow](t3-context://v1/card/card_${cardId})`);
    const [reference] = collectComposerContextReferences(token);
    expect(reference?.kind).toBe("card");
    expect(cardIdFromMentionContextId(reference!.contextId)).toBe(cardId);
    expect(boardCardKeyFromMentionLabel(reference!.label)).toBe("T3O-58");
  });

  it("rejects context ids that do not carry a card uuid", () => {
    expect(cardIdFromMentionContextId(toComposerContextId(`card_${cardId}/extra`))).toBeNull();
    expect(cardIdFromMentionContextId(`thread_${cardId}`)).toBeNull();
    expect(cardIdFromMentionContextId("card_abc")).toBeNull();
  });
});

describe("t3oSelectCardItem", () => {
  const item: BoardCardMentionItem = {
    id: "card:x",
    type: "card",
    cardId: "0b9a2c1e-4d5f-4a6b-8c7d-9e0f1a2b3c4d" as BoardCardId,
    key: "T3O-58",
    projectId: here,
    accent: null,
    label: "Review",
    description: "T3o",
  };

  it("replaces the @ query and a following space with the token", () => {
    const calls: unknown[][] = [];
    let highlighted: string | null = "card:x";
    t3oSelectCardItem({
      item,
      trigger: { kind: "path", query: "T3O", rangeStart: 4, rangeEnd: 8 },
      snapshot: { value: "see @T3O now" },
      applyPromptReplacement: (...args) => {
        calls.push(args);
        return true;
      },
      setComposerHighlightedItemId: (id) => {
        highlighted = id;
      },
    });
    expect(calls).toEqual([
      [
        4,
        9,
        "[T3O-58 · Review](t3-context://v1/card/card_0b9a2c1e-4d5f-4a6b-8c7d-9e0f1a2b3c4d) ",
        { expectedText: "@T3O " },
      ],
    ]);
    expect(highlighted).toBeNull();
  });

  it("ignores a trigger that is not an @ query", () => {
    let called = false;
    t3oSelectCardItem({
      item,
      trigger: { kind: "skill", query: "x", rangeStart: 0, rangeEnd: 2 },
      snapshot: { value: "$x" },
      applyPromptReplacement: () => (called = true),
      setComposerHighlightedItemId: () => {},
    });
    expect(called).toBe(false);
  });
});

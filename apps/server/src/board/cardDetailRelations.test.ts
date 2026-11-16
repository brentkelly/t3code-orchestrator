/** Which board events wake an open card's detail subscription (T3O-108 S1). */
import {
  BoardCardId,
  type BoardCard,
  type BoardCardDetail,
  type BoardState,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  boardCardDependentRefs,
  boardCardDetailRelatedIds,
  boardCardDetailWakes,
} from "./cardDetailRelations.ts";
import type { BoardEvent } from "./projector.ts";

const id = BoardCardId.make;

const card = (
  cardId: string,
  cardNumber: number,
  fields: Partial<Pick<BoardCard, "dependsOn" | "parentCardId">> = {},
) =>
  ({
    id: id(cardId),
    key: `T-${cardNumber}`,
    cardNumber,
    title: cardId,
    stage: "backlog",
    archivedAt: null,
    dependsOn: [],
    parentCardId: null,
    ...fields,
  }) as unknown as BoardCard;

// a depends on dep; dependent depends on a; child's parent is a; a's parent is group,
// which depends on groupDep; unrelated touches none of them.
const board = {
  cards: [
    card("dependent", 5, { dependsOn: [id("a")] }),
    card("a", 1, { dependsOn: [id("dep")], parentCardId: id("group") }),
    card("dep", 2),
    card("child", 3, { parentCardId: id("a") }),
    card("group", 4, { dependsOn: [id("groupDep")] }),
    card("groupDep", 6),
    card("unrelated", 7),
    card("dependent0", 0, { dependsOn: [id("a")] }),
  ],
} as unknown as BoardState;

const event = (aggregateKind: string, aggregateId: string) =>
  ({ aggregateKind, aggregateId }) as unknown as BoardEvent;

describe("boardCardDetailWakes", () => {
  it("wakes for the card and every card its detail embeds, and not for others", () => {
    for (const related of ["a", "dep", "dependent", "child", "group", "groupDep"]) {
      assert.isTrue(boardCardDetailWakes(event("card", related), board, id("a"), null), related);
    }
    assert.isFalse(boardCardDetailWakes(event("card", "unrelated"), board, id("a"), null));
  });

  it("wakes for a card the last frame showed but the board no longer relates", () => {
    const lastSent = {
      card: { parentCardId: null },
      dependencies: [],
      dependents: [{ cardId: id("unrelated") }],
      children: [],
      groupDependencies: [],
    } as unknown as BoardCardDetail;
    assert.isTrue(boardCardDetailWakes(event("card", "unrelated"), board, id("a"), lastSent));
  });

  it("always wakes for an event that is not about a card", () => {
    for (const kind of ["label", "stage", "worker", "project"]) {
      assert.isTrue(boardCardDetailWakes(event(kind, "x"), board, id("a"), null), kind);
    }
  });

  it("stops an ancestor walk on a parent cycle", () => {
    const cyclic = {
      cards: [card("x", 1, { parentCardId: id("y") }), card("y", 2, { parentCardId: id("x") })],
    } as unknown as BoardState;
    assert.deepStrictEqual([...boardCardDetailRelatedIds(cyclic, id("x"), null)].sort(), [
      "x",
      "y",
    ]);
  });
});

describe("boardCardDependentRefs", () => {
  it("lists the cards depending on this one in card-number order", () => {
    assert.deepStrictEqual(
      boardCardDependentRefs(board, id("a")).map((ref) => ref.cardId),
      [id("dependent0"), id("dependent")],
    );
  });
});

/**
 * T3o column card (t3o-06, D7). The column/board view renders from
 * `BoardCardShell` ALONE and must never open a detail subscription.
 * `BoardCardContent` takes only a shell (plus the label catalogue index) —
 * no environment id, no card id, no atom — so it is structurally incapable of
 * subscribing, and `renderToStaticMarkup` needs no runtime to render it. That
 * is the payload-discipline line D7 draws, asserted here.
 */
import {
  BoardCardId,
  BoardStageId,
  ProjectId,
  makeBoardCardShell,
  type BoardCardShell,
  type BoardLabel,
  type BoardLabelId,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { BoardCardContent } from "./BoardCardItem";

function shell(stage: string, overrides?: Partial<BoardCardShell>): BoardCardShell {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3-9",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: "Render me from the shell",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...overrides,
  };
}

const emptyLabels = new Map<BoardLabelId, BoardLabel>();

describe("BoardCardContent (D7)", () => {
  it("renders the whole card from shell data with no environment or subscription", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("backlog")}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).toContain("T3-9");
    expect(html).toContain("Render me from the shell");
  });

  it("renders a review card's severity triple from shell fields alone", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("review", {
          severityCritical: 1,
          severityImprovement: 2,
          severityNitpick: 3,
        })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    // The severity triple's tooltip spells the three numbers out.
    expect(html).toContain("1 critical · 2 improvements · 3 nitpicks");
  });

  it("counts dependencies before the gate, and names the gate once it bites", () => {
    const early = renderToStaticMarkup(
      <BoardCardContent
        card={shell("backlog", { dependencyCount: 2 })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    // Backlog is before the D18 gate: a count, not the word "Blocked".
    expect(early).toContain("Depends on 2 cards");
    expect(early).not.toContain("Blocked");

    const gated = renderToStaticMarkup(
      <BoardCardContent
        card={shell("ready", { blocked: true, dependencyCount: 2 })}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(gated).toContain("Blocked");
    expect(gated).toContain("Blocked by 2 dependencies");
  });

  it("mutes a Done card", () => {
    const html = renderToStaticMarkup(
      <BoardCardContent
        card={shell("done")}
        labelsById={emptyLabels}
        queueSlot={undefined}
        selected={false}
      />,
    );
    expect(html).toContain("opacity-70");
  });
});

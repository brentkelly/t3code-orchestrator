import { BoardCardId, type BoardCardDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardDecisionFollowUp, boardDecisionLogView } from "./boardDecisionLog";

const decision = (question: string, flag: BoardCardDecision["flag"]): BoardCardDecision => ({
  decisionId: `d-${question}`,
  cardId: BoardCardId.make("card-1"),
  stepId: null,
  threadId: null,
  question,
  decision: `Chose ${question}`,
  reason: "Why not.",
  flag,
  decidedBy: "agent",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("boardDecisionLogView", () => {
  it("has no log without decisions", () => {
    expect(boardDecisionLogView({ decisions: [], autoPlanned: true, pastBuild: true })).toBeNull();
  });

  it("summarises only the flags present, and stays closed without unclear entries", () => {
    const view = boardDecisionLogView({
      decisions: [decision("a", "normal"), decision("b", "important")],
      autoPlanned: true,
      pastBuild: false,
    });
    expect(view?.count).toBe("2 decisions");
    expect(view?.flags).toBe("1 important");
    expect(view?.defaultOpen).toBe(false);
    expect(view?.canAct).toBe(false);
  });

  it("offers the follow-up actions only on an auto-planned card past Building", () => {
    const decisions = [decision("a", "unclear")];
    expect(boardDecisionLogView({ decisions, autoPlanned: true, pastBuild: true })?.canAct).toBe(
      true,
    );
    expect(boardDecisionLogView({ decisions, autoPlanned: false, pastBuild: true })?.canAct).toBe(
      false,
    );
    expect(boardDecisionLogView({ decisions, autoPlanned: false, pastBuild: true })?.flags).toBe(
      "1 unclear",
    );
  });
});

describe("boardDecisionFollowUp", () => {
  it("drafts a card for the first decision in reading order", () => {
    const view = boardDecisionLogView({
      decisions: [decision("Name it?", "normal"), decision("Ship behind a flag?", "unclear")],
      autoPlanned: true,
      pastBuild: true,
    });
    expect(boardDecisionFollowUp({ cardKey: "T3-9", rows: view?.rows ?? [] })).toEqual({
      title: "Follow-up to T3-9: Ship behind a flag",
      brief: 'T3-9 decided "Chose Ship behind a flag?" (Why not.). Revisit it.',
    });
  });
});

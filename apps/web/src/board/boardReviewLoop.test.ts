/**
 * The Review pane's loop derivation (t3o-16, D9): pure over a completions
 * array, mirroring `ReviewLoopExecutor`'s decision rules — so these tests pin
 * the walk to the same semantics the server executes: any findings run one
 * triage pass, only blocking findings run adjudication, and the loop check
 * (blocking AND rounds remaining) is what opens another round.
 */
import { BoardCardId, type BoardStepCompletion } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveBoardReviewLoop, hasBoardReviewSteps } from "./boardReviewLoop";

const cardId = BoardCardId.make("card-1");

const completion = (
  stepId: string,
  payload: unknown,
  outcome: BoardStepCompletion["outcome"] = "succeeded",
): BoardStepCompletion => ({
  cardId,
  stepId,
  outcome,
  summary: `did ${stepId}`,
  payload:
    payload === undefined ? null : typeof payload === "string" ? payload : JSON.stringify(payload),
  threadId: null,
  completedAt: "2026-08-20T00:00:00.000Z",
});

const finding = (severity: "critical" | "improvement" | "nitpick", id = "f1") => ({
  id,
  severity,
  file: "src/x.ts",
  line: 3,
  title: `${severity} thing`,
  detail: "",
});

const review = (findings: ReadonlyArray<ReturnType<typeof finding>>) => ({
  reviewedSha: "sha",
  findings,
});

describe("hasBoardReviewSteps", () => {
  it("sees only round-scoped review steps", () => {
    expect(hasBoardReviewSteps([completion("building", null)])).toBe(false);
    expect(hasBoardReviewSteps([completion("review@1", review([]))])).toBe(true);
  });
});

describe("deriveBoardReviewLoop", () => {
  it("with no completions, round 1's review is next", () => {
    const loop = deriveBoardReviewLoop([], 5);
    expect(loop.next).toEqual({ phase: "review", round: 1 });
    expect(loop.status).toBe("running");
    expect(loop.currentRound).toBe(1);
    expect(loop.rounds).toHaveLength(1);
    expect(loop.rounds[0]?.phases.map((p) => p.status)).toEqual(["running", "pending", "pending"]);
  });

  it("a clean review converges with triage and adjudication skipped", () => {
    const loop = deriveBoardReviewLoop([completion("review@1", review([]))], 5);
    expect(loop.status).toBe("converged");
    expect(loop.next).toBeNull();
    expect(loop.rounds[0]?.outcome).toBe("clean");
    expect(loop.rounds[0]?.phases.map((p) => p.status)).toEqual(["done", "skipped", "skipped"]);
  });

  it("a nitpick-only review runs triage next, then converges without adjudication", () => {
    const afterReview = deriveBoardReviewLoop(
      [completion("review@1", review([finding("nitpick")]))],
      5,
    );
    expect(afterReview.next).toEqual({ phase: "triage", round: 1 });
    expect(afterReview.rounds[0]?.phases.map((p) => p.status)).toEqual([
      "done",
      "running",
      "skipped",
    ]);

    const afterTriage = deriveBoardReviewLoop(
      [
        completion("review@1", review([finding("nitpick")])),
        completion("triage@1", {
          fixedSha: "sha2",
          dispositions: [{ findingId: "f1", action: "fixed", note: "" }],
        }),
      ],
      5,
    );
    expect(afterTriage.status).toBe("converged");
    expect(afterTriage.rounds[0]?.outcome).toBe("clean");
    expect(afterTriage.rounds[0]?.counts.fixed).toBe(1);
  });

  it("blocking findings run triage, adjudication, then the next round", () => {
    const roundOne = [
      completion("review@1", review([finding("critical")])),
      completion("triage@1", {
        fixedSha: "sha2",
        dispositions: [{ findingId: "f1", action: "fixed", note: "guarded" }],
      }),
      completion("adjudicate@1", {
        verdicts: [{ findingId: "f1", verdict: "fix-upheld", note: "" }],
      }),
    ];
    const loop = deriveBoardReviewLoop(roundOne, 5);
    expect(loop.next).toEqual({ phase: "review", round: 2 });
    expect(loop.currentRound).toBe(2);
    expect(loop.rounds).toHaveLength(2);
    expect(loop.rounds[0]?.outcome).toBe("changes-requested");
    expect(loop.rounds[0]?.findings[0]?.resolution).toBe("fixed");
    expect(loop.totals).toEqual({ raised: 1, fixed: 1, rejected: 0, open: 0, disputed: 0 });
  });

  it("a struck-down disposition reads disputed", () => {
    const loop = deriveBoardReviewLoop(
      [
        completion("review@1", review([finding("critical")])),
        completion("triage@1", {
          fixedSha: "sha2",
          dispositions: [{ findingId: "f1", action: "rejected", note: "not a bug" }],
        }),
        completion("adjudicate@1", {
          verdicts: [{ findingId: "f1", verdict: "rejection-unjustified", note: "it is a bug" }],
        }),
      ],
      5,
    );
    expect(loop.rounds[0]?.findings[0]?.resolution).toBe("disputed");
    expect(loop.totals.disputed).toBe(1);
  });

  it("exhausting the round cap ends the loop at the cap with findings open", () => {
    const loop = deriveBoardReviewLoop(
      [
        completion("review@1", review([finding("critical")])),
        completion("triage@1", { fixedSha: "s", dispositions: [] }),
        completion("adjudicate@1", { verdicts: [] }),
      ],
      1,
    );
    expect(loop.status).toBe("round-cap");
    expect(loop.next).toBeNull();
    expect(loop.totals.open).toBe(1);
  });

  it("a cap lowered below recorded rounds ends the loop, exactly as the executor does", () => {
    // The executor walks only the configured cap; recorded rounds beyond it
    // are history it will never re-enter. The derivation must agree — not
    // report a next phase the server will never run — while still rendering
    // the extra rounds.
    const loop = deriveBoardReviewLoop(
      [
        completion("review@1", review([finding("critical")])),
        completion("triage@1", { fixedSha: "s", dispositions: [] }),
        completion("adjudicate@1", { verdicts: [] }),
        completion("review@2", review([finding("critical", "f2")])),
      ],
      1,
    );
    expect(loop.status).toBe("round-cap");
    expect(loop.next).toBeNull();
    expect(loop.rounds).toHaveLength(2);
    expect(loop.maxRounds).toBe(2);
  });

  it("a malformed review payload reads unreadable, never as no findings", () => {
    const loop = deriveBoardReviewLoop([completion("review@1", "{not json")], 5);
    expect(loop.status).toBe("unreadable");
    expect(loop.rounds[0]?.outcome).toBe("unreadable");
    expect(loop.rounds[0]?.reviewMalformed).toBe(true);
  });

  // T3O-2: the pane is where the loss was visible — a round that ran to a
  // clean conclusion rendered as "Recorded a payload nothing can read", with
  // its findings, dispositions and verdicts all dropped, because the agent had
  // stringified the payload before handing it to the tool.
  it("t3o-2: reads a double-encoded payload as the round it wraps", () => {
    const loop = deriveBoardReviewLoop(
      [
        completion("review@1", JSON.stringify(JSON.stringify(review([finding("nitpick")])))),
        completion("triage@1", {
          fixedSha: "s",
          dispositions: [{ findingId: "f1", action: "fixed", note: "done" }],
        }),
      ],
      5,
    );
    expect(loop.status).toBe("converged");
    expect(loop.rounds[0]?.outcome).toBe("clean");
    expect(loop.rounds[0]?.reviewMalformed).toBe(false);
    expect(loop.rounds[0]?.findings.map((f) => f.resolution)).toEqual(["fixed"]);
  });

  it("ignores failed completions, exactly as the executor does", () => {
    const loop = deriveBoardReviewLoop([completion("review@1", review([]), "failed")], 5);
    expect(loop.next).toEqual({ phase: "review", round: 1 });
  });
});

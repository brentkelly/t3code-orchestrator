/**
 * T3o primary stage action (t3o-06, D18; t3o-15). The detail pane's forward
 * button is a human gate — and the build-role stage has none, because Building
 * -> Code review is board-driven, not a click. This pins that: every advance is
 * human-initiated, and no UI affordance auto-advances a card out of the build
 * role. Derived generically now from the user-defined stage list.
 */
import { BOARD_SEED_STAGE_IDS, BOARD_SEED_STAGES } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardStagePrimaryAction,
  boardStageSecondaryActions,
  isBoardStageManuallySelectable,
} from "./boardStageActions";

const stages = BOARD_SEED_STAGES;

describe("boardStagePrimaryAction", () => {
  it("moves a card to the next stage in order", () => {
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.backlog)).toEqual({
      kind: "move",
      label: "Move to Sprint",
      toStage: BOARD_SEED_STAGE_IDS.sprint,
      emphasised: false,
    });
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.sprint)).toEqual({
      kind: "move",
      label: "Move to Planning",
      toStage: BOARD_SEED_STAGE_IDS.planning,
      emphasised: false,
    });
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.planning)).toEqual({
      kind: "move",
      label: "Move to Ready",
      toStage: BOARD_SEED_STAGE_IDS.ready,
      emphasised: false,
    });
    // The gate into the build role — "Begin build" — is the crossing that must
    // never be automatic; it is a human click here, nothing more, and the one
    // emphasised action.
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.ready)).toEqual({
      kind: "move",
      label: "Begin build",
      toStage: BOARD_SEED_STAGE_IDS.building,
      emphasised: true,
    });
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.review)).toEqual({
      kind: "move",
      label: "Move to Ready for merge",
      toStage: BOARD_SEED_STAGE_IDS.merge,
      emphasised: false,
    });
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.merge)).toEqual({
      kind: "move",
      label: "Move to Done",
      toStage: BOARD_SEED_STAGE_IDS.done,
      emphasised: false,
    });
  });

  it("offers Merge in the merge role only while the pull request is still open", () => {
    // The blue button in the merge stage merges the PR; the card advancing to
    // Done is a consequence of the merge, not a separate gate the user clicks.
    expect(
      boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.merge, { pullRequestState: "open" }),
    ).toEqual({
      kind: "merge",
      label: "Merge",
      emphasised: true,
      disabled: false,
      disabledReason: null,
    });

    // Merged, closed, or no PR at all: there is nothing left to merge, so the
    // card falls back to the ordinary forward move rather than being stranded
    // short of Done. Merging on GitHub yourself must still leave a way onward.
    for (const state of ["merged", "closed", null] as const) {
      expect(
        boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.merge, { pullRequestState: state }),
      ).toEqual({
        kind: "move",
        label: "Move to Done",
        toStage: BOARD_SEED_STAGE_IDS.done,
        emphasised: false,
      });
    }

    // A card that never had a pull request behaves exactly as it did before
    // this button existed — no context at all is the same as no PR.
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.merge)).toEqual({
      kind: "move",
      label: "Move to Done",
      toStage: BOARD_SEED_STAGE_IDS.done,
      emphasised: false,
    });
  });

  it("names the pull request it would merge", () => {
    // A card can accumulate several pull requests over its life — worked on,
    // merged, dragged back out of Done, worked on again — so an unnumbered
    // "Merge" leaves the one irreversible click on the card ambiguous.
    expect(
      boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.merge, {
        pullRequestState: "open",
        pullRequestNumber: 301,
      }),
    ).toEqual({
      kind: "merge",
      label: "Merge PR #301",
      emphasised: true,
      disabled: false,
      disabledReason: null,
    });
  });

  it("disables Merge while a conflict-resolution step is running", () => {
    // The step is rewriting the branch the PR is open on, so merging mid-flight
    // would merge a half-resolved state. The button stays visible and says why.
    expect(
      boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.merge, {
        pullRequestState: "open",
        conflictStepRunning: true,
      }),
    ).toEqual({
      kind: "merge",
      label: "Merge",
      emphasised: true,
      disabled: true,
      disabledReason: "Resolving conflicts…",
    });
  });

  it("offers no Merge button outside the merge role, however open the PR is", () => {
    // A PR exists from the review stage onward, but merging is gated on the
    // card having reached the merge stage — mid-review the agent is still
    // posting to that PR.
    for (const stage of [BOARD_SEED_STAGE_IDS.review, BOARD_SEED_STAGE_IDS.ready]) {
      expect(boardStagePrimaryAction(stages, stage, { pullRequestState: "open" })?.kind).toBe(
        "move",
      );
    }
  });

  it("resolves the merge role on a stage row that predates it", () => {
    // Migration 023 backfills the role, but `effectiveBoardStageRole` is the
    // read-side fallback for a row (or a replayed event payload) still
    // carrying NULL — the button must not depend on how old the database is.
    const legacyStages = stages.map((stage) =>
      stage.stageId === BOARD_SEED_STAGE_IDS.merge ? { ...stage, role: null } : stage,
    );
    expect(
      boardStagePrimaryAction(legacyStages, BOARD_SEED_STAGE_IDS.merge, {
        pullRequestState: "open",
      })?.kind,
    ).toBe("merge");
  });

  it("offers NO forward button from the build role or the last stage", () => {
    // Building -> Code review is board-driven (build success), never a click —
    // a forward button here would be a D18 violation. Done is terminal.
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.building)).toBeNull();
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.done)).toBeNull();
  });

  it("offers the ordinary forward move from the build role once its step has settled", () => {
    // A human-in-the-loop build never auto-advances, and a failed one never
    // will either: the card sits in Building wearing a "Needs a human" chip
    // with nothing to press. `stepHeld` is that chip's own condition, so the
    // button appears exactly when the chip does — labelled and styled by the
    // generic rule, not special-cased (D5, D6).
    expect(
      boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.building, { stepHeld: true }),
    ).toEqual({
      kind: "move",
      label: "Move to Code review",
      toStage: BOARD_SEED_STAGE_IDS.review,
      emphasised: false,
    });
  });

  it("keeps the build role's forward button shut while its step is still running", () => {
    // The flag OPENS the gate; merely passing a context must not. A card
    // mid-build is being driven by the board and has nothing for a human to do.
    expect(
      boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.building, { stepHeld: false }),
    ).toBeNull();
    expect(boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.building, {})).toBeNull();
  });

  it("still offers nothing from the last stage, settled or not", () => {
    // Done has no next stage, so the ordinary rule refuses on its own — the
    // held exception must not invent an exit where the ladder ends.
    expect(
      boardStagePrimaryAction(stages, BOARD_SEED_STAGE_IDS.done, { stepHeld: true }),
    ).toBeNull();
  });

  it("changes nothing on a stage that was never gated", () => {
    // `stepHeld` exists to unblock the ONE stage that returns null
    // unconditionally. Everywhere else the ordinary move already applies and
    // the flag must not leak into it.
    for (const stage of stages) {
      if (stage.stageId === BOARD_SEED_STAGE_IDS.building) continue;
      expect(boardStagePrimaryAction(stages, stage.stageId, { stepHeld: true })).toEqual(
        boardStagePrimaryAction(stages, stage.stageId),
      );
    }
  });

  it("resolves the build role on a stage row that predates it", () => {
    // Same read-side fallback the merge role gets: a `board_stages` row seeded
    // before roles existed carries NULL, and a settled build on such a row must
    // still offer its way out rather than falling through to a stage-name
    // coincidence.
    const legacyStages = stages.map((stage) =>
      stage.stageId === BOARD_SEED_STAGE_IDS.building ? { ...stage, role: null } : stage,
    );
    expect(boardStagePrimaryAction(legacyStages, BOARD_SEED_STAGE_IDS.building)).toBeNull();
    expect(
      boardStagePrimaryAction(legacyStages, BOARD_SEED_STAGE_IDS.building, { stepHeld: true })
        ?.kind,
    ).toBe("move");
  });

  it("no primary action ever targets the build role except the explicit gate before it", () => {
    for (const stage of stages) {
      const action = boardStagePrimaryAction(stages, stage.stageId);
      if (action?.kind === "move" && action.toStage === BOARD_SEED_STAGE_IDS.building) {
        expect(stage.stageId).toBe(BOARD_SEED_STAGE_IDS.ready);
      }
    }
  });

  it("lets a human choose only the stages before the build role", () => {
    // Everything before the build role is a person's to set; the build role
    // onward is granted by the forward gate, a build result or a review verdict,
    // so the ladder must not offer them as a click.
    expect(
      stages
        .filter((stage) => isBoardStageManuallySelectable(stages, stage.stageId))
        .map((stage) => stage.stageId),
    ).toEqual([
      BOARD_SEED_STAGE_IDS.backlog,
      BOARD_SEED_STAGE_IDS.sprint,
      BOARD_SEED_STAGE_IDS.planning,
      BOARD_SEED_STAGE_IDS.ready,
    ]);
  });
});

/**
 * The caret beside the forward button (t3o-07, D8). The offer stands on a full
 * conjunction, so each test below falsifies exactly ONE clause: a caret that
 * appears under a condition it cannot honour is a button that silently does
 * nothing, which is the failure mode the whole feature replaces.
 */
describe("boardStageSecondaryActions (t3o-07, D8)", () => {
  const held = { stepHeld: true, hasBranch: true, blocked: false };

  it("offers the submit action on a held build card with a branch", () => {
    expect(boardStageSecondaryActions(stages, BOARD_SEED_STAGE_IDS.building, held)).toEqual([
      {
        kind: "submit-no-review",
        label: "Submit for merge — no review",
        detail: "Opens the PR as normal, straight to Ready for merge.",
      },
    ]);
  });

  it("offers nothing while the build is still running — there is no forward button either", () => {
    expect(
      boardStageSecondaryActions(stages, BOARD_SEED_STAGE_IDS.building, {
        ...held,
        stepHeld: false,
      }),
    ).toEqual([]);
  });

  it("offers nothing on a card with no branch — there is nothing to push", () => {
    expect(
      boardStageSecondaryActions(stages, BOARD_SEED_STAGE_IDS.building, {
        ...held,
        hasBranch: false,
      }),
    ).toEqual([]);
  });

  it("offers nothing on a blocked card — the dependency gate is not overridable", () => {
    expect(
      boardStageSecondaryActions(stages, BOARD_SEED_STAGE_IDS.building, {
        ...held,
        blocked: true,
      }),
    ).toEqual([]);
  });

  it("offers nothing when Building's next stage is not the review role", () => {
    // A pipeline that already routes Building somewhere else: "skip review" is
    // meaningless when review is not what comes next.
    const reordered = stages.filter((stage) => stage.stageId !== BOARD_SEED_STAGE_IDS.review);
    expect(boardStageSecondaryActions(reordered, BOARD_SEED_STAGE_IDS.building, held)).toEqual([]);
  });

  it("offers nothing when the board has no merge-role stage to route to", () => {
    const noMerge = stages.filter((stage) => stage.stageId !== BOARD_SEED_STAGE_IDS.merge);
    expect(boardStageSecondaryActions(noMerge, BOARD_SEED_STAGE_IDS.building, held)).toEqual([]);
  });

  it("offers nothing at any stage other than the build role", () => {
    for (const stage of stages) {
      if (stage.stageId === BOARD_SEED_STAGE_IDS.building) continue;
      expect(boardStageSecondaryActions(stages, stage.stageId, held)).toEqual([]);
    }
  });

  it("resolves the build role on a stage row that predates it", () => {
    // Same read-side fallback the primary action gets: a `board_stages` row
    // seeded before roles existed carries NULL.
    const legacyStages = stages.map((stage) =>
      stage.stageId === BOARD_SEED_STAGE_IDS.building ? { ...stage, role: null } : stage,
    );
    expect(boardStageSecondaryActions(legacyStages, BOARD_SEED_STAGE_IDS.building, held)).toEqual([
      {
        kind: "submit-no-review",
        label: "Submit for merge — no review",
        detail: "Opens the PR as normal, straight to Ready for merge.",
      },
    ]);
  });
});

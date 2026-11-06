/**
 * What a CI record does to the card and its pass rows (T3O-44). Pure: the
 * decider calls it for `board.card.record-ci` and folds the result into one
 * `board.card-ci-recorded` event.
 */
import {
  BOARD_SEED_STAGE_IDS,
  boardCardCiSteps,
  boardCiScriptDefinitions,
  boardCiShellFinding,
  isBoardCiStepFailure,
  type BoardCard,
  type BoardCardCi,
  type BoardCardCiRecordedPayload,
  type BoardCardRecordCiCommand,
  type BoardCiPassSettle,
} from "@t3tools/contracts";

export type BoardCiRecordResult =
  | { readonly ok: true; readonly payload: Omit<BoardCardCiRecordedPayload, "cardId" | "action"> }
  | { readonly ok: false; readonly refusal: string };

const refuse = (refusal: string): BoardCiRecordResult => ({ ok: false, refusal });

export function decideBoardCiRecord(
  card: BoardCard,
  command: BoardCardRecordCiCommand,
): BoardCiRecordResult {
  const at = command.createdAt;
  const action = command.action;
  const current = card.ci;
  const done = (
    next: Pick<BoardCard, "ci" | "ciLastOutcome">,
    rest: Partial<Omit<BoardCardCiRecordedPayload, "cardId" | "action" | "card">> = {},
  ): BoardCiRecordResult => ({
    ok: true,
    payload: {
      card: { ...card, ...next, updatedAt: at },
      started: rest.started ?? null,
      settled: rest.settled ?? [],
      activity: rest.activity ?? null,
    },
  });

  switch (action.kind) {
    case "start-pass": {
      if (card.stage !== BOARD_SEED_STAGE_IDS.ci) {
        return refuse(`Card '${card.key}' is not in CI, so no CI pass can start.`);
      }
      if (boardCiScriptDefinitions(action.steps).length === 0) {
        return refuse("A CI pass needs at least one step it can run.");
      }
      const settled: BoardCiPassSettle[] = [];
      let activity: BoardCardCiRecordedPayload["activity"] = null;
      if (current !== null && current.runId !== action.runId) {
        // Only a fix agent's re-run is fixed in place; a human restart while
        // fixing replaces the pass like any other.
        if (current.phase === "fixing" && action.fixThreadId !== null) {
          settled.push({
            runId: current.runId,
            outcome: "fixed-in-place",
            finishedAt: at,
            fixThreadId: action.fixThreadId,
          });
          activity = { kind: "card-ci-pass-finished", ciOutcome: "fixed-in-place" };
        } else if (current.phase !== "passed" && current.phase !== "held") {
          settled.push({ runId: current.runId, outcome: "interrupted", finishedAt: at });
        }
      }
      const steps = boardCiScriptDefinitions(action.steps).map((step) => ({
        name: step.name,
        command: step.command,
        timeoutMinutes: step.timeoutMinutes,
        ...(step.parallel === true ? { parallel: true } : {}),
        status: "pending" as const,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
        tail: "",
      }));
      const sameEntry = current !== null && current.entry === action.entry;
      const ci: BoardCardCi = {
        runId: action.runId,
        entry: action.entry,
        fixAttempts: sameEntry ? current.fixAttempts : 0,
        maxFixAttempts: action.maxFixAttempts,
        phase: action.queued ? "queued" : "running",
        steps: boardCardCiSteps(steps),
      };
      return done(
        { ci, ciLastOutcome: null },
        {
          started: {
            runId: action.runId,
            cardId: card.id,
            entry: action.entry,
            ordinal: action.ordinal,
            startedAt: at,
            finishedAt: null,
            outcome: null,
            steps,
            logDir: action.logDir,
            fixThreadId: null,
            snapshot: action.steps,
            configVersion: action.configVersion ?? null,
          },
          settled,
          activity,
        },
      );
    }

    case "step": {
      if (current === null || current.runId !== action.runId) {
        // A late report from a pass already superseded: its row still takes
        // the step, the card does not.
        return done({ ci: current, ciLastOutcome: card.ciLastOutcome });
      }
      if (action.index >= current.steps.length) {
        return refuse(`CI step ${action.index} does not exist on pass ${action.runId}.`);
      }
      const steps = current.steps.map((step, index) =>
        index === action.index ? boardCardCiSteps([action.step])[0]! : step,
      );
      return done({
        ci: {
          ...current,
          steps,
          phase: current.phase === "queued" ? "running" : current.phase,
        },
        ciLastOutcome: card.ciLastOutcome,
      });
    }

    case "finish-pass": {
      const live = current !== null && current.runId === action.runId;
      if (action.result === "passed") {
        if (!live) return refuse(`Pass ${action.runId} is not this card's current CI pass.`);
        return done(
          { ci: { ...current, phase: "passed" }, ciLastOutcome: null },
          {
            settled: [{ runId: action.runId, outcome: "passed", finishedAt: at }],
            activity: { kind: "card-ci-pass-finished", ciOutcome: "passed" },
          },
        );
      }
      if (action.result === "failed") {
        return done(
          { ci: current, ciLastOutcome: card.ciLastOutcome },
          { settled: [{ runId: action.runId, finishedAt: at }] },
        );
      }
      // Interrupted (the pass could not run) or cancelled (the card left CI or
      // was archived): the row is settled. A card still live in CI is held,
      // its unfinished steps cancelled, until a human restarts or skips it.
      const outcome = action.result;
      const held =
        live && card.stage === BOARD_SEED_STAGE_IDS.ci && card.archivedAt === null
          ? {
              ...current,
              phase: "held" as const,
              steps: current.steps.map((step) =>
                step.status === "running" || step.status === "pending"
                  ? { ...step, status: "cancelled" as const }
                  : step,
              ),
            }
          : null;
      return done(
        { ci: held, ciLastOutcome: card.ciLastOutcome },
        { settled: [{ runId: action.runId, outcome, finishedAt: at }] },
      );
    }

    case "begin-fix": {
      if (current === null || current.runId !== action.runId) {
        return refuse(`Pass ${action.runId} is not this card's current CI pass.`);
      }
      if (current.fixAttempts >= current.maxFixAttempts) {
        return refuse(`Card '${card.key}' has used all ${current.maxFixAttempts} CI fixes.`);
      }
      return done({
        ci: { ...current, phase: "fixing", fixAttempts: current.fixAttempts + 1 },
        ciLastOutcome: card.ciLastOutcome,
      });
    }

    case "send-back": {
      const failed =
        action.stepName ??
        current?.steps.find((step) => isBoardCiStepFailure(step.status))?.name ??
        null;
      const fixAttemptsUsed = current?.fixAttempts ?? 0;
      return done(
        {
          ci: null,
          ciLastOutcome: {
            kind: "sent-back",
            ...(failed === null ? {} : { stepName: failed }),
            fixAttemptsUsed,
            finding: boardCiShellFinding(action.finding),
            round: action.round,
          },
        },
        {
          settled:
            action.runId === null
              ? []
              : [
                  {
                    runId: action.runId,
                    outcome: "sent-back",
                    finishedAt: at,
                    ...(action.fixThreadId === null ? {} : { fixThreadId: action.fixThreadId }),
                  },
                ],
          activity: {
            kind: "card-ci-sent-back",
            ...(failed === null ? {} : { ciStepName: failed }),
            ciFixAttempts: fixAttemptsUsed,
          },
        },
      );
    }

    case "skip": {
      if (card.stage !== BOARD_SEED_STAGE_IDS.ci) {
        return refuse(`Card '${card.key}' is not in CI, so there is nothing to skip.`);
      }
      return done(
        { ci: null, ciLastOutcome: { kind: "skipped", actor: action.actor } },
        {
          settled:
            current === null || current.phase === "passed" || current.phase === "held"
              ? []
              : [{ runId: current.runId, outcome: "skipped", finishedAt: at }],
          activity: { kind: "card-ci-skipped" },
        },
      );
    }
  }
}

/**
 * Auto-archive of idle Done cards (T3O-77): an opt-in pass on the supervisor's
 * 30s tick that archives cards left untouched in Done for N days.
 *
 * Driven through the live reactor against the stateful engine double, so the
 * archive goes through the real decider. `it.effect` runs on the TestClock,
 * whose "now" is the epoch, so card ages are fixed relative to it; the tick is
 * the reactor's own `fireAutoArchives` hook.
 */
import { BOARD_SEED_STAGE_IDS, BoardCardId, type BoardCard } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import {
  codexStep,
  makeBoardCard,
  readyWorktree,
  settingsWith,
  withGovernor,
} from "./supervisorHarness.testkit.ts";

const EPOCH = "1970-01-01T00:00:00.000Z";
/** Eight days before the TestClock epoch: past the default seven. */
const EIGHT_DAYS_AGO = "1969-12-24T00:00:00.000Z";
/** Two days before it: not yet due. */
const TWO_DAYS_AGO = "1969-12-30T00:00:00.000Z";

const doneCard = (id: string, updatedAt: string, worktree: BoardCard["worktree"] = null) => ({
  ...makeBoardCard({ id, stage: BOARD_SEED_STAGE_IDS.done, orderKey: "m", worktree }),
  updatedAt,
});

const fixture = (cards: ReadonlyArray<BoardCard>, autoArchiveDone: boolean) => ({
  board: { cards, nextCardNumberByProject: {} },
  settings: settingsWith({
    building: [codexStep],
    globalMaxConcurrent: 3,
    autoArchiveDone,
  }),
});

const archivedAt = (cards: ReadonlyArray<BoardCard>, id: string) =>
  cards.find((card) => card.id === BoardCardId.make(id))?.archivedAt ?? null;

it.effect("archives a Done card idle past the window and leaves a fresh one", () =>
  withGovernor(
    fixture([doneCard("old", EIGHT_DAYS_AGO), doneCard("fresh", TWO_DAYS_AGO)], true),
    ({ reactor, board, commands }) =>
      Effect.gen(function* () {
        yield* reactor.fireAutoArchives;
        yield* reactor.drain;

        const cards = (yield* board).cards;
        assert.strictEqual(archivedAt(cards, "old"), EPOCH);
        assert.isNull(archivedAt(cards, "fresh"));
        const archives = (yield* commands).filter(
          (command) => command.type === "board.card.archive",
        );
        assert.deepStrictEqual(
          archives.map((command) => ("cardId" in command ? String(command.cardId) : null)),
          ["old"],
        );
      }),
  ),
);

it.effect("archives nothing while the setting is off", () =>
  withGovernor(fixture([doneCard("old", EIGHT_DAYS_AGO)], false), ({ reactor, board }) =>
    Effect.gen(function* () {
      yield* reactor.fireAutoArchives;
      yield* reactor.drain;
      assert.isNull(archivedAt((yield* board).cards, "old"));
    }),
  ),
);

it.effect("honours a configured window", () =>
  withGovernor(
    {
      ...fixture([doneCard("two-days", TWO_DAYS_AGO)], true),
      settings: settingsWith({
        building: [codexStep],
        globalMaxConcurrent: 3,
        autoArchiveDone: true,
        autoArchiveAfterDays: 1,
      }),
    },
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.fireAutoArchives;
        yield* reactor.drain;
        assert.strictEqual(archivedAt((yield* board).cards, "two-days"), EPOCH);
      }),
  ),
);

it.effect("keeps a Done card whose worktree reclaim was refused for unsaved work", () =>
  withGovernor(
    fixture(
      [
        doneCard("dirty", EIGHT_DAYS_AGO, {
          ...readyWorktree("dirty"),
          reclaimBlockedReason: "1 uncommitted change (a)",
        }),
      ],
      true,
    ),
    ({ reactor, board }) =>
      Effect.gen(function* () {
        yield* reactor.fireAutoArchives;
        yield* reactor.drain;
        assert.isNull(archivedAt((yield* board).cards, "dirty"));
      }),
  ),
);

it.effect("does not re-archive a card a human restored", () =>
  withGovernor(fixture([doneCard("old", EIGHT_DAYS_AGO)], true), ({ reactor, board, model }) =>
    Effect.gen(function* () {
      yield* reactor.fireAutoArchives;
      yield* reactor.drain;
      assert.strictEqual(archivedAt((yield* board).cards, "old"), EPOCH);

      // What the decider's unarchive does to the card: clears the archive and
      // bumps `updatedAt`, which restarts the clock.
      yield* Ref.update(model, (current) => ({
        board: {
          ...current.board!,
          cards: current.board!.cards.map((card) =>
            card.id === BoardCardId.make("old")
              ? { ...card, archivedAt: null, updatedAt: EPOCH }
              : card,
          ),
        },
      }));

      yield* reactor.fireAutoArchives;
      yield* reactor.drain;
      assert.isNull(archivedAt((yield* board).cards, "old"));
    }),
  ),
);

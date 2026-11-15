/** The card detail's activity tail keeps the latest plan-review marker (T3O-104). */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { BoardQueries } from "./BoardQueries.ts";
import { boardStackEngine, makeBoardStackTestLayer } from "./boardStack.testkit.ts";

const projectId = ProjectId.make("project-tail");
const cardId = BoardCardId.make("card-tail-1");
const minute = (n: number) =>
  `2026-01-01T${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}:00.000Z`;

it.layer(makeBoardStackTestLayer("t3o-board-plan-review-tail-"))("the activity tail", (it) => {
  it.effect("keeps a finished plan review after later rows push it past the limit", () =>
    Effect.gen(function* () {
      const engine = yield* boardStackEngine;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-tail-project"),
        projectId,
        title: "Tail project",
        workspaceRoot: `/tmp/${projectId}`,
        defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
        createdAt: minute(0),
      });
      yield* engine.dispatch({
        type: "board.card.create",
        commandId: CommandId.make("cmd-tail-card"),
        cardId,
        projectId,
        title: "Long stay in Planning",
        keyPrefix: "TL",
        stage: BoardStageId.make("planning"),
        createdAt: minute(0),
      });
      const sql = yield* SqlClient.SqlClient;
      const insert = (n: number, kind: string, payload: object = {}) => sql`
        INSERT INTO board_card_activity (
          activity_id, card_id, kind, payload, actor_kind, actor_name,
          actor_provider_instance_id, actor_thread_id, thread_id, created_at
        )
        VALUES (
          ${`activity-tail-${n}`}, ${cardId}, ${kind}, ${JSON.stringify(payload)}, 'system',
          NULL, NULL, NULL, NULL, ${minute(n)}
        )
      `;
      yield* insert(1, "plan-review-finished", { planReviewRounds: 3, planReviewFindings: 4 });
      for (let n = 2; n < 80; n++) yield* insert(n, "card-edited");

      const detail = yield* (yield* BoardQueries).boardCardDetail(cardId);
      const finished = detail!.activity.filter((entry) => entry.kind === "plan-review-finished");
      assert.strictEqual(finished.length, 1);
      assert.strictEqual(finished[0]!.payload.planReviewFindings, 4);
    }),
  );
});

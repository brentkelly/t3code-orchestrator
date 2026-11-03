/**
 * The decision log and ancestor context through the board tools (T3O-32):
 * `board_record_decisions`, `board_get_card_context.ancestors` nearest first,
 * `board_get_plan` reading an ancestor's plan, and `board_auto_plan`'s
 * approval gate.
 */
import {
  BoardCardId,
  boardPlanId,
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type BoardCard,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import {
  SupervisorReactor,
  type SupervisorReactorShape,
} from "../../../board/supervisorReactor.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  boardStackEngine,
  boardStackSnapshotQuery,
  makeBoardStackTestLayer,
} from "../../../board/boardStack.testkit.ts";
import { boardHandlers } from "./handlers.ts";

const t0 = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-decisions");
const rootId = BoardCardId.make("card-root");
const childThread = ThreadId.make("thread-child");
const otherId = BoardCardId.make("card-other");

const autoPlanCalls: Array<string> = [];
const SupervisorStub = Layer.succeed(SupervisorReactor, {
  autoPlanCard: (cardId) =>
    Effect.sync(() => {
      autoPlanCalls.push(String(cardId));
      return { outcome: "started" } as const;
    }),
} as Pick<SupervisorReactorShape, "autoPlanCard"> as SupervisorReactorShape);

const layer = makeBoardStackTestLayer("t3o-board-mcp-decisions-").pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(SupervisorStub),
);

const scope = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-1"),
  requestNamespace: "sess-1",
  thread: {
    threadId,
    providerSessionId: "sess-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["board"]),
  issuedAt: 0,
});

const asChild = Effect.provideService(
  McpInvocationContext.McpInvocationContext,
  scope(childThread),
);

const plan = (key: string) => ({
  key,
  title: `Plan ${key}`,
  summary: "s",
  dependsOn: [],
  body: `# ${key} body`,
});

const SPLIT_WHY = "The parts ship on separate branches and review one at a time.";

const decision = (question: string, flag: "normal" | "important" | "unclear") => ({
  question,
  decision: `Decided ${question}`,
  reason: "Because.",
  flag,
  decidedBy: "agent" as const,
});

/**
 * root → middle → leaf, each level cut from its parent's plan by an approved
 * split, with the root and middle each carrying decisions and the leaf linked
 * to `childThread`.
 */
const seedTree = Effect.fn("seedTree")(function* () {
  const engine = yield* boardStackEngine;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId,
    title: "Decisions",
    workspaceRoot: "/tmp/project-decisions",
    defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    createdAt: t0,
  });
  for (const [id, title] of [
    [rootId, "Root epic"],
    [otherId, "Unrelated"],
  ] as const) {
    yield* engine.dispatch({
      type: "board.card.create",
      commandId: CommandId.make(`cmd-create-${id}`),
      cardId: id,
      projectId,
      title,
      orderKey: "m",
      createdAt: t0,
    });
  }
  const snapshotQuery = yield* boardStackSnapshotQuery;
  const childrenOf = (parent: BoardCardId) =>
    snapshotQuery
      .getCommandReadModel()
      .pipe(
        Effect.map((model) =>
          (model.board?.cards ?? []).filter((card: BoardCard) => card.parentCardId === parent),
        ),
      );
  const split = (cardId: BoardCardId, keys: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "board.plans.propose",
        commandId: CommandId.make(`cmd-propose-${cardId}`),
        cardId,
        plans: keys.map(plan),
        splitRationale: SPLIT_WHY,
        createdAt: t0,
      });
      yield* engine.dispatch({
        type: "board.plans.approve",
        commandId: CommandId.make(`cmd-approve-${cardId}`),
        cardId,
        createdAt: t0,
      });
      return yield* childrenOf(cardId);
    });
  yield* engine.dispatch({
    type: "board.plans.propose",
    commandId: CommandId.make("cmd-propose-other"),
    cardId: otherId,
    plans: [plan("secret")],
    splitRationale: null,
    createdAt: t0,
  });
  const middle = (yield* split(rootId, ["mid", "side"])).find((card) => card.title === "Plan mid")!;
  const leaf = (yield* split(middle.id, ["leaf", "twin"])).find(
    (card) => card.title === "Plan leaf",
  )!;
  const record = (cardId: BoardCardId, decisions: ReadonlyArray<ReturnType<typeof decision>>) =>
    engine.dispatch({
      type: "board.card.record-decisions",
      commandId: CommandId.make(`cmd-decide-${cardId}`),
      cardId,
      decisions,
      stepId: "planning",
      threadId: null,
      createdAt: t0,
    });
  yield* record(rootId, [decision("root normal", "normal"), decision("root unclear", "unclear")]);
  yield* record(middle.id, [decision("middle important", "important")]);
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread"),
    threadId: childThread,
    projectId,
    title: "Leaf planning",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: t0,
  });
  yield* engine.dispatch({
    type: "board.card.link-thread",
    commandId: CommandId.make("cmd-link"),
    cardId: leaf.id,
    threadId: childThread,
    role: "planning",
    createdAt: t0,
  });
  return { middle, leaf };
});

it.layer(layer)("decision log and ancestor context (T3O-32)", (it) => {
  it.effect("hands a child planner its ancestors nearest first, with their decisions", () =>
    Effect.gen(function* () {
      const { middle, leaf } = yield* seedTree();
      const context = yield* boardHandlers.board_get_card_context().pipe(asChild);
      assert.strictEqual(context.card.id, leaf.id);
      assert.deepStrictEqual(
        context.ancestors.map((ancestor) => ancestor.cardId),
        [middle.id, rootId],
      );
      const [nearest, farthest] = context.ancestors;
      assert.deepStrictEqual(
        nearest?.plans.map((entry) => entry.title),
        ["Plan leaf", "Plan twin"],
      );
      assert.strictEqual(nearest?.brief, "# mid body");
      assert.deepStrictEqual(
        nearest?.decisions.map((entry) => entry.question),
        ["middle important"],
      );
      // Unclear first, so a child reads what most needs a second look.
      assert.deepStrictEqual(
        farthest?.decisions.map((entry) => entry.question),
        ["root unclear", "root normal"],
      );
      // The source plan is the brief word for word, so its body is not sent
      // twice.
      assert.strictEqual(context.sourcePlan?.plan.planId, boardPlanId(middle.id, "leaf"));
      assert.strictEqual(context.sourcePlan?.body, null);
    }),
  );

  it.effect("reads an ancestor's plan body, and refuses an unrelated card's", () =>
    Effect.gen(function* () {
      yield* seedTree();
      const got = yield* boardHandlers
        .board_get_plan({ planId: boardPlanId(rootId, "side") })
        .pipe(asChild);
      assert.strictEqual(got.body, "# side body");
      const refused = yield* boardHandlers
        .board_get_plan({ planId: boardPlanId(otherId, "secret") })
        .pipe(asChild, Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
    }),
  );

  it.effect("records the caller's decisions on its own card", () =>
    Effect.gen(function* () {
      yield* seedTree();
      const recorded = yield* boardHandlers
        .board_record_decisions({
          decisions: [decision("leaf normal", "normal"), decision("leaf unclear", "unclear")],
        })
        .pipe(asChild);
      assert.strictEqual(recorded.recorded, 2);
      const context = yield* boardHandlers.board_get_card_context().pipe(asChild);
      assert.deepStrictEqual(
        context.decisions.map((entry) => [entry.question, entry.flag, entry.threadId]),
        [
          ["leaf unclear", "unclear", childThread],
          ["leaf normal", "normal", childThread],
        ],
      );
    }),
  );

  it.effect("caps the card's own decisions in its context, flagged first", () =>
    Effect.gen(function* () {
      yield* seedTree();
      yield* boardHandlers
        .board_record_decisions({
          decisions: Array.from({ length: 40 }, (_, index) =>
            decision(`normal ${index}`, "normal"),
          ),
        })
        .pipe(asChild);
      yield* boardHandlers
        .board_record_decisions({ decisions: [decision("late unclear", "unclear")] })
        .pipe(asChild);
      const context = yield* boardHandlers.board_get_card_context().pipe(asChild);
      // The layer is shared, so earlier tests' decisions may sit on the card too.
      const questions = context.decisions.map((entry) => entry.question);
      assert.strictEqual(questions.length, 40);
      assert.include(questions, "late unclear");
      const firstNormal = context.decisions.findIndex((entry) => entry.flag === "normal");
      assert.isTrue(context.decisions.slice(firstNormal).every((entry) => entry.flag === "normal"));
      // Recorded order holds past ten entries in one batch ("evt:10" vs "evt:2").
      const batch = questions.filter((question) => question.startsWith("normal "));
      assert.deepStrictEqual(
        batch,
        Array.from({ length: batch.length }, (_, index) => `normal ${index}`),
      );
    }),
  );

  it.effect("board_auto_plan needs approved: true before it asks the supervisor", () =>
    Effect.gen(function* () {
      const { leaf } = yield* seedTree();
      autoPlanCalls.length = 0;
      const refused = yield* boardHandlers
        .board_auto_plan({ cardId: leaf.key })
        .pipe(asChild, Effect.exit);
      assert.isTrue(Exit.isFailure(refused));
      assert.deepStrictEqual(autoPlanCalls, []);
      const started = yield* boardHandlers
        .board_auto_plan({ cardId: leaf.key, approved: true })
        .pipe(asChild);
      assert.deepStrictEqual(started, { cardId: leaf.id, key: leaf.key, outcome: "started" });
      assert.deepStrictEqual(autoPlanCalls, [String(leaf.id)]);
    }),
  );
});

/**
 * T3o board MCP toolkit — handlers (t3o-08, D3/D8).
 *
 * Authorization lives here, not in capability gating (D3): the capability is
 * granted broadly, and each card-scoped tool resolves the calling `threadId`
 * to its card and rejects an unlinked caller with an actionable message.
 * Board-scoped tools take an explicit target and are the conversational
 * board-population path. Every write dispatches a board COMMAND through the
 * orchestration engine (D8) — MCP tool → command → decider → event →
 * projector → table, in one transaction — and never writes a table directly.
 */
import {
  boardAppendOrderKey,
  boardCardPlans,
  boardCardStepCompletions,
  boardLabelCatalogue,
  boardPlanId,
  BoardActivityId,
  BoardCardId,
  CommandId,
  EMPTY_BOARD_STATE,
  resolveBoardCardForThread,
  type BoardCardCreateCommand,
  type BoardCardCompleteStepCommand,
  type BoardCardMoveCommand,
  type BoardCardReportProgressCommand,
  type BoardCardRequestInputCommand,
  type BoardCardUpdateCommand,
  type BoardCard,
  type BoardLabelId,
  type BoardPlansProposeCommand,
  type BoardPlanWriteCommand,
  type BoardStage,
  type BoardState,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../../McpInvocationContext.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type { OrchestrationDispatchError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProjectionSnapshotQueryShape } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  boardSnapshotQueryMethodsOf,
  type BoardSnapshotQueryMethods,
} from "../../../board/projection.ts";
import { BoardToolError, BoardToolkit } from "./tools.ts";

const nonEmpty = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.trim().length > 0 ? value : fallback;

const internalError = (cause: { readonly message?: string }): BoardToolError =>
  new BoardToolError({ code: "internal", message: nonEmpty(cause.message, "Board tool failed.") });

/** Map a dispatch failure to an agent-facing tool error: an invariant
    rejection carries the decider's own actionable detail; anything else is an
    internal failure. */
const dispatchError = (error: OrchestrationDispatchError): BoardToolError =>
  error._tag === "OrchestrationCommandInvariantError" ||
  error._tag === "OrchestrationCommandPreviouslyRejectedError"
    ? new BoardToolError({ code: "rejected", message: nonEmpty(error.detail, "Command rejected.") })
    : internalError(error);

interface BoardToolDeps {
  readonly scope: McpInvocationScope;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly board: BoardSnapshotQueryMethods;
}

/** Resolve the services every board tool needs. `boardSnapshotQueryMethodsOf`
    returns null only when the snapshot query was assembled without the board
    factory (upstream test mocks); production always spreads it in. */
const boardToolDeps = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const engine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const board = boardSnapshotQueryMethodsOf(snapshotQuery);
  if (board === null) {
    return yield* new BoardToolError({
      code: "internal",
      message: "Board snapshot query methods are unavailable on this server.",
    });
  }
  return { scope, engine, snapshotQuery, board } satisfies BoardToolDeps;
});

const readBoardState = (deps: BoardToolDeps): Effect.Effect<BoardState, BoardToolError> =>
  deps.snapshotQuery.getCommandReadModel().pipe(
    Effect.map((model: OrchestrationReadModel) => model.board ?? EMPTY_BOARD_STATE),
    Effect.mapError(internalError),
  );

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** Mint a command id (server-dispatched board command, like ws.ts). Yields
    Crypto from context, so callers need only list it as a tool dependency. */
const mintCommandId: Effect.Effect<CommandId, never, Crypto.Crypto> = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.map((uuid) => CommandId.make(`mcp:board:${uuid}`)),
  Effect.orDie,
);

const mintUuid: Effect.Effect<string, never, Crypto.Crypto> = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.orDie,
);

/** The card the calling thread owns, or an actionable rejection telling the
    agent how to be adopted (D3: unlinked callers get more than a bare error). */
const requireCallerCard = (
  board: BoardState,
  scope: McpInvocationScope,
): Effect.Effect<BoardCard, BoardToolError> => {
  const card = resolveBoardCardForThread(board, scope.threadId);
  return card === null
    ? Effect.fail(
        new BoardToolError({
          code: "thread-not-linked",
          message:
            "This thread is not linked to a board card, so card-scoped tools cannot resolve your card. Ask a human to adopt this thread into a card (from the card's thread area), then retry.",
        }),
      )
    : Effect.succeed(card);
};

/** Resolve label NAMES against the live catalogue to ids; an unknown name is
    rejected with the live list (t3o-06a: tagging never creates labels). */
const resolveLabelIds = (
  board: BoardState,
  names: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<BoardLabelId>, BoardToolError> => {
  const live = boardLabelCatalogue(board).filter((label) => label.deletedAt === null);
  const ids: BoardLabelId[] = [];
  for (const name of names) {
    const match = live.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (match === undefined) {
      const catalogue = live.map((label) => label.name).join(", ") || "(none)";
      return Effect.fail(
        new BoardToolError({
          code: "unknown-label",
          message: `No label named '${name}'. Existing labels: ${catalogue}. Ask a human to create it — tagging does not create labels.`,
        }),
      );
    }
    ids.push(match.labelId);
  }
  return Effect.succeed(ids);
};

const dispatch = (
  engine: OrchestrationEngineShape,
  command: OrchestrationCommand,
): Effect.Effect<{ readonly sequence: number }, BoardToolError> =>
  engine.dispatch(command).pipe(Effect.mapError(dispatchError));

export const boardHandlers = {
  board_get_card_context: () =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = yield* requireCallerCard(board, deps.scope);
      const detail = yield* deps.board
        .boardCardDetail(card.id)
        .pipe(Effect.mapError(internalError));
      const activity = yield* deps.board
        .boardCardActivity(card.id)
        .pipe(Effect.mapError(internalError));
      const dependencies = card.dependsOn.map((dependencyId) => {
        const dependency = board.cards.find((candidate) => candidate.id === dependencyId);
        return {
          cardId: dependencyId,
          key: dependency?.key ?? dependencyId,
          title: dependency?.title ?? dependencyId,
          stage: dependency?.stage ?? ("backlog" as BoardStage),
          met: dependency?.stage === "done",
        };
      });
      return {
        card,
        brief: detail?.brief ?? null,
        dependencies,
        steps: boardCardStepCompletions(board, card.id),
        plans: boardCardPlans(board, card.id),
        activity,
      };
    }),

  board_report_progress: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = yield* requireCallerCard(board, deps.scope);
      const activityId = BoardActivityId.make(yield* mintUuid);
      const command: BoardCardReportProgressCommand = {
        type: "board.card.report-progress",
        commandId: yield* mintCommandId,
        cardId: card.id,
        activityId,
        note: input.note,
        threadId: deps.scope.threadId,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps.engine, command);
      return { activityId };
    }),

  board_request_input: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = yield* requireCallerCard(board, deps.scope);
      const activityId = BoardActivityId.make(yield* mintUuid);
      const command: BoardCardRequestInputCommand = {
        type: "board.card.request-input",
        commandId: yield* mintCommandId,
        cardId: card.id,
        activityId,
        question: input.question,
        threadId: deps.scope.threadId,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps.engine, command);
      return { activityId };
    }),

  board_complete_step: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = yield* requireCallerCard(board, deps.scope);
      // Idempotency is decided in the decider (re-emit the first outcome); the
      // pre-read here is only to tell the agent its retry was a no-op.
      const existing = boardCardStepCompletions(board, card.id).find(
        (completion) => completion.stepId === input.stepId,
      );
      // The agent's structured payload is stored verbatim as an opaque JSON
      // string (D8: carried through unread), so a schema codec would add
      // nothing over a plain stringify.
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const payload = input.payload === undefined ? null : JSON.stringify(input.payload);
      const command: BoardCardCompleteStepCommand = {
        type: "board.card.complete-step",
        commandId: yield* mintCommandId,
        cardId: card.id,
        stepId: input.stepId,
        outcome: input.outcome,
        summary: input.summary,
        payload,
        threadId: deps.scope.threadId,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps.engine, command);
      return {
        stepId: input.stepId,
        outcome: existing?.outcome ?? input.outcome,
        alreadyCompleted: existing !== undefined,
      };
    }),

  board_list_cards: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const text = input.text?.toLowerCase();
      const cards = board.cards
        .filter((card) => card.archivedAt === null)
        .filter((card) => input.projectId === undefined || card.projectId === input.projectId)
        .filter((card) => input.stage === undefined || card.stage === input.stage)
        .filter((card) => input.key === undefined || card.key === input.key)
        .filter((card) => text === undefined || card.title.toLowerCase().includes(text))
        .map((card) => ({
          cardId: card.id,
          key: card.key,
          projectId: card.projectId,
          title: card.title,
          stage: card.stage,
          blocked: card.blocked,
        }));
      return { cards };
    }),

  board_create_card: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const labels = yield* resolveLabelIds(board, input.labels ?? []);
      const stage = input.stage ?? ("backlog" as BoardStage);
      // `brief` and `dependsOn` ride a follow-up update (the create command
      // carries neither). Validate the ONE follow-up field that can be
      // rejected — a dependency that does not exist — BEFORE creating the
      // card, so a bad dependency never leaves a half-built card behind (and
      // a retry never mints a duplicate). A brand-new card has no dependents,
      // so its own dependencies can never close a cycle; existence is the
      // only check the follow-up update would fail on.
      const dependsOn = input.dependsOn ?? [];
      for (const dependencyId of dependsOn) {
        if (!board.cards.some((card) => card.id === dependencyId)) {
          return yield* new BoardToolError({
            code: "invalid-input",
            message: `Dependency '${dependencyId}' does not exist; create it (or drop it) before adding it as a dependency.`,
          });
        }
      }
      // Bottom of the target column, computed from the read model.
      const orderKey = boardAppendOrderKey(
        board.cards
          .filter((card) => card.projectId === input.projectId && card.stage === stage)
          .map((card) => card.orderKey),
      );
      const cardId = BoardCardId.make(yield* mintUuid);
      const create: BoardCardCreateCommand = {
        type: "board.card.create",
        commandId: yield* mintCommandId,
        cardId,
        projectId: input.projectId,
        title: input.title,
        labels,
        stage,
        orderKey,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps.engine, create);
      // brief and dependsOn are set through a follow-up update — the create
      // command carries neither.
      if (input.brief !== undefined || dependsOn.length > 0) {
        const update: BoardCardUpdateCommand = {
          type: "board.card.update",
          commandId: yield* mintCommandId,
          cardId,
          brief: input.brief,
          dependsOn: dependsOn.length > 0 ? dependsOn : undefined,
          createdAt: yield* nowIso,
        };
        yield* dispatch(deps.engine, update);
      }
      // Read back the allocated key.
      const after = yield* readBoardState(deps);
      const created = after.cards.find((card) => card.id === cardId);
      return { cardId, key: created?.key ?? cardId };
    }),

  board_move_card: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = board.cards.find((candidate) => candidate.id === input.cardId);
      // A bottom key in the target column, so a cross-stage move lands last.
      // When the card does not exist the move carries no order key and the
      // decider rejects it with an actionable "does not exist" message —
      // never a key computed against a phantom project.
      const orderKey =
        card === undefined
          ? undefined
          : boardAppendOrderKey(
              board.cards
                .filter(
                  (candidate) =>
                    candidate.projectId === card.projectId && candidate.stage === input.toStage,
                )
                .map((candidate) => candidate.orderKey),
            );
      const command: BoardCardMoveCommand = {
        type: "board.card.move",
        commandId: yield* mintCommandId,
        cardId: input.cardId,
        toStage: input.toStage,
        orderKey,
        override: input.override,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps.engine, command);
      return { cardId: input.cardId, stage: input.toStage };
    }),

  board_update_card: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const labels =
        input.labels === undefined ? undefined : yield* resolveLabelIds(board, input.labels);
      const command: BoardCardUpdateCommand = {
        type: "board.card.update",
        commandId: yield* mintCommandId,
        cardId: input.cardId,
        title: input.title,
        brief: input.brief,
        labels,
        dependsOn: input.dependsOn,
        externalRef: input.externalRef,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps.engine, command);
      return { cardId: input.cardId };
    }),

  board_propose_plans: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = yield* requireCallerCard(board, deps.scope);
      const command: BoardPlansProposeCommand = {
        type: "board.plans.propose",
        commandId: yield* mintCommandId,
        cardId: card.id,
        plans: input.plans,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps.engine, command);
      return { planIds: input.plans.map((plan) => boardPlanId(card.id, plan.key)) };
    }),

  board_get_plan: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = yield* requireCallerCard(board, deps.scope);
      const plan = boardCardPlans(board, card.id).find(
        (candidate) => candidate.planId === input.planId,
      );
      if (plan === undefined) {
        return yield* new BoardToolError({
          code: "plan-not-found",
          message: `No plan '${input.planId}' on your card.`,
        });
      }
      const body = yield* deps.board
        .boardPlanBody(input.planId)
        .pipe(Effect.mapError(internalError));
      return { plan, body: body ?? "" };
    }),

  board_write_plan: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = yield* requireCallerCard(board, deps.scope);
      const plan = boardCardPlans(board, card.id).find(
        (candidate) => candidate.planId === input.planId,
      );
      if (plan === undefined) {
        return yield* new BoardToolError({
          code: "plan-not-found",
          message: `No plan '${input.planId}' on your card.`,
        });
      }
      const command: BoardPlanWriteCommand = {
        type: "board.plan.write",
        commandId: yield* mintCommandId,
        cardId: card.id,
        planId: input.planId,
        body: input.body,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps.engine, command);
      return { planId: input.planId };
    }),
} satisfies Parameters<typeof BoardToolkit.toLayer>[0];

export const BoardToolkitHandlersLive = BoardToolkit.toLayer(boardHandlers);

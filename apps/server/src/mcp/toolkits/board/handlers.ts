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
  assignBoardKeyPrefix,
  boardAppendOrderKey,
  boardCardPlans,
  boardCardStepCompletions,
  boardCardStepState,
  boardLabelCatalogue,
  boardStepPayloadDefect,
  isBoardTerminalStepStatus,
  boardPlanId,
  BoardCardId,
  CommandId,
  EMPTY_BOARD_STATE,
  resolveBoardCardForThread,
  unwrapStringifiedBoardStepPayload,
  type BoardCardCreateCommand,
  type BoardCardCompleteStepCommand,
  type BoardCardMoveCommand,
  type BoardCardUpdateCommand,
  type BoardCard,
  type BoardLabelId,
  type BoardPlansProposeCommand,
  type BoardPlanWriteCommand,
  BOARD_SEED_STAGE_IDS,
  type BoardState,
  unmetBoardCardDependencies,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProjectId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

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
import * as ServerSettings from "../../../serverSettings.ts";
import * as ServerConfig from "../../../config.ts";
import { boardCardAttachmentManifest } from "../../../board/attachments.ts";
import { boardAgentActor, stampBoardActivityActor } from "../../../board/activityActors.ts";
import { BoardToolError, BoardToolkit } from "./tools.ts";

const nonEmpty = (value: string | undefined, fallback: string): string =>
  value !== undefined && value.trim().length > 0 ? value : fallback;

// Byte caps on what a completion writes into the event log / read model /
// every future detail frame (D8 discipline; matched to the contracts file's
// bounded-payload stance — label names 64 bytes, shell titles 200).
const BOARD_STEP_PAYLOAD_MAX_BYTES = 16_384;
const BOARD_STEP_SUMMARY_MAX_BYTES = 2_048;
const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).length;

/**
 * Fragments of a serialised tool CALL, which no hand-written summary contains
 * (T3O-14).
 *
 * A caller whose arguments were not parsed into distinct fields hands the tool
 * one giant `summary` with the rest of the call still marked up inside it, and
 * no `payload` at all — the CAA-5 `review@10` failure, where the summary ran
 * `…PR review.</summary>\n<parameter name="payload">{"reviewedSha":…`. The
 * board cannot fix the caller, but it can name what actually went wrong
 * instead of complaining about a summary length the agent never chose.
 *
 * Both markers are XML the harness emits around arguments; `</summary>` is
 * deliberately NOT one of them, because a summary quoting a `<details>` block
 * legitimately contains it, and a false positive here would block a completion
 * that is fine.
 */
const LEAKED_ARGUMENT_MARKERS = ["<parameter name=", "</parameter>"] as const;

const leaksSerialisedArguments = (summary: string): boolean =>
  LEAKED_ARGUMENT_MARKERS.some((marker) => summary.includes(marker));

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
  /** For the brief-attachment manifest's absolute paths (t3o-32). */
  readonly stateDir: string;
  readonly path: Path.Path;
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
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return {
    scope,
    engine,
    snapshotQuery,
    board,
    stateDir: config.stateDir,
    path,
  } satisfies BoardToolDeps;
});

const readBoardState = (deps: BoardToolDeps): Effect.Effect<BoardState, BoardToolError> =>
  deps.snapshotQuery.getCommandReadModel().pipe(
    Effect.map((model: OrchestrationReadModel) => model.board ?? EMPTY_BOARD_STATE),
    Effect.mapError(internalError),
  );

/**
 * The key prefix a new card should carry (D14). Board settings are the single
 * source: a project with a stored prefix keeps it, and a project with none is
 * assigned an acronym from its name and that choice is PERSISTED here — so an
 * agent-created card and a human-created card land in one key namespace, and
 * neither path can re-derive a different prefix after a rename.
 *
 * Takes the project title the caller already resolved from the read model; an
 * unknown project (never registered, or removed) passes an empty name, which
 * the contracts helper answers with the compiled-in default.
 */
const resolveCardKeyPrefix = (
  projectId: ProjectId,
  projectTitle: string,
): Effect.Effect<string, BoardToolError, ServerSettings.ServerSettingsService> =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const current = yield* settings.getSettings.pipe(Effect.mapError(internalError));
    const { prefix, assigned } = assignBoardKeyPrefix({
      board: current.board,
      projectId,
      projectTitle,
    });
    if (assigned) {
      yield* settings
        .updateSettings({
          board: {
            projects: {
              ...current.board.projects,
              [projectId]: {
                keyPrefix: prefix,
                accentColor: current.board.projects[projectId]?.accentColor ?? null,
                hidden: current.board.projects[projectId]?.hidden ?? false,
              },
            },
          },
        })
        .pipe(Effect.mapError(internalError));
    }
    return prefix;
  });

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

/**
 * Which step a completion applies to (t3o-19, D3).
 *
 * The board resolves the caller's own work so an agent never has to name a
 * step it was never told the id of — which is what every stage but the review
 * loop was silently relying on the stage line to leak.
 *
 * Three cases, in order:
 *
 * 1. The caller owns the card's LIVE step → that step. The thread match is the
 *    point: `resolveBoardCardForThread` resolves a card from ANY non-tombstoned
 *    link, so a sibling thread on the same card must not be able to settle a run
 *    it did not perform.
 * 2. The caller has a SETTLED completion of its own on this card → that step,
 *    which lands on the decider's idempotent path and re-returns the recorded
 *    outcome. The supervisor settles the run row the instant it sees the first
 *    completion (`handleStepCompleted`), so a retry almost always arrives after
 *    the step is terminal; without this case the omitted-`stepId` shape the tool
 *    now recommends would be LESS retry-safe than passing an id explicitly.
 * 3. Neither → reject. Nothing of the caller's is outstanding, and guessing
 *    would mean completing work it never did.
 *
 * An explicit `stepId` is passed through, but is still refused when it names the
 * live step of a DIFFERENT thread (same reasoning as case 1). Everything else
 * about it — an id for a step that never ran, an id belonging to another card —
 * the decider validates, exactly as before.
 */
const resolveCompletionStepId = (
  board: BoardState,
  card: BoardCard,
  scope: McpInvocationScope,
  stepId: string | undefined,
): Effect.Effect<string, BoardToolError> => {
  const state = boardCardStepState(board, card.id);
  const live = state !== null && !isBoardTerminalStepStatus(state.status) ? state : null;
  const ownCompletions = boardCardStepCompletions(board, card.id).filter(
    (completion) => completion.threadId === scope.threadId,
  );

  const candidate =
    stepId !== undefined
      ? stepId
      : live !== null && live.threadId === scope.threadId
        ? live.stepId
        : ownCompletions[ownCompletions.length - 1]?.stepId;

  if (candidate === undefined) {
    return Effect.fail(
      new BoardToolError({
        code: "invalid-input",
        message: `This thread has no work in progress on card '${card.key}', so there is nothing to complete. If your prompt gave you a stepId, pass it explicitly.`,
      }),
    );
  }

  // The guard runs on the RESOLVED id, whichever way it was resolved. Applying
  // it only to the explicit branch left the fallback open: step ids repeat
  // across stage entries, so a stale thread whose own recorded completion is
  // `building`/failed would resolve to `building` again — and if the card has
  // since re-entered Building under a NEW thread, the decider's supersede rule
  // (`existing.outcome !== "succeeded" && liveMatch`) would overwrite that
  // thread's live run with the stale thread's outcome.
  if (
    live !== null &&
    live.stepId === candidate &&
    live.threadId !== null &&
    live.threadId !== scope.threadId
  ) {
    return Effect.fail(
      new BoardToolError({
        code: "invalid-input",
        message: `Step '${candidate}' on card '${card.key}' is being run by another thread. Complete only the work you were assigned; omit stepId and the board will resolve yours.`,
      }),
    );
  }

  return Effect.succeed(candidate);
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

/** The non-deleted projects the caller can target, from the same command read
    model the tools already query. */
const listProjects = (
  deps: BoardToolDeps,
): Effect.Effect<ReadonlyArray<OrchestrationReadModel["projects"][number]>, BoardToolError> =>
  deps.snapshotQuery.getCommandReadModel().pipe(
    Effect.map((model) => model.projects.filter((project) => project.deletedAt === null)),
    Effect.mapError(internalError),
  );

/** The trailing path segment, so `~/projects/t3o-test` and
    `/home/ai1/projects/t3o-test` both compare as `t3o-test`. */
const workspaceBasename = (value: string): string => {
  const trimmed = value.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] ?? trimmed;
};

/** Available projects as `id — title`, the same "rejected with the live list"
    shape unknown labels use, so an agent that guessed wrong is handed the exact
    ids to retry with. */
const formatProjectList = (
  projects: ReadonlyArray<OrchestrationReadModel["projects"][number]>,
): string => projects.map((project) => `${project.id} — ${project.title}`).join("; ") || "(none)";

/**
 * Resolve the project a card should be created in (t3o: agents guess titles,
 * not ids). With no `projectId` the card lands in the calling thread's own
 * project — the common "cards for the project I'm in" case, resolved from the
 * read model via the scope's threadId (a thread's project never changes, so no
 * value has to be baked into the credential). With a `projectId` it is matched
 * as an id first, then leniently against a project's title (case-insensitive)
 * or workspace-root folder name, so a value copied from the app's dropdown
 * still resolves. Anything unresolvable is rejected with the live project list
 * rather than dispatched to fail deep in the decider with a bare "does not
 * exist".
 *
 * Pure over an already-fetched read model — board_create_card resolves it once
 * and reuses it for the board slice and the key prefix, so a single create does
 * not re-materialise the read model per lookup.
 */
const resolveProjectId = (
  model: OrchestrationReadModel,
  scope: McpInvocationScope,
  input: string | undefined,
): Effect.Effect<ProjectId, BoardToolError> =>
  Effect.gen(function* () {
    const projects = model.projects.filter((project) => project.deletedAt === null);
    if (input === undefined) {
      const thread = model.threads.find((candidate) => candidate.id === scope.threadId);
      const owned = thread
        ? projects.find((project) => project.id === thread.projectId)
        : undefined;
      if (owned !== undefined) {
        return owned.id;
      }
      // Either the thread has no project row, or its project was deleted — both
      // leave nothing to default to, so name the projects that CAN be targeted.
      return yield* new BoardToolError({
        code: "invalid-input",
        message: `No project given, and this thread has no active project to default to. Pass projectId (call board_list_projects for the ids). Available projects: ${formatProjectList(projects)}.`,
      });
    }
    const byId = projects.find((project) => project.id === input);
    if (byId !== undefined) {
      return byId.id;
    }
    const lowered = input.toLowerCase();
    const byTitle = projects.filter((project) => project.title.toLowerCase() === lowered);
    if (byTitle.length === 1) {
      return byTitle[0]!.id;
    }
    if (byTitle.length > 1) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message: `'${input}' matches more than one project by title. Pass an id instead. Matching projects: ${formatProjectList(byTitle)}.`,
      });
    }
    // Case-insensitive like the title match above — friendly to a guessed
    // folder name and correct on case-insensitive filesystems (macOS). Two
    // folders differing only in case fall through to the ambiguity branch
    // rather than silently mismatching.
    const inputBasename = workspaceBasename(input).toLowerCase();
    const byPath = projects.filter(
      (project) => workspaceBasename(project.workspaceRoot).toLowerCase() === inputBasename,
    );
    if (byPath.length === 1) {
      return byPath[0]!.id;
    }
    if (byPath.length > 1) {
      return yield* new BoardToolError({
        code: "invalid-input",
        message: `'${input}' matches more than one project by workspace folder. Pass an id instead. Matching projects: ${formatProjectList(byPath)}.`,
      });
    }
    return yield* new BoardToolError({
      code: "invalid-input",
      message: `No project matches '${input}' by id, title, or workspace folder. Available projects: ${formatProjectList(projects)}.`,
    });
  });

/**
 * Dispatch a board command from the MCP toolkit, stamping the AGENT actor first
 * (t3o-18, D11). This is one of the three dispatch boundaries that know who
 * called; the projector reads the stamp back off the event's `commandId` when it
 * writes an Activity row. The command schema is unchanged, and an agent cannot
 * misreport itself — the provider instance and thread come from the invocation
 * scope, not from tool input.
 */
const dispatch = (
  deps: BoardToolDeps,
  command: OrchestrationCommand,
): Effect.Effect<{ readonly sequence: number }, BoardToolError> => {
  stampBoardActivityActor(
    command.commandId,
    boardAgentActor({
      providerInstanceId: deps.scope.providerInstanceId,
      threadId: deps.scope.threadId,
    }),
  );
  return deps.engine.dispatch(command).pipe(Effect.mapError(dispatchError));
};

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
      // Per-thread todo summaries (t3o-18, D13): what a restarted agent — or a
      // second thread on the same card — actually wanted from the progress notes
      // this replaces.
      const threads = yield* deps.board
        .boardCardThreads(card.id)
        .pipe(Effect.mapError(internalError));
      // `met` uses the ONE shared gating rule (`unmetBoardCardDependencies`,
      // t3o-13 D1): done-role satisfies, and an ARCHIVED dependency stops
      // gating entirely — otherwise this response would tell an agent to wait
      // on a dependency the board's own `blocked` flag says is not gating.
      const unmet = new Set(
        unmetBoardCardDependencies({ board, dependsOn: card.dependsOn, cards: board.cards }),
      );
      const dependencies = card.dependsOn.map((dependencyId) => {
        const dependency = board.cards.find((candidate) => candidate.id === dependencyId);
        return {
          cardId: dependencyId,
          key: dependency?.key ?? dependencyId,
          title: dependency?.title ?? dependencyId,
          stage: dependency?.stage ?? BOARD_SEED_STAGE_IDS.backlog,
          met: !unmet.has(dependencyId),
        };
      });
      return {
        card,
        brief: detail?.brief ?? null,
        // Pull, not push (K3): every linked thread lists the brief's files
        // with a path it can read; added-later files show on the next call.
        attachments: boardCardAttachmentManifest({
          path: deps.path,
          stateDir: deps.stateDir,
          card,
        }),
        dependencies,
        steps: boardCardStepCompletions(board, card.id),
        currentStep: (() => {
          // The live step, the half of the orientation contract `steps` never
          // carried (t3o-19). A settled row is not "current": once the work is
          // terminal there is nothing assigned, and reporting it would invite
          // an agent to complete an id the decider will reject.
          const state = boardCardStepState(board, card.id);
          if (state === null || isBoardTerminalStepStatus(state.status)) return null;
          return {
            stepId: state.stepId,
            stepLabel: state.stepLabel,
            stageLabel: state.stageLabel,
            status: state.status,
            attempt: state.attempt,
          };
        })(),
        plans: boardCardPlans(board, card.id),
        activity,
        threads,
      };
    }),

  board_complete_step: (input) =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const board = yield* readBoardState(deps);
      const card = yield* requireCallerCard(board, deps.scope);
      // Resolve an omitted stepId to the caller's own live step (t3o-19, D3).
      // Only a stage that runs several steps ever tells an agent an id, so on
      // every other stage the agent has none to pass — and used to have to
      // infer one from the stage line in its preamble.
      //
      // Scoped to the CALLING THREAD, not just the card: if this card has
      // already advanced and started new work, the caller's thread is no
      // longer the live step's thread, so a late retry is rejected here
      // instead of silently completing the next stage's step. Resolving
      // server-side also makes the "pre-complete a future step" case the
      // decider guards against unreachable rather than merely rejected.
      const stepId = yield* resolveCompletionStepId(board, card, deps.scope, input.stepId);
      // Idempotency is decided in the decider (re-emit the first outcome); the
      // pre-read here is only to tell the agent its retry was a no-op.
      const existing = boardCardStepCompletions(board, card.id).find(
        (completion) => completion.stepId === stepId,
      );
      // ...except on the recovery-retry path, where it is NOT a no-op. The
      // decider supersedes a non-succeeded completion while the same step is
      // live again (that is how a nudged agent reports success after a failed
      // attempt), so mirroring its rule here keeps the reply from telling the
      // agent "already completed: failed" about a call the board just recorded
      // as succeeded.
      const liveState = boardCardStepState(board, card.id);
      const liveMatch =
        liveState !== null &&
        liveState.stepId === stepId &&
        !isBoardTerminalStepStatus(liveState.status);
      // The decider's own rule for "this call may record something": the step
      // is live, or it already has a completion to retry. Mirrored here only to
      // ORDER the errors — a call naming a step that is neither is rejected for
      // that, not lectured about a payload it was never entitled to record.
      const completable = existing !== undefined || liveMatch;
      const supersedes = existing !== undefined && existing.outcome !== "succeeded" && liveMatch;
      // The OTHER path where a retry is not a no-op: a `succeeded` record whose
      // payload nothing can read is repaired rather than re-emitted (T3O-14).
      // The decider decides it — this mirrors the rule so the reply does not
      // tell the agent "already completed" about a record it just replaced.
      // Conditional on validity in both directions: only a defective record is
      // repairable, and only a valid completion may repair it, which the
      // payload check further down enforces before anything is dispatched.
      const repairs =
        existing !== undefined &&
        existing.outcome === "succeeded" &&
        boardStepPayloadDefect({ stepId, payload: existing.payload }) !== null;
      // The agent's structured payload is stored verbatim as an opaque JSON
      // string (D8: carried through unread), so a schema codec would add
      // nothing over a plain stringify — except for the one thing a stringify
      // cannot see: an agent that already stringified the payload itself
      // (T3O-2). Storing THAT would wrap it twice and leave every reader
      // holding a JSON string where the schema wants an object, so one level
      // comes off first and storage stays canonical.
      const structured =
        input.payload === undefined ? undefined : unwrapStringifiedBoardStepPayload(input.payload);
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const payload = structured === undefined ? null : JSON.stringify(structured);
      // The payload never arrived as its own argument (T3O-14). Checked BEFORE
      // the caps, because this is exactly what the cap check used to misreport:
      // the summary carrying a whole payload IS over the summary cap, so the
      // agent was told to shorten its prose — advice that cannot fix a call
      // whose bytes are all in the wrong field — and once it trimmed enough to
      // fit, the board recorded the success with a null payload. Name the real
      // fault while it is still recoverable.
      if (completable && payload === null && leaksSerialisedArguments(input.summary)) {
        return yield* new BoardToolError({
          code: "invalid-input",
          message:
            "The summary contains serialised tool-call markup and no payload argument arrived, so the payload was folded into the summary rather than passed as its own field. Send the prose as `summary` and the structured result as the separate `payload` argument, then complete the step again.",
        });
      }
      // The completion enters the event log, the in-memory read model and every
      // subscribeCard detail frame for the card's lifetime (D8 discipline:
      // bodies never enter the read model) — one oversized call must not bloat
      // them permanently, so both sizes are capped with an actionable reject.
      // Each cap names the field that actually overflowed.
      if (payload !== null && utf8ByteLength(payload) > BOARD_STEP_PAYLOAD_MAX_BYTES) {
        return yield* new BoardToolError({
          code: "invalid-input",
          message: `The payload serialises to ${utf8ByteLength(payload)} bytes, over the ${BOARD_STEP_PAYLOAD_MAX_BYTES}-byte cap. Keep the structured payload small (ids, verdicts, findings) and put prose in the summary.`,
        });
      }
      if (utf8ByteLength(input.summary) > BOARD_STEP_SUMMARY_MAX_BYTES) {
        return yield* new BoardToolError({
          code: "invalid-input",
          // An oversized summary with no payload beside it is the leak's other
          // shape — the markers may be gone, but a summary this big on a call
          // that reported no structured result usually swallowed one.
          message: `The summary is ${utf8ByteLength(input.summary)} bytes, over the ${BOARD_STEP_SUMMARY_MAX_BYTES}-byte cap. Summarise in a few sentences; details belong in the payload.${payload === null ? " No payload argument arrived with it: if this summary contains one, resend it as the separate `payload` argument rather than shortening it away." : ""}`,
        });
      }
      // A step that must produce structured output may not record a success
      // that nothing can read (T3O-14). Refused HERE, before the command is
      // dispatched, because the decider would pin the record forever and the
      // review loop would halt `unreadable` with no way back. The agent gets
      // the shape it was asked for and the step stays live for its retry.
      if (completable && input.outcome === "succeeded") {
        const defect = boardStepPayloadDefect({ stepId, payload });
        if (defect !== null) {
          return yield* new BoardToolError({ code: "invalid-input", message: defect });
        }
      }
      const command: BoardCardCompleteStepCommand = {
        type: "board.card.complete-step",
        commandId: yield* mintCommandId,
        cardId: card.id,
        stepId,
        outcome: input.outcome,
        summary: input.summary,
        payload,
        threadId: deps.scope.threadId,
        createdAt: yield* nowIso,
      };
      yield* dispatch(deps, command);
      const replaced = supersedes || repairs;
      return {
        stepId,
        outcome: replaced ? input.outcome : (existing?.outcome ?? input.outcome),
        alreadyCompleted: existing !== undefined && !replaced,
      };
    }),

  board_list_projects: () =>
    Effect.gen(function* () {
      const deps = yield* boardToolDeps;
      const projects = yield* listProjects(deps);
      return {
        projects: projects.map((project) => ({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        })),
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
      // One read model for the whole create: project resolution, the board
      // slice, and the key-prefix title all read from it (the card's key is
      // read back with a fresh model after the write).
      const model = yield* deps.snapshotQuery
        .getCommandReadModel()
        .pipe(Effect.mapError(internalError));
      // Resolve the target project first (t3o: omitted → this thread's project;
      // a title or workspace folder → its id), so a card never dispatches
      // against a phantom project and an unresolvable target is rejected up
      // front with the live project list.
      const projectId = yield* resolveProjectId(model, deps.scope, input.projectId);
      const projectTitle = model.projects.find((project) => project.id === projectId)?.title ?? "";
      const board = model.board ?? EMPTY_BOARD_STATE;
      const labels = yield* resolveLabelIds(board, input.labels ?? []);
      const stage = input.stage ?? BOARD_SEED_STAGE_IDS.backlog;
      // Pre-validate dependencies for the friendlier tool-shaped message; the
      // decider re-checks existence inside the one atomic create below.
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
          .filter((card) => card.projectId === projectId && card.stage === stage)
          .map((card) => card.orderKey),
      );
      const cardId = BoardCardId.make(yield* mintUuid);
      // ONE atomic command: the create command carries `brief` and `dependsOn`
      // natively (t3o-06), so the card lands whole — no follow-up update whose
      // rejection or a mid-write crash could strand a half-built card while
      // the tool reports an error (inviting a retry that mints a duplicate).
      const create: BoardCardCreateCommand = {
        type: "board.card.create",
        commandId: yield* mintCommandId,
        cardId,
        projectId,
        title: input.title,
        ...(input.brief === undefined ? {} : { brief: input.brief }),
        ...(dependsOn.length > 0 ? { dependsOn } : {}),
        labels,
        stage,
        orderKey,
        keyPrefix: yield* resolveCardKeyPrefix(projectId, projectTitle),
        createdAt: yield* nowIso,
      };
      // Stamps the agent actor (t3o-18, D11) via the deps-aware dispatch.
      yield* dispatch(deps, create);
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
      yield* dispatch(deps, command);
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
      yield* dispatch(deps, command);
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
      yield* dispatch(deps, command);
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
      yield* dispatch(deps, command);
      return { planId: input.planId };
    }),
} satisfies Parameters<typeof BoardToolkit.toLayer>[0];

export const BoardToolkitHandlersLive = BoardToolkit.toLayer(boardHandlers);

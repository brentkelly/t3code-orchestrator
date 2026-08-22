/**
 * T3o board MCP toolkit — tool definitions (t3o-08, D3).
 *
 * The agent write path. An agent linked to a card resolves its own card from
 * the calling `threadId` (McpInvocationScope), so card-scoped tools take no
 * card id; board-scoped tools take an explicit target. Tools dispatch board
 * COMMANDS (D8) — they never touch projected tables directly.
 *
 * Tool descriptions are prompts, read by every model the board drives across
 * vendors with no shared conventions. Each states what the tool does, when to
 * call it, and what happens if it is not called — especially
 * `board_complete_step`, whose omission is indistinguishable from the agent
 * dying.
 *
 * They speak of STEPS only where steps exist (t3o-19, D1): every stage but the
 * review loop runs exactly one, so an agent there is told about its work, not
 * about a step it was never given an id for.
 */
import {
  BoardCard,
  BoardCardActivityEntry,
  BoardCardThreadShell,
  BoardCardExternalRef,
  BoardCardId,
  BoardPlan,
  BoardProposedPlanInput,
  BoardStageId,
  BoardStepCompletion,
  BoardStepOutcome,
  BoardStepStatus,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../../../serverSettings.ts";

/**
 * The single failure a board tool returns. `message` is the agent-facing,
 * actionable text — the decider's own invariant detail on a rejected write,
 * or an explicit "how to be adopted" note when an unlinked thread calls a
 * card-scoped tool. `code` lets a caller branch without parsing prose.
 */
export class BoardToolError extends Schema.TaggedErrorClass<BoardToolError>()("BoardToolError", {
  code: Schema.Literals([
    "thread-not-linked",
    "card-not-found",
    "unknown-label",
    "plan-not-found",
    "invalid-input",
    "rejected",
    "internal",
  ]),
  message: TrimmedNonEmptyString,
}) {}

// The board tools all resolve the same services: the calling scope, the engine
// (to dispatch), the board-wrapped snapshot query (to read), crypto (to mint
// command/entity ids) and board settings (the per-project key prefix, D14 —
// an agent-created card must land in the same key namespace as a human's).
// Declared uniformly, mirroring the preview toolkit.
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngineService,
  ProjectionSnapshotQuery,
  Crypto.Crypto,
  ServerSettings.ServerSettingsService,
];

// ── Read shapes ────────────────────────────────────────────────────────

const BoardCardContextDependency = Schema.Struct({
  cardId: BoardCardId,
  key: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  stage: BoardStageId,
  /** True when the dependency is Done (no longer blocking). */
  met: Schema.Boolean,
});

/** Everything an agent needs to orient on its card without further calls — the
    pull half of D5. */
const BoardCardContext = Schema.Struct({
  card: BoardCard,
  brief: Schema.NullOr(Schema.String),
  dependencies: Schema.Array(BoardCardContextDependency),
  /** Prior step completions on this card, in order. HISTORY ONLY — the work
      the caller is assigned right now is `currentStep` (t3o-19). */
  steps: Schema.Array(BoardStepCompletion),
  /** The work running on this card right now, or null when nothing is running
      (t3o-19). This is the half of the orientation contract that was missing:
      `steps` is history, so an agent had no way to learn what it was assigned
      and inferred its own step id from the stage line. `stepId` is what
      `board_complete_step` expects, and is only worth passing on a stage that
      HAS steps — `label` is null on every other stage. */
  currentStep: Schema.NullOr(
    Schema.Struct({
      stepId: TrimmedNonEmptyString,
      /** The step's label, or null when this stage has no steps. */
      label: Schema.NullOr(TrimmedNonEmptyString),
      /** The stage's label. */
      stageLabel: Schema.NullOr(TrimmedNonEmptyString),
      status: BoardStepStatus,
      attempt: Schema.Number,
    }),
  ),
  /** Proposed plans on this card, in order (metadata only; fetch a body with
      board_get_plan). */
  plans: Schema.Array(BoardPlan),
  /** The card's Activity rail (t3o-18, D10), chronological: a deterministic,
      actor-attributed projection of the board's own event log — created, moved,
      plans proposed, plan written, step completed, input requested, archived,
      unarchived, worktree failed. Structured, not prose. */
  activity: Schema.Array(BoardCardActivityEntry),
  /** Every live-linked thread on this card and its current todo list (t3o-18,
      D13) — what a restarted agent, or a SECOND thread on the same card,
      actually wanted from the deleted progress notes: not "what did you say you
      were doing", but "what is each thread on this card working through right
      now". */
  threads: Schema.Array(BoardCardThreadShell),
});

const BoardCardListItem = Schema.Struct({
  cardId: BoardCardId,
  key: TrimmedNonEmptyString,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  stage: BoardStageId,
  blocked: Schema.Boolean,
});

/** A project as an agent needs to identify it: the id to pass to
    board_create_card, plus the human-readable title and workspace root it sees
    in the app so it can map either one to the id. */
const BoardProjectListItem = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
});

// ── Card-scoped tools ──────────────────────────────────────────────────

/**
 * The parameter schema for a tool that takes no input.
 *
 * MCP requires every advertised tool's `inputSchema` to be a JSON Schema with
 * `"type": "object"`, and clients enforce it: Claude Code validates the whole
 * `tools/list` response and drops **every** tool on the server — preview
 * included — when one entry fails. `Schema.Struct({})` cannot be used here
 * because Effect serializes an empty struct as
 * `{"anyOf":[{"type":"object"},{"type":"array"}]}` (an empty struct admits
 * arrays too), which has no top-level `type`. A record with no admissible
 * values encodes the same "object with no properties" contract and serializes
 * to `{"type":"object","additionalProperties":false}`.
 */
const NoParameters = Schema.Record(Schema.String, Schema.Never);

export const BoardGetCardContextTool = Tool.make("board_get_card_context", {
  description:
    "Pull everything you need to work on your card: its title, brief, stage, dependency states, the work assigned right now, prior work and its outcomes, proposed plans, its recent activity, and the current todo list of every thread working on it. Activity is truncated to the most recent entries, so treat it as a tail, not the full history; the per-thread todo lists are how you pick up where you (or another thread on this card) left off. Call this first when you start work, and again whenever you need to re-orient. Your card is resolved from your thread — you never pass a card id. Fails if your thread is not linked to a card.",
  parameters: NoParameters,
  success: BoardCardContext,
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get board card context")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const BoardCompleteStepTool = Tool.make("board_complete_step", {
  description:
    "Report that your work on this stage is finished. THIS IS THE COMPLETION CONTRACT: the board considers the work done ONLY when you call this. If you finish your work but never call it, the board cannot tell you apart from an agent that crashed, and your work will be treated as failed and retried. Call it exactly once, at the very end, with outcome 'succeeded' when the work is done, 'blocked' when you need something you cannot get yourself, or 'failed' when you could not complete it; include a summary (max 2 KiB) and optional structured payload (max 16 KiB serialised). OMIT stepId: the board resolves the work you were assigned from your own thread. Pass one only if your prompt explicitly gave you a stepId — stages that run several steps, such as the code review loop, always do — and then pass exactly that string; any other value is rejected. Retry-safe: a repeat call with the same stepId re-returns a recorded 'succeeded' outcome unchanged; after a 'failed' or 'blocked' report, a later call on the live step records your new outcome (that is how a recovered retry reports success). Your card is resolved from your thread.",
  parameters: Schema.Struct({
    /** Omitted means "the live step of my thread" (t3o-19, D3). Only a stage
        that runs several steps states one, and only then is it passed back. */
    stepId: Schema.optional(TrimmedNonEmptyString),
    outcome: BoardStepOutcome,
    summary: TrimmedNonEmptyString,
    /** Optional structured result, stored verbatim. */
    payload: Schema.optional(Schema.Unknown),
  }),
  success: Schema.Struct({
    stepId: TrimmedNonEmptyString,
    outcome: BoardStepOutcome,
    /** True when this stepId was already completed and the first outcome was
        returned unchanged (an idempotent retry). */
    alreadyCompleted: Schema.Boolean,
  }),
  failure: BoardToolError,
  dependencies,
}).annotate(Tool.Title, "Complete board work");

// `board_report_progress` and `board_request_input` were DELETED by t3o-18
// (D13).
//
// The progress tool's own description told models to "call it often" — buying
// tokens for a log with no reader. The agent's narration is already durable in
// its transcript, and its INTENT is now on the card as the todo strip, observed
// from the `turn.plan.updated` every provider already emits. Nothing rendered
// progress notes, so nothing regresses.
//
// The input tool's description admitted its own gap: "you should still ask the
// same question through your normal question mechanism so your thread waits for
// the reply." An agent that asked normally and skipped the tool left the board
// blind — the actual failure mode. The supervisor now observes the runtime
// `user-input.requested` event instead, which fires for every input request.

// ── Board-scoped tools (explicit target) ───────────────────────────────

export const BoardListCardsTool = Tool.make("board_list_cards", {
  description:
    "List board cards, optionally filtered by project, stage, key, or a free-text match on the title. Use it to find a card id before creating a dependency or moving a card. Returns bounded summaries — fetch full context for one card with board_get_card_context (yours) or open it in the app.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    stage: Schema.optional(BoardStageId),
    key: Schema.optional(TrimmedNonEmptyString),
    text: Schema.optional(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ cards: Schema.Array(BoardCardListItem) }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "List board cards")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const BoardListProjectsTool = Tool.make("board_list_projects", {
  description:
    "List the projects on this server — each project's id, title, and workspace root. Call this to find the projectId to pass to board_create_card: the id is a UUID, NOT the title or folder name shown in the app, so never guess it from a name. Returns every non-deleted project.",
  parameters: NoParameters,
  success: Schema.Struct({ projects: Schema.Array(BoardProjectListItem) }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "List projects")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const BoardCreateCardTool = Tool.make("board_create_card", {
  description:
    "Create a new board card and return its allocated key. Use it to populate a board conversationally — e.g. one card per feature. Omit projectId to create the card in this thread's own project (the common case); pass one only to target a different project. A projectId is matched first as a project id, then leniently against a project's title or workspace-root folder name, so a name from the app usually resolves — but the id from board_list_projects is unambiguous. An unresolvable projectId is rejected with the live project list. A card may be created into ANY existing stage (omit stage for Backlog). CAUTION: creating into an auto-executing stage (e.g. Building) starts an unattended agent run immediately, with a worktree and a concurrency slot — default to the early stages unless a human asked for mid-pipeline work; the build-onward dependency gate still applies. NOT idempotent: a retried call creates a second card, so on a timeout list cards before retrying. Labels are named against the existing catalogue; an unknown label name is rejected with the live list rather than created. dependsOn lists card ids this card waits on.",
  parameters: Schema.Struct({
    projectId: Schema.optional(ProjectId),
    title: TrimmedNonEmptyString,
    brief: Schema.optional(TrimmedNonEmptyString),
    /** Label NAMES against the catalogue; unknown names are rejected. */
    labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    stage: Schema.optional(BoardStageId),
    dependsOn: Schema.optional(Schema.Array(BoardCardId)),
  }),
  success: Schema.Struct({ cardId: BoardCardId, key: TrimmedNonEmptyString }),
  failure: BoardToolError,
  dependencies,
}).annotate(Tool.Title, "Create board card");

export const BoardMoveCardTool = Tool.make("board_move_card", {
  description:
    "Move a card to another stage, subject to the same rules a human drag obeys: a blocked card (unmet dependencies) cannot cross into the build stage or beyond, and you have no privileged path around that. Set override to move to a non-adjacent stage (e.g. dragging backwards). CAUTION: the server does not require a human sign-off on forward moves — moving a card into an auto-executing stage starts an unattended agent run (worktree, concurrency slot). Use this for board tidying and explicitly requested moves, not to advance your own work; leave forward transitions to a human unless one asked you to make them.",
  parameters: Schema.Struct({
    cardId: BoardCardId,
    toStage: BoardStageId,
    override: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ cardId: BoardCardId, stage: BoardStageId }),
  failure: BoardToolError,
  dependencies,
}).annotate(Tool.Title, "Move board card");

export const BoardUpdateCardTool = Tool.make("board_update_card", {
  description:
    "Update a card's title, brief, labels, dependencies, or external reference. Only the fields you pass change; pass brief or externalRef as null to clear them. Labels are named against the catalogue (unknown names rejected) and replace the card's whole label set. dependsOn replaces the whole dependency set and is rejected if it would form a cycle.",
  parameters: Schema.Struct({
    cardId: BoardCardId,
    title: Schema.optional(TrimmedNonEmptyString),
    brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    dependsOn: Schema.optional(Schema.Array(BoardCardId)),
    externalRef: Schema.optional(Schema.NullOr(BoardCardExternalRef)),
  }),
  success: Schema.Struct({ cardId: BoardCardId }),
  failure: BoardToolError,
  dependencies,
}).annotate(Tool.Title, "Update board card");

// ── Plan tools ─────────────────────────────────────────────────────────

export const BoardProposePlansTool = Tool.make("board_propose_plans", {
  description:
    "Propose an ordered set of plans for your card (the planning output). Each plan has a key (a short unique slug), a title, a summary, a dependsOn list referencing other plans' keys, and a markdown body. The whole proposal is validated on ingest — unique keys, known dependency references, and no cycles — and rejected naming the offending edge, so a broken graph is caught now, not later. Proposing again replaces the card's whole plan set. Your card is resolved from your thread.",
  parameters: Schema.Struct({
    plans: Schema.Array(BoardProposedPlanInput),
  }),
  success: Schema.Struct({ planIds: Schema.Array(BoardPlan.fields.planId) }),
  failure: BoardToolError,
  dependencies,
}).annotate(Tool.Title, "Propose board plans");

export const BoardGetPlanTool = Tool.make("board_get_plan", {
  description:
    "Read one plan of your card — its metadata and full markdown body — by plan id (from board_get_card_context or board_propose_plans). Your card is resolved from your thread; a plan belonging to another card is not returned.",
  parameters: Schema.Struct({
    planId: BoardPlan.fields.planId,
  }),
  success: Schema.Struct({ plan: BoardPlan, body: Schema.String }),
  failure: BoardToolError,
  dependencies,
})
  .annotate(Tool.Title, "Get board plan")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const BoardWritePlanTool = Tool.make("board_write_plan", {
  description:
    "Replace the markdown body of one of your card's plans. Rejected once the plan is locked — locking happens when the plan is materialised to a file at build time, after which the file is the single source of truth and you edit it directly instead. Your card is resolved from your thread.",
  parameters: Schema.Struct({
    planId: BoardPlan.fields.planId,
    body: Schema.String,
  }),
  success: Schema.Struct({ planId: BoardPlan.fields.planId }),
  failure: BoardToolError,
  dependencies,
}).annotate(Tool.Title, "Write board plan");

export const BoardToolkit = Toolkit.make(
  BoardGetCardContextTool,
  BoardCompleteStepTool,
  BoardListProjectsTool,
  BoardListCardsTool,
  BoardCreateCardTool,
  BoardMoveCardTool,
  BoardUpdateCardTool,
  BoardProposePlansTool,
  BoardGetPlanTool,
  BoardWritePlanTool,
);

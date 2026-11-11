/**
 * T3o: a webhook scheduled task's board rule (T3O-78). Instead of running a prompt, a
 * delivery creates, moves or archives the card whose external reference it names.
 * `scheduledTask.ts` builds the schema from its own filter schema, so this file never
 * imports it at runtime.
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, type ProjectId } from "./baseSchemas.ts";
import {
  BoardLabelId,
  BoardStageId,
  boardProjectStagesInOrder,
  effectiveBoardStageRole,
  type BoardProjectStage,
  type BoardStageView,
} from "./board.ts";
import type { BoardWebhookAction, ScheduledTaskWebhookFilter } from "./scheduledTask.ts";

/** A board rule's required upstream `prompt`. It marks the task as a rule even if its
    action row is lost, so a delivery never falls through to launching a thread. */
export const BOARD_RULE_PROMPT =
  "This task is a board rule. Its deliveries create, move or archive board cards; it never runs a prompt.";

export const BOARD_WEBHOOK_RULES_MAX = 8;
export const BOARD_WEBHOOK_TITLE_MAX_CHARS = 200;
export const BOARD_WEBHOOK_BRIEF_MAX_CHARS = 20_000;

const BoardWebhookExternalRefTemplate = Schema.Struct({
  /** Matched exactly against a card's `externalRef.system`, such as `github-issue`. */
  system: TrimmedNonEmptyString,
  idTemplate: TrimmedNonEmptyString,
  urlTemplate: Schema.optional(TrimmedNonEmptyString),
});

export const BoardWebhookRuleAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    titleTemplate: TrimmedNonEmptyString,
    briefTemplate: Schema.optional(Schema.String),
    /** Absent lands in the project's first stage. */
    stage: Schema.optional(BoardStageId),
    labelIds: Schema.optional(Schema.Array(BoardLabelId)),
  }),
  Schema.Struct({ kind: Schema.Literal("move"), stage: BoardStageId }),
  Schema.Struct({
    kind: Schema.Literal("archive"),
    /** Absent is every stage before the plan-role stage. */
    onlyInStages: Schema.optional(Schema.Array(BoardStageId)),
  }),
]);
export type BoardWebhookRuleAction = typeof BoardWebhookRuleAction.Type;

/** The schema, over upstream's webhook filter schema. */
export const makeBoardWebhookActionSchema = <Filter extends Schema.Top>(filter: Filter) =>
  Schema.Struct({
    externalRef: BoardWebhookExternalRefTemplate,
    /** First match wins. A rule's filters are ANDed, as a task's are. */
    rules: Schema.Array(
      Schema.Struct({
        filters: Schema.Array(filter).check(Schema.isMaxLength(16)),
        action: BoardWebhookRuleAction,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(BOARD_WEBHOOK_RULES_MAX)),
  });

/**
 * The stages a webhook may create a card in or move it to, in the project's pipeline:
 * up to and including its plan-role stage and always before its build-role stage, so a
 * webhook can start planning but never a build. Worked out by role, never by stage id.
 */
export function boardWebhookStageSpan(
  board: BoardStageView,
  projectId: ProjectId,
): ReadonlyArray<BoardProjectStage> {
  const stages = boardProjectStagesInOrder(board, projectId).filter((stage) => !stage.retired);
  const planIndex = stages.findIndex((stage) => effectiveBoardStageRole(stage) === "plan");
  if (planIndex < 0) return [];
  const buildIndex = stages.findIndex((stage) => effectiveBoardStageRole(stage) === "build");
  const end = buildIndex < 0 ? planIndex + 1 : Math.min(planIndex + 1, buildIndex);
  return stages.slice(0, end);
}

/** Where an archive rule fires when it names no stages: before the plan-role stage. */
export function boardWebhookDefaultArchiveStages(
  board: BoardStageView,
  projectId: ProjectId,
): ReadonlyArray<BoardProjectStage> {
  return boardWebhookStageSpan(board, projectId).filter(
    (stage) => effectiveBoardStageRole(stage) !== "plan",
  );
}

export const GITHUB_ISSUE_DEFAULT_LABEL = "t3o";

/** The GitHub issue preset's task-level filter and replay key. */
export const githubIssueWebhookTaskFilters: ReadonlyArray<ScheduledTaskWebhookFilter> = [
  { path: "headers.x-github-event", op: "equals", value: "issues" },
];
export const GITHUB_ISSUE_REPLAY_KEY = "{{headers.x-github-delivery}}";
export const GITHUB_WEBHOOK_SIGNATURE = {
  header: "x-hub-signature-256",
  encoding: "hex",
  prefix: "sha256=",
} as const;

/**
 * The first use case: an issue carrying `label` becomes a card; closing, deleting or
 * transferring it, or removing the label, archives the card before work starts; and
 * reopening restores a card this rule archived.
 */
export function githubIssueBoardWebhookAction(
  label: string = GITHUB_ISSUE_DEFAULT_LABEL,
): BoardWebhookAction {
  return {
    externalRef: {
      system: "github-issue",
      idTemplate: "{{body.repository.full_name}}#{{body.issue.number}}",
      urlTemplate: "{{body.issue.html_url}}",
    },
    rules: [
      {
        filters: [{ path: "body.action", op: "in", value: ["closed", "deleted", "transferred"] }],
        action: { kind: "archive" },
      },
      {
        filters: [
          { path: "body.action", op: "equals", value: "unlabeled" },
          { path: "body.label.name", op: "equals", value: label },
        ],
        action: { kind: "archive" },
      },
      {
        filters: [
          { path: "body.action", op: "in", value: ["opened", "labeled", "reopened"] },
          { path: "body.issue.labels[].name", op: "equals", value: label },
          { path: "body.issue.state", op: "equals", value: "open" },
        ],
        action: {
          kind: "create",
          titleTemplate: "{{body.issue.title}}",
          briefTemplate: "GitHub issue: {{body.issue.html_url}}\n\n{{body.issue.body}}",
        },
      },
    ],
  };
}

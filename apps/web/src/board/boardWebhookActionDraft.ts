/**
 * T3o: the scheduled task form's board rule as editable text (T3O-78). A rule's filters
 * are one per line, `path op value`, and are checked with the same parser the task's own
 * filter rows use, so a draft that parses here also saves.
 */
import {
  BOARD_WEBHOOK_RULES_MAX,
  BoardLabelId,
  BoardStageId,
  type BoardWebhookAction,
  type BoardWebhookRuleAction,
  type ScheduledTaskWebhookFilter,
} from "@t3tools/contracts";
import {
  WEBHOOK_FILTER_OPS,
  parseWebhookFilterDrafts,
} from "@t3tools/client-runtime/scheduled-task-webhook";

export type BoardRuleKind = BoardWebhookRuleAction["kind"];

export interface BoardRuleDraft {
  readonly id: string;
  readonly kind: BoardRuleKind;
  readonly filters: string;
  readonly titleTemplate: string;
  readonly briefTemplate: string;
  /** Empty is the project's first stage for create; move needs one. */
  readonly stage: string;
  readonly labelIds: ReadonlyArray<string>;
  /** Empty is the default: every stage before planning. */
  readonly archiveStages: ReadonlyArray<string>;
}

export interface BoardWebhookActionDraft {
  readonly system: string;
  readonly idTemplate: string;
  readonly urlTemplate: string;
  readonly rules: ReadonlyArray<BoardRuleDraft>;
}

let lastRuleId = 0;
const nextRuleId = () => `board-rule-${++lastRuleId}`;

export function emptyBoardRuleDraft(kind: BoardRuleKind = "create"): BoardRuleDraft {
  return {
    id: nextRuleId(),
    kind,
    filters: "",
    titleTemplate: "",
    briefTemplate: "",
    stage: "",
    labelIds: [],
    archiveStages: [],
  };
}

export function formatWebhookFilterLines(filters: ReadonlyArray<ScheduledTaskWebhookFilter>) {
  return filters
    .map((filter) =>
      filter.op === "exists"
        ? `${filter.path} exists`
        : `${filter.path} ${filter.op} ${filter.op === "in" ? filter.value.join(", ") : filter.value}`,
    )
    .join("\n");
}

export function boardWebhookActionDraft(action: BoardWebhookAction): BoardWebhookActionDraft {
  return {
    system: action.externalRef.system,
    idTemplate: action.externalRef.idTemplate,
    urlTemplate: action.externalRef.urlTemplate ?? "",
    rules: action.rules.map((rule) => ({
      ...emptyBoardRuleDraft(rule.action.kind),
      filters: formatWebhookFilterLines(rule.filters),
      ...(rule.action.kind === "create"
        ? {
            titleTemplate: rule.action.titleTemplate,
            briefTemplate: rule.action.briefTemplate ?? "",
            stage: rule.action.stage ?? "",
            labelIds: rule.action.labelIds ?? [],
          }
        : rule.action.kind === "move"
          ? { stage: rule.action.stage }
          : { archiveStages: rule.action.onlyInStages ?? [] }),
    })),
  };
}

const KNOWN_OPS = new Set<string>(WEBHOOK_FILTER_OPS.map((option) => option.op));

function parseFilterLines(
  text: string,
): { readonly filters: ReadonlyArray<ScheduledTaskWebhookFilter> } | { readonly error: string } {
  const drafts = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const match = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    const op = match?.[2];
    if (match === null || op === undefined || !KNOWN_OPS.has(op)) {
      return {
        error: `Filter line ${index + 1} needs a path, an operator (${[...KNOWN_OPS].join(", ")}) and a value.`,
      };
    }
    drafts.push({
      id: `line-${index}`,
      path: match[1]!,
      op: op as ScheduledTaskWebhookFilter["op"],
      value: match[3] ?? "",
    });
  }
  return parseWebhookFilterDrafts(drafts);
}

/** The action to save, or the first problem a person must fix. */
export function parseBoardWebhookActionDraft(
  draft: BoardWebhookActionDraft,
): { readonly action: BoardWebhookAction } | { readonly error: string } {
  const system = draft.system.trim();
  const idTemplate = draft.idTemplate.trim();
  if (system === "" || idTemplate === "") {
    return { error: "A board rule needs a reference system and an id template." };
  }
  if (draft.rules.length === 0 || draft.rules.length > BOARD_WEBHOOK_RULES_MAX) {
    return { error: `Add between 1 and ${BOARD_WEBHOOK_RULES_MAX} rules.` };
  }
  const rules = [];
  for (const [index, rule] of draft.rules.entries()) {
    const named = `Rule ${index + 1}`;
    const parsed = parseFilterLines(rule.filters);
    if ("error" in parsed) return { error: `${named}: ${parsed.error}` };
    let action: BoardWebhookRuleAction;
    if (rule.kind === "create") {
      const titleTemplate = rule.titleTemplate.trim();
      if (titleTemplate === "") return { error: `${named} needs a title template.` };
      action = {
        kind: "create",
        titleTemplate,
        ...(rule.briefTemplate.trim() === "" ? {} : { briefTemplate: rule.briefTemplate }),
        ...(rule.stage === "" ? {} : { stage: BoardStageId.make(rule.stage) }),
        ...(rule.labelIds.length === 0
          ? {}
          : { labelIds: rule.labelIds.map((labelId) => BoardLabelId.make(labelId)) }),
      };
    } else if (rule.kind === "move") {
      if (rule.stage === "") return { error: `${named} needs a stage to move to.` };
      action = { kind: "move", stage: BoardStageId.make(rule.stage) };
    } else {
      action = {
        kind: "archive",
        ...(rule.archiveStages.length === 0
          ? {}
          : { onlyInStages: rule.archiveStages.map((stage) => BoardStageId.make(stage)) }),
      };
    }
    rules.push({ filters: parsed.filters, action });
  }
  const urlTemplate = draft.urlTemplate.trim();
  return {
    action: {
      externalRef: { system, idTemplate, ...(urlTemplate === "" ? {} : { urlTemplate }) },
      rules,
    },
  };
}

/**
 * T3o: the webhook task form's board rule block (T3O-78). "Board rule" makes each
 * delivery create, move or archive the card its reference names instead of running the
 * prompt; the GitHub issue preset fills the whole rule set and the task's own filter,
 * replay key and signature.
 */
import {
  BOARD_RULE_PROMPT,
  BOARD_SEED_STAGES,
  BOARD_WEBHOOK_RULES_MAX,
  GITHUB_ISSUE_DEFAULT_LABEL,
  GITHUB_ISSUE_REPLAY_KEY,
  GITHUB_WEBHOOK_SIGNATURE,
  boardWebhookStageSpan,
  githubIssueBoardWebhookAction,
  githubIssueWebhookTaskFilters,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { webhookFilterDrafts } from "@t3tools/client-runtime/scheduled-task-webhook";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import type { DraftState } from "../components/settings/scheduledTasksSettings.logic";
import { boardEnvironment } from "../state/board";
import {
  boardWebhookActionDraft,
  emptyBoardRuleDraft,
  type BoardRuleDraft,
  type BoardRuleKind,
  type BoardWebhookActionDraft,
} from "./boardWebhookActionDraft";

/** The task form fields a board rule sets: its sentinel prompt, and the preset's
    filter, replay key and signature. */
export type BoardRuleTaskPatch = Partial<
  Pick<
    DraftState,
    | "prompt"
    | "filters"
    | "replayKey"
    | "signatureEnabled"
    | "signatureHeader"
    | "signatureEncoding"
    | "signaturePrefix"
  >
>;

const FIRST_STAGE = "__first__";

const RULE_KINDS: ReadonlyArray<{ readonly kind: BoardRuleKind; readonly label: string }> = [
  { kind: "create", label: "Create a card" },
  { kind: "move", label: "Move the card" },
  { kind: "archive", label: "Archive the card" },
];

export function BoardWebhookActionFields({
  environmentId,
  projectId,
  value,
  onChange,
  onTaskPatch,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly value: BoardWebhookActionDraft | null;
  readonly onChange: (value: BoardWebhookActionDraft | null) => void;
  readonly onTaskPatch: (patch: BoardRuleTaskPatch) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>Action</Label>
        <ToggleGroup
          aria-label="Webhook action"
          value={[value === null ? "prompt" : "board"]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === "board" && value === null) {
              onChange({
                system: "",
                idTemplate: "",
                urlTemplate: "",
                rules: [emptyBoardRuleDraft()],
              });
              onTaskPatch({ prompt: BOARD_RULE_PROMPT });
            } else if (next === "prompt" && value !== null) {
              onChange(null);
              onTaskPatch({ prompt: "" });
            }
          }}
        >
          <Toggle value="prompt">Run a prompt</Toggle>
          <Toggle value="board">Board rule</Toggle>
        </ToggleGroup>
      </div>
      {value === null ? null : (
        <BoardRuleEditor
          environmentId={environmentId}
          projectId={projectId}
          value={value}
          onChange={onChange}
          onTaskPatch={onTaskPatch}
        />
      )}
    </div>
  );
}

function BoardRuleEditor({
  environmentId,
  projectId,
  value,
  onChange,
  onTaskPatch,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly value: BoardWebhookActionDraft;
  readonly onChange: (value: BoardWebhookActionDraft) => void;
  readonly onTaskPatch: (patch: BoardRuleTaskPatch) => void;
}) {
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const projectStageConfigs = useAtomValue(boardEnvironment.projectStageConfigsAtom(environmentId));
  const catalogue = useAtomValue(boardEnvironment.labelCatalogueAtom(environmentId));
  const [presetLabel, setPresetLabel] = useState(GITHUB_ISSUE_DEFAULT_LABEL);
  const span = boardWebhookStageSpan(
    {
      stages: stageList.length > 0 ? stageList : BOARD_SEED_STAGES,
      projectStageConfigs,
      cards: [],
    },
    projectId as ProjectId,
  );
  const labels = catalogue.filter((label) => label.deletedAt === null);
  const updateRule = (id: string, patch: Partial<BoardRuleDraft>) =>
    onChange({
      ...value,
      rules: value.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });

  const applyPreset = () => {
    const label = presetLabel.trim() || GITHUB_ISSUE_DEFAULT_LABEL;
    onChange(boardWebhookActionDraft(githubIssueBoardWebhookAction(label)));
    onTaskPatch({
      prompt: BOARD_RULE_PROMPT,
      filters: webhookFilterDrafts(githubIssueWebhookTaskFilters),
      replayKey: GITHUB_ISSUE_REPLAY_KEY,
      signatureEnabled: true,
      signatureHeader: GITHUB_WEBHOOK_SIGNATURE.header,
      signatureEncoding: GITHUB_WEBHOOK_SIGNATURE.encoding,
      signaturePrefix: GITHUB_WEBHOOK_SIGNATURE.prefix,
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Each request runs the first rule whose filters all match, against the card whose reference
        it names. Rules never start a build: they create cards and move them only up to planning,
        and archive only cards whose work has not started. The model and thread settings are not
        used. A board rule needs a signing secret.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid min-w-0 flex-1 grid-cols-1 space-y-1.5">
          <Label htmlFor="board-rule-preset-label">GitHub issue label</Label>
          <Input
            id="board-rule-preset-label"
            value={presetLabel}
            onChange={(event) => setPresetLabel(event.target.value)}
          />
        </div>
        <Button variant="outline" size="sm" onClick={applyPreset}>
          Use GitHub issue preset
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <TextField
          id="board-rule-system"
          label="Reference system"
          placeholder="github-issue"
          value={value.system}
          onChange={(system) => onChange({ ...value, system })}
        />
        <TextField
          id="board-rule-id"
          label="Reference id"
          placeholder="{{body.issue.number}}"
          value={value.idTemplate}
          onChange={(idTemplate) => onChange({ ...value, idTemplate })}
        />
        <TextField
          id="board-rule-url"
          label="Reference link"
          placeholder="{{body.issue.html_url}}"
          value={value.urlTemplate}
          onChange={(urlTemplate) => onChange({ ...value, urlTemplate })}
        />
      </div>
      {value.rules.map((rule, index) => (
        <div key={rule.id} className="space-y-3 rounded-md border border-border p-3">
          <div className="flex items-center gap-2">
            <Label className="flex-1">Rule {index + 1}</Label>
            <Select
              value={rule.kind}
              onValueChange={(kind) => {
                const known = RULE_KINDS.find((option) => option.kind === kind);
                if (known) updateRule(rule.id, { kind: known.kind, stage: "" });
              }}
            >
              <SelectTrigger size="sm" aria-label={`Rule ${index + 1} action`}>
                <SelectValue>
                  {RULE_KINDS.find((option) => option.kind === rule.kind)?.label}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {RULE_KINDS.map((option) => (
                  <SelectItem key={option.kind} value={option.kind}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove rule ${index + 1}`}
              disabled={value.rules.length === 1}
              onClick={() =>
                onChange({ ...value, rules: value.rules.filter((other) => other.id !== rule.id) })
              }
            >
              <Trash2Icon />
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${rule.id}-filters`}>Filters, one per line</Label>
            <Textarea
              id={`${rule.id}-filters`}
              placeholder="body.action in opened, reopened"
              value={rule.filters}
              onChange={(event) => updateRule(rule.id, { filters: event.target.value })}
            />
          </div>
          {rule.kind === "create" ? (
            <>
              <TextField
                id={`${rule.id}-title`}
                label="Card title"
                placeholder="{{body.issue.title}}"
                value={rule.titleTemplate}
                onChange={(titleTemplate) => updateRule(rule.id, { titleTemplate })}
              />
              <div className="space-y-1.5">
                <Label htmlFor={`${rule.id}-brief`}>Card brief</Label>
                <Textarea
                  id={`${rule.id}-brief`}
                  placeholder="{{body.issue.body}}"
                  value={rule.briefTemplate}
                  onChange={(event) => updateRule(rule.id, { briefTemplate: event.target.value })}
                />
              </div>
            </>
          ) : null}
          {rule.kind === "create" || rule.kind === "move" ? (
            <div className="space-y-1.5">
              <Label>{rule.kind === "create" ? "Create in" : "Move to"}</Label>
              <Select
                value={rule.stage === "" ? FIRST_STAGE : rule.stage}
                onValueChange={(stage) =>
                  updateRule(rule.id, {
                    stage: stage === FIRST_STAGE || stage === null ? "" : stage,
                  })
                }
              >
                <SelectTrigger size="sm" aria-label={`Rule ${index + 1} stage`}>
                  <SelectValue>
                    {rule.stage === ""
                      ? rule.kind === "create"
                        ? "First stage"
                        : "Pick a stage"
                      : (span.find((stage) => stage.stageId === rule.stage)?.label ?? rule.stage)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {rule.kind === "create" ? (
                    <SelectItem value={FIRST_STAGE}>First stage</SelectItem>
                  ) : null}
                  {span.map((stage) => (
                    <SelectItem key={stage.stageId} value={stage.stageId}>
                      {stage.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label>Only while the card is in</Label>
              <p className="text-xs text-muted-foreground">
                None checked: any stage before planning.
              </p>
              <div className="flex flex-wrap gap-3">
                {span.map((stage) => (
                  <label key={stage.stageId} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={rule.archiveStages.includes(stage.stageId)}
                      onCheckedChange={(checked) =>
                        updateRule(rule.id, {
                          archiveStages:
                            checked === true
                              ? [...rule.archiveStages, stage.stageId]
                              : rule.archiveStages.filter((other) => other !== stage.stageId),
                        })
                      }
                    />
                    {stage.label}
                  </label>
                ))}
              </div>
            </div>
          )}
          {rule.kind === "create" && labels.length > 0 ? (
            <div className="space-y-1.5">
              <Label>Labels</Label>
              <div className="flex flex-wrap gap-3">
                {labels.map((label) => (
                  <label key={label.labelId} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={rule.labelIds.includes(label.labelId)}
                      onCheckedChange={(checked) =>
                        updateRule(rule.id, {
                          labelIds:
                            checked === true
                              ? [...rule.labelIds, label.labelId]
                              : rule.labelIds.filter((other) => other !== label.labelId),
                        })
                      }
                    />
                    {label.name}
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        disabled={value.rules.length >= BOARD_WEBHOOK_RULES_MAX}
        onClick={() => onChange({ ...value, rules: [...value.rules, emptyBoardRuleDraft()] })}
      >
        <PlusIcon />
        Add rule
      </Button>
    </div>
  );
}

function TextField(props: {
  readonly id: string;
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={props.id}>{props.label}</Label>
      <Input
        id={props.id}
        placeholder={props.placeholder}
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * T3o: a project's Pipeline tab (T3O-49): every stage in board order with
 * its switch for this project and the settings this project overrides. Only
 * the switches and overrides are stored, so a stage added globally later
 * reaches this project with its default. Saves immediately.
 */
import {
  BOARD_CONFIG_VERSION_MISMATCH,
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  boardStageExecutionKind,
  boardStagesInOrder,
  resolveBoardStageExecution,
  type BoardStageDefinition,
  type BoardStageExecutionPatch,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { LockIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

import { NumberStepper } from "../../components/settings/BoardPipelineSection";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import { Textarea } from "../../components/ui/textarea";
import { cn } from "../../lib/utils";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { describeBoardCommandFailure } from "../boardCommandFeedback";
import { BoardHint } from "../BoardHint";
import { boardToast } from "../boardToast";
import { useBoardSettings } from "../useBoardEnvironmentId";
import {
  boardProjectOverrideEdit,
  boardProjectStageState,
  isBoardCiStage,
} from "./boardProjectSettings.logic";
import { useBoardSettingsContext } from "./BoardSettingsLayout";
import type { BoardProjectConfigState } from "./useBoardProjectConfig";

const report = (title: string) => (result: { readonly _tag: string }) => {
  if (result._tag !== "Failure") return;
  const description = describeBoardCommandFailure(result);
  boardToast({
    title: description.includes(BOARD_CONFIG_VERSION_MISMATCH)
      ? "Changed elsewhere, reload"
      : title,
    description,
    tone: "error",
  });
};

/** The settings a project may override, per stage kind. */
type OverrideField =
  | { readonly key: "autoExecute" | "autoMerge"; readonly kind: "boolean"; readonly label: string }
  | {
      readonly key: "rounds" | "maxFixAttempts";
      readonly kind: "number";
      readonly label: string;
      readonly min: number;
      readonly max: number;
    }
  | { readonly key: "prompt"; readonly kind: "text"; readonly label: string };

const PROMPT: OverrideField = { key: "prompt", kind: "text", label: "Prompt" };
const AUTO: OverrideField = { key: "autoExecute", kind: "boolean", label: "Auto execute" };

const FIELDS: Readonly<
  Record<ReturnType<typeof boardStageExecutionKind>, ReadonlyArray<OverrideField>>
> = {
  simple: [AUTO, PROMPT],
  build: [AUTO, PROMPT],
  review: [AUTO, { key: "rounds", kind: "number", label: "Rounds", min: 1, max: 20 }],
  merge: [{ key: "autoMerge", kind: "boolean", label: "Auto-merge" }],
  ci: [
    { key: "maxFixAttempts", kind: "number", label: "Fix attempts", min: 0, max: 10 },
    { ...PROMPT, label: "Fix prompt" },
  ],
};

export function BoardProjectPipelineTab(props: {
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly config: BoardProjectConfigState;
}) {
  const { environmentId, canWrite } = useBoardSettingsContext();
  const stageList = useAtomValue(boardEnvironment.stageListAtom(environmentId));
  const stages = boardStagesInOrder({
    stages: stageList.length > 0 ? stageList : BOARD_SEED_STAGES,
  });
  const setSwitch = useAtomCommand(boardEnvironment.setProjectStageSwitch, {
    reportFailure: false,
  });
  const setOverride = useAtomCommand(boardEnvironment.setProjectStageOverride, {
    reportFailure: false,
  });
  const [open, setOpen] = useState<string | null>(null);
  const { shell, full } = props.config;

  const onSwitch = (stage: BoardStageDefinition, on: boolean | null) =>
    void setSwitch({
      environmentId,
      input: { projectId: props.projectId, stageId: stage.stageId, on },
    }).then(report("Couldn't switch the stage"));

  const onOverride = (stage: BoardStageDefinition, key: string, value: unknown) => {
    const edit = boardProjectOverrideEdit(full, stage.stageId, key, value);
    if (edit === null) return;
    void setOverride({
      environmentId,
      input: { projectId: props.projectId, stageId: stage.stageId, ...edit },
    }).then(report("Couldn't save the override"));
  };

  return (
    <div className="mx-3 overflow-hidden rounded-xl border border-border bg-card shadow-xs sm:mx-4">
      {stages.map((stage, index) => (
        <StageRow
          canWrite={canWrite}
          expanded={open === stage.stageId}
          index={index}
          key={stage.stageId}
          onOverride={(key, value) => onOverride(stage, key, value)}
          onSwitch={(on) => onSwitch(stage, on)}
          onToggle={() => setOpen((current) => (current === stage.stageId ? null : stage.stageId))}
          projectId={props.projectId}
          overrides={(full ?? shell).overrides[stage.stageId] ?? {}}
          promptsLoaded={full !== null}
          projectTitle={props.projectTitle}
          stage={stage}
          stageSwitches={shell.stageSwitches}
          stages={stages}
        />
      ))}
    </div>
  );
}

function StageRow(props: {
  readonly projectId: ProjectId;
  readonly stage: BoardStageDefinition;
  readonly stages: ReadonlyArray<BoardStageDefinition>;
  readonly index: number;
  readonly stageSwitches: Readonly<Record<string, boolean>>;
  readonly overrides: BoardStageExecutionPatch;
  readonly promptsLoaded: boolean;
  readonly expanded: boolean;
  readonly canWrite: boolean;
  readonly projectTitle: string;
  readonly onToggle: () => void;
  readonly onSwitch: (on: boolean | null) => void;
  readonly onOverride: (key: string, value: unknown) => void;
}) {
  const { stage } = props;
  const board = useBoardSettings((settings) => settings.board);
  const state = boardProjectStageState({ stages: props.stages }, stage, props.stageSwitches);
  const global = resolveBoardStageExecution(board, stage.stageId) as unknown as Record<
    string,
    unknown
  >;
  const fields = FIELDS[boardStageExecutionKind(stage.stageId)];
  const overridden = fields.filter((field) => props.overrides[field.key] !== undefined).length;
  const isCi = isBoardCiStage(stage);
  const off = state.kind === "switchable" && !state.on;
  return (
    <div className="border-b border-border last:border-b-0">
      <div
        className="flex cursor-pointer items-center gap-2.5 px-4 py-2.5 hover:bg-muted"
        onClick={props.onToggle}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-accent font-mono text-[11px] font-semibold text-muted-foreground">
          {props.index + 1}
        </span>
        <span
          className={cn(
            "text-[13.5px] text-foreground",
            off && "text-muted-foreground line-through",
          )}
        >
          {stage.label}
        </span>
        {stage.projectId !== null ? (
          <span className="rounded-md bg-accent px-1.5 py-px text-[11px] text-muted-foreground">
            Made for a project
          </span>
        ) : null}
        {overridden > 0 ? (
          <span className="rounded-md border border-border px-1.5 py-px text-[11px] text-muted-foreground">
            {overridden} {overridden === 1 ? "override" : "overrides"}
          </span>
        ) : null}
        <span className="flex-1" />
        {state.kind === "always-on" ? (
          <BoardHint label={state.reason}>
            <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
              <LockIcon className="size-3" /> Always on
            </span>
          </BoardHint>
        ) : isCi ? (
          <span className="text-[11.5px] text-muted-foreground">
            {state.on ? "On here" : "Off"} · switch on the CI tab
          </span>
        ) : (
          <span className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
            <span className="text-[11.5px] text-muted-foreground">
              {state.switched
                ? state.on
                  ? "On here"
                  : "Off here"
                : state.defaultOn
                  ? "Default on"
                  : "Default off"}
            </span>
            <Switch
              aria-label={`${stage.label} for ${props.projectTitle}`}
              checked={state.on}
              disabled={!props.canWrite}
              onCheckedChange={(checked) =>
                props.onSwitch(checked === state.defaultOn ? null : checked)
              }
            />
          </span>
        )}
      </div>
      {props.expanded ? (
        <div className="flex flex-col gap-1 px-4 pb-3 sm:pl-[52px]">
          {state.kind === "always-on" ? (
            <p className="text-xs text-muted-foreground">{state.reason}</p>
          ) : off ? (
            <p className="text-xs text-muted-foreground">
              Off for {props.projectTitle}: its cards skip this stage. Cards already in it stay
              until they move on.
            </p>
          ) : null}
          {isCi ? (
            <Button
              className="mt-1 self-start"
              render={
                <Link
                  params={{ projectId: props.projectId, tab: "ci" }}
                  to="/settings/board/projects/$projectId/$tab"
                />
              }
              size="xs"
              variant="outline"
            >
              Edit steps and fix agent in the CI tab
            </Button>
          ) : (
            fields.map((field) => (
              <OverrideRow
                canWrite={props.canWrite && props.promptsLoaded}
                field={field}
                global={global[field.key]}
                key={field.key}
                loaded={field.kind !== "text" || props.promptsLoaded}
                onChange={(value) => props.onOverride(field.key, value)}
                value={props.overrides[field.key]}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function OverrideRow(props: {
  readonly field: OverrideField;
  readonly value: unknown;
  readonly global: unknown;
  readonly loaded: boolean;
  readonly canWrite: boolean;
  readonly onChange: (value: unknown) => void;
}) {
  const { field } = props;
  const overridden = props.value !== undefined;
  const shown = overridden ? props.value : props.global;
  const sameAsGlobal = overridden && JSON.stringify(props.value) === JSON.stringify(props.global);
  return (
    <div
      className={cn(
        "-ml-2.5 flex flex-col gap-2 border-l-2 py-2 pl-2.5",
        overridden ? "border-primary" : "border-transparent",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-[13.5px] text-foreground">{field.label}</span>
          <span
            className={cn(
              "text-[11.5px]",
              overridden ? "font-medium text-primary" : "text-muted-foreground",
            )}
          >
            {!overridden
              ? "Global"
              : sameAsGlobal
                ? "Same as global"
                : field.kind === "text"
                  ? "Overridden here"
                  : `Overridden here · global ${String(props.global)}`}
          </span>
        </div>
        {overridden && props.canWrite ? (
          <Button size="xs" variant="outline" onClick={() => props.onChange(undefined)}>
            <RotateCcwIcon className="size-3" /> Reset to global
          </Button>
        ) : null}
        {field.kind === "boolean" ? (
          <Switch
            aria-label={field.label}
            checked={shown === true}
            disabled={!props.canWrite}
            onCheckedChange={(checked) => props.onChange(checked)}
          />
        ) : field.kind === "number" ? (
          <NumberStepper
            ariaLabel={field.label}
            disabled={!props.canWrite}
            max={field.max}
            min={field.min}
            onChange={(value) => props.onChange(value)}
            value={typeof shown === "number" ? shown : field.min}
          />
        ) : null}
      </div>
      {field.kind === "text" ? (
        props.loaded ? (
          <PromptOverride
            canWrite={props.canWrite}
            onSave={(text) => props.onChange(text)}
            overridden={overridden}
            value={typeof shown === "string" ? shown : ""}
          />
        ) : (
          <span className="text-xs text-muted-foreground">Loading…</span>
        )
      ) : null}
    </div>
  );
}

function PromptOverride(props: {
  readonly value: string;
  readonly overridden: boolean;
  readonly canWrite: boolean;
  readonly onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  if (!props.overridden && draft === null) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          Uses the global prompt · {props.value.split(/\s+/).filter(Boolean).length} words
        </span>
        {props.canWrite ? (
          <Button size="xs" variant="outline" onClick={() => setDraft(props.value)}>
            Override for this project
          </Button>
        ) : null}
      </div>
    );
  }
  const text = draft ?? props.value;
  return (
    <div className="flex flex-col gap-1.5">
      <Textarea
        aria-label="Prompt override"
        className="min-h-24 font-mono text-xs"
        disabled={!props.canWrite}
        onChange={(event) => setDraft(event.target.value)}
        value={text}
      />
      {draft !== null ? (
        <div className="flex gap-2">
          <Button
            size="xs"
            disabled={draft.trim().length === 0}
            onClick={() => {
              props.onSave(draft);
              setDraft(null);
            }}
          >
            Save prompt
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
            Cancel
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The CI stage's fix-agent settings for one project, on its CI tab. */
export function BoardProjectCiFixAgent(props: {
  readonly projectId: ProjectId;
  readonly config: BoardProjectConfigState;
}) {
  const { environmentId, canWrite } = useBoardSettingsContext();
  const board = useBoardSettings((settings) => settings.board);
  const setOverride = useAtomCommand(boardEnvironment.setProjectStageOverride, {
    reportFailure: false,
  });
  const { shell, full } = props.config;
  const stageId = BOARD_SEED_STAGE_IDS.ci;
  const global = resolveBoardStageExecution(board, stageId) as unknown as Record<string, unknown>;
  const overrides: BoardStageExecutionPatch = (full ?? shell).overrides[stageId] ?? {};
  const onOverride = (key: string, value: unknown) => {
    const edit = boardProjectOverrideEdit(full, stageId, key, value);
    if (edit === null) return;
    void setOverride({
      environmentId,
      input: { projectId: props.projectId, stageId, ...edit },
    }).then(report("Couldn't save the override"));
  };
  return (
    <div className="flex flex-col rounded-xl border border-border bg-card px-4 pt-1 pb-2 shadow-xs">
      {FIELDS.ci.map((field) => (
        <OverrideRow
          canWrite={canWrite && full !== null}
          field={field}
          global={global[field.key]}
          key={field.key}
          loaded={field.kind !== "text" || full !== null}
          onChange={(value) => onOverride(field.key, value)}
          value={overrides[field.key]}
        />
      ))}
    </div>
  );
}

/**
 * Settings > Board > Pipeline: one accordion of stages. A stage body shows only
 * what its effective role leaves configurable, and each prompt renders inside
 * the same envelope the server composes at run time.
 */
import {
  BOARD_REVIEW_PHASE_IDS,
  BOARD_SUBMIT_STEP_ID,
  BOARD_SUBMIT_STEP_LABEL,
  DEFAULT_BOARD_SUBMIT_PROMPT,
  type BoardStepExecution,
  BOARD_REVIEW_PHASE_LABELS,
  BOARD_SEED_STAGES,
  BoardStageId,
  DEFAULT_BOARD_BUILD_PROMPT,
  DEFAULT_BOARD_PLANNING_PROMPT,
  DEFAULT_BOARD_PLAN_REVIEW_PROMPT,
  DEFAULT_BOARD_PLAN_REVIEW_ROUNDS,
  BOARD_PLAN_REVIEW_ROUNDS_MAX,
  BOARD_PLAN_REVIEW_ROUNDS_MIN,
  planReviewInstructionsClosing,
  planReviewInstructionsLead,
  type BoardPlanReviewSettings,
  DEFAULT_BOARD_REVIEW_PHASES,
  boardDraftPullRequestLine,
  boardReviewPhasePreamble,
  boardReviewPhaseProtocol,
  reviewStepId,
  reviewStepLabel,
  boardStagesInOrder,
  boardNewStageOrderKey,
  boardStageDefaultForProjects,
  boardStageOrderViolation,
  boardStageProjectCoverage,
  isBoardProjectHidden,
  AuthSettingsWriteScope,
  type BoardStageProjectCoverage,
  type ProjectId,
  boardCiFixPromptRules,
  boardStepPostamble,
  boardStepPreamble,
  effectiveBoardRuntimeMode,
  effectiveBoardStageRole,
  DEFAULT_BOARD_MERGE_CONFLICT_PROMPT,
  BOARD_SEED_STAGE_IDS,
  DEFAULT_BOARD_CI_FIX_PROMPT,
  isBoardBuildStageExecution,
  isBoardCiStageExecution,
  isBoardMergeStageExecution,
  isBoardReviewStageExecution,
  resolveBoardStageExecution,
  type BoardReviewPhaseExecution,
  type BoardReviewPhaseId,
  type BoardStageDefinition,
  type BoardStageExecution,
  type BoardStageExecutionCi,
  type BoardStageExecutionMerge,
  type BoardStageExecutionReview,
  type BoardStageRole,
  type BoardState,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  GripVerticalIcon,
  LockIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { boardEnvironment } from "../../state/board";
import { environmentShell } from "../../state/shell";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentScope } from "../../state/session";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { BOARD_ROLE_STAGE_NOTE } from "../../board/settings/boardProjectSettings.logic";
import { boardWorkerOnlyProviders } from "../../board/workers/cardWorker";
import { useBoardWorkersCardView } from "../../board/workers/BoardWorkersContext";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  ModelRow,
  type ActiveModel,
  type InstanceEntries,
  type ModelOptionsByInstance,
} from "./BoardModelRow";
import { boardModelDisplayName } from "./boardModelDisplayName";
import { cn, randomUUID } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  BOARD_STEP_MAX_ATTEMPTS_MAX,
  BOARD_STEP_TIMEOUT_MIN_MINUTES,
  minutesToMs,
  msToMinutes,
  parsePositiveIntInput,
  setBoardStageExecution,
} from "./BoardSettingsPanel.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";
import { BoardHint } from "../../board/BoardHint";
import {
  useBoardEnvironmentId,
  useBoardServerProviders,
  useBoardSettings,
  useUpdateBoardSettings,
} from "../../board/useBoardEnvironmentId";

/** The stand-in card identity for envelope previews: a run interpolates the
    real card, so the preview shows placeholders where values vary per card. */
const PREVIEW_CARD_KEY = "{{card-key}}";
const PREVIEW_CARD_TITLE = "{{card title}}";

/** Only reached when the server reports no provider instances at all; the
    picker then has nothing to list, and the trigger still reads "Select a
    model". */

// ── shared row primitives ──────────────────────────────────────────────

function ToggleRow(props: {
  label: string;
  hint?: string | undefined;
  checked: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-board-13-5 text-foreground">{props.label}</span>
        {props.hint ? <span className="text-xs text-muted-foreground">{props.hint}</span> : null}
      </div>
      <Switch
        checked={props.checked}
        onCheckedChange={(checked) => props.onChange(Boolean(checked))}
        aria-label={props.ariaLabel}
      />
    </div>
  );
}

/** The -/value/+ number control. A plain `<input>` because the shared `Input`
    keeps the real element out of reach of the spin-button reset. A `nullable`
    stepper's unset state is cleared-field only; -/+ step off `stepFrom`, the
    value unset resolves to. */
type NumberStepperCommon = {
  min: number;
  max: number;
  step?: number;
  unit?: string;
  ariaLabel: string;
  disabled?: boolean;
};
type NumberStepperProps = NumberStepperCommon &
  (
    | { nullable?: false; value: number; onChange: (value: number) => void }
    | {
        nullable: true;
        value: number | null;
        placeholder: string;
        stepFrom: number;
        onChange: (value: number | null) => void;
      }
  );

export function NumberStepper(props: NumberStepperProps) {
  const step = props.step ?? 1;
  const clamp = (value: number) => Math.max(props.min, Math.min(props.max, value));
  const [draft, setDraft] = useState<string | null>(null);
  const stepFrom = props.nullable ? props.stepFrom : props.value;
  const resolve = (raw: string): number | null =>
    props.nullable && raw.trim().length === 0
      ? null
      : clamp(parsePositiveIntInput(raw, props.value ?? stepFrom));
  const apply = (next: number | null) => {
    setDraft(null);
    if (next === props.value) return;
    if (props.nullable) props.onChange(next);
    else if (next !== null) props.onChange(next);
  };
  // −/+ steps off whatever is on screen, including an uncommitted draft: the
  // buttons suppress the focus change (below), so no blur has committed it yet.
  const nudge = (delta: number) => {
    const shown = draft === null ? props.value : resolve(draft);
    apply(clamp((shown ?? stepFrom) + delta));
  };
  return (
    <div className="flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-input bg-popover shadow-xs">
      <button
        type="button"
        aria-label={`Decrease ${props.ariaLabel}`}
        className="flex h-full w-8 items-center justify-center border-r border-border text-muted-foreground hover:bg-accent hover:text-foreground"
        // Keep focus (and its blur-commit) where it is: blur fires before
        // click, so letting the button steal focus would race the two handlers.
        disabled={props.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => nudge(-step)}
      >
        <MinusIcon className="size-3.5" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        value={draft ?? (props.value === null ? "" : String(props.value))}
        placeholder={props.nullable ? props.placeholder : undefined}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        className="h-full w-14 [appearance:textfield] bg-transparent text-center text-sm font-medium text-foreground outline-none placeholder:font-normal placeholder:text-muted-foreground [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => apply(resolve(event.target.value))}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {props.unit ? <span className="pr-2 text-xs text-muted-foreground">{props.unit}</span> : null}
      <button
        type="button"
        aria-label={`Increase ${props.ariaLabel}`}
        className="flex h-full w-8 items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
        disabled={props.disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => nudge(step)}
      >
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

function NumberRow(props: { label: string; hint?: string; stepper: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="flex min-w-0 flex-col">
        <span className="text-board-13-5 text-foreground">{props.label}</span>
        {props.hint ? <span className="text-xs text-muted-foreground">{props.hint}</span> : null}
      </div>
      {props.stepper}
    </div>
  );
}

/** One side of the system envelope around the editable body. An empty side
    renders nothing. */
function SystemEnvelope(props: { text: string; edge: "top" | "bottom"; label: string }) {
  if (props.text.trim().length === 0) return null;
  return (
    <div
      className={cn(
        "relative bg-muted py-2.5 pr-18.5 pl-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground",
        props.edge === "bottom" ? "border-b border-border" : "border-t border-border",
      )}
      // A named note, not bare text: the visible "System" pill says what the
      // band is, and the role gives the name somewhere valid to live for a
      // screen reader that lands here between the prompt's two halves.
      role="note"
      aria-label={`${props.label} (system)`}
    >
      {props.text}
      <span className="absolute top-2 right-2.5 rounded-full border border-border bg-card px-1.5 py-px font-sans text-board-10-5 font-medium text-muted-foreground">
        System
      </span>
    </div>
  );
}

/**
 * The prompt as the single document a run sends: preamble, editable body,
 * postamble. Edits are a local draft committed on blur, so settings are never
 * written per keystroke and Reset can rewrite the field without a remount race.
 */
function PromptRow(props: {
  id: string;
  label: string;
  value: string;
  defaultValue?: string | undefined;
  preamble: string;
  postamble: string;
  missingMessage?: string | null;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // Mirrors `confirmReset` synchronously: opening the reset dialog moves focus
  // into it, blurring the textarea — the blur handler reads this ref to keep
  // that from committing-and-closing the editor mid-reset.
  const confirmResetOpenRef = useRef(false);
  const setResetOpen = (open: boolean) => {
    confirmResetOpenRef.current = open;
    setConfirmReset(open);
  };
  // Clipping is measured, not guessed from length: many short lines overflow too.
  const documentRef = useRef<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const clamped = !editing && !expanded;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the clamped prompt element before paint to show the fade and "See more".
  useLayoutEffect(() => {
    const element = documentRef.current;
    if (element === null || !clamped) {
      setClipped(false);
      return;
    }
    setClipped(element.scrollHeight > element.clientHeight + 1);
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- New text in the prompt or its envelope must re-measure the clamp.
    props.value,
    props.preamble,
    props.postamble,
    clamped,
  ]);

  // The live text: the draft while editing, the stored value otherwise, so
  // "Modified" tracks what is on screen — after a reset the draft equals the
  // default and the affordance disappears without leaving edit mode.
  const current = draft ?? props.value;
  const modified = props.defaultValue !== undefined && current !== props.defaultValue;
  const words = current.trim().length > 0 ? current.trim().split(/\s+/).length : 0;

  const startEditing = () => {
    setDraft(props.value);
    setEditing(true);
  };
  const commit = () => {
    if (draft !== null && draft !== props.value) props.onChange(draft);
    setDraft(null);
    setEditing(false);
  };
  const confirmResetNow = () => {
    const next = props.defaultValue ?? "";
    setDraft(next);
    if (next !== props.value) props.onChange(next);
    setResetOpen(false);
  };

  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-board-13-5 text-foreground">{props.label}</span>
        <span className="flex-1" />
        {editing ? (
          <>
            {modified ? (
              <Button
                size="xs"
                variant="ghost"
                className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                aria-label={`Reset ${props.label.toLowerCase()} to default`}
                title="Restore the default prompt"
                // Suppress the textarea's blur so opening the confirm modal
                // does not commit-and-close the editor before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setResetOpen(true)}
              >
                <RotateCcwIcon className="size-3" />
                Reset
              </Button>
            ) : null}
            {/* A label, not a button: clicking anywhere outside the textarea is
                what ends editing, and a button here would be caught by that
                same blur and then re-enter editing on its own click. */}
            <span className="flex h-6 items-center gap-1 rounded-md border border-primary px-2 text-xs font-medium text-primary">
              <PencilIcon className="size-3" />
              Editing
            </span>
          </>
        ) : (
          <>
            {modified ? (
              <span className="font-mono text-board-11 text-muted-foreground">Modified</span>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              className="h-6 gap-1 px-2 text-xs text-muted-foreground"
              aria-label={`Edit ${props.label.toLowerCase()}`}
              onClick={startEditing}
            >
              <PencilIcon className="size-3" />
              Edit
            </Button>
          </>
        )}
      </div>

      <div
        ref={documentRef}
        className={cn(
          "relative flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-xs",
          clamped ? "max-h-52" : "",
        )}
      >
        <SystemEnvelope text={props.preamble} edge="bottom" label="Preamble" />

        {editing ? (
          <Textarea
            key={`prompt:${props.id}`}
            unstyled
            value={current}
            aria-label={`${props.label} text`}
            autoFocus
            rows={Math.min(16, Math.max(4, current.split("\n").length + 2))}
            className="block w-full [&_textarea]:resize-y [&_textarea]:bg-card [&_textarea]:px-3.5 [&_textarea]:py-3 [&_textarea]:text-board-13 [&_textarea]:leading-relaxed [&_textarea]:text-foreground"
            onChange={(event) => setDraft(event.target.value)}
            // Clicking away IS "done": blur commits the text and closes the
            // editor, so there is nothing left for a Done button to do. A blur
            // caused by opening the reset dialog is exempt (it keeps focus
            // logically in the editor), so a reset never closes the editor.
            onBlur={() => {
              if (confirmResetOpenRef.current) return;
              commit();
            }}
          />
        ) : (
          <BoardHint label="Click to edit">
            <button
              type="button"
              className="block w-full cursor-text px-3.5 py-3 text-left text-board-13 leading-relaxed whitespace-pre-wrap text-foreground"
              onClick={startEditing}
            >
              {props.value.trim().length > 0 ? (
                props.value
              ) : (
                <span className="text-muted-foreground/70">No prompt yet. Click to write one.</span>
              )}
            </button>
          </BoardHint>
        )}

        <SystemEnvelope text={props.postamble} edge="top" label="Postamble" />

        {clipped ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-11 bg-linear-to-b from-transparent to-card" />
        ) : null}
      </div>

      <div className="flex items-center gap-3">
        {!editing && (clipped || expanded) ? (
          <button
            type="button"
            className="text-xs font-medium text-info-foreground hover:underline"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "See less" : "See more"}
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="font-mono text-board-11 text-muted-foreground">
          {words} words editable
        </span>
      </div>
      {props.missingMessage ? (
        <p className="text-xs text-destructive">{props.missingMessage}</p>
      ) : null}

      {/* base-ui traps focus, closes on Escape, and restores focus to the
          textarea on close, so a reset is keyboard-reachable and leaves the
          editor open. */}
      <AlertDialog open={confirmReset} onOpenChange={setResetOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset this prompt to the default?</AlertDialogTitle>
            <AlertDialogDescription>
              Your edits to this prompt will be replaced by the shipped default text. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="destructive" onClick={confirmResetNow}>
              Reset prompt
            </Button>
            <AlertDialogClose autoFocus render={<Button variant="outline" />}>
              Cancel
            </AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** The numbered review-phase divider from the prototype. */
/** A titled rule between blocks. `step` numbers it (the review loop's three
    phases run in order); a block that is not part of a sequence — the Build
    stage's submit step — passes none. */
function PhaseHeader(props: { step?: number; label: string }) {
  return (
    <div className="mt-3 mb-0.5 flex items-center gap-2">
      {props.step === undefined ? null : (
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-border bg-muted font-mono text-board-10-5 font-semibold text-muted-foreground">
          {props.step}
        </span>
      )}
      <span className="text-board-10-5 font-semibold uppercase tracking-board-9 text-foreground">
        {props.label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// ── stage rows ─────────────────────────────────────────────────────────

/** A stage's name: plain text that becomes a field only once clicked, so the
    role chip stays beside the name. */
function StageNameField(props: {
  label: string;
  editable: boolean;
  onRename: (label: string) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (!editing) {
    // Not editable: a span, so the click keeps falling through to the row's
    // expand/collapse rather than dying on a disabled control.
    return props.editable ? (
      <BoardHint label="Click to rename">
        <button
          type="button"
          className="min-w-0 shrink-0 cursor-text truncate rounded-md px-1 py-0.5 text-left text-sm font-medium text-foreground hover:bg-popover hover:inset-ring hover:inset-ring-border"
          onClick={(event) => {
            event.stopPropagation();
            setEditing(true);
          }}
        >
          {props.label}
        </button>
      </BoardHint>
    ) : (
      <span className="min-w-0 shrink-0 truncate px-1 py-0.5 text-sm font-medium text-foreground">
        {props.label}
      </span>
    );
  }

  return (
    <input
      autoFocus
      defaultValue={props.label}
      aria-label="Stage name"
      size={Math.max(8, props.label.length + 1)}
      className="min-w-0 shrink-0 rounded-md bg-popover px-1 py-0.5 text-sm font-medium text-foreground outline-none inset-ring inset-ring-primary"
      onClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          event.currentTarget.value = props.label;
          event.currentTarget.blur();
        }
      }}
      onBlur={(event) => {
        setEditing(false);
        props.onRename(event.target.value.trim());
      }}
    />
  );
}

function StageChip(props: { text: string; tone: "auto" | "quiet" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-px text-board-11 font-medium",
        props.tone === "auto"
          ? "border-transparent bg-primary/10 text-primary"
          : "border-border text-muted-foreground",
      )}
    >
      {props.text}
    </span>
  );
}

/** A `BoardState` shell so `boardStagesInOrder` can order the stage list the
    same way the board does. */
function stageBoardState(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

/** Client mirror of the decider's order rules: an order that
    breaks them is refused server-side, so don't offer it. */
function orderKeepsSpine(stages: ReadonlyArray<BoardStageDefinition>): boolean {
  return boardStageOrderViolation(stages) === null;
}

export function BoardPipelineSection() {
  const board = useBoardSettings((settings) => settings.board);
  const update = useUpdateBoardSettings();
  const anchor = searchableSetting("board-pipeline");
  const environmentId = useBoardEnvironmentId();
  const stageList = useAtomValue(
    boardEnvironment.stageListAtom(environmentId ?? ("" as EnvironmentId)),
  );
  const stages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  const ordered = boardStagesInOrder(stageBoardState(stages));
  // Which projects use each stage, and which run CI.
  const projectStageConfigs = useAtomValue(
    boardEnvironment.projectStageConfigsAtom(environmentId ?? ("" as EnvironmentId)),
  );
  const shellState = useAtomValue(
    environmentShell.stateValueAtom(environmentId ?? ("" as EnvironmentId)),
  );
  const shellProjects = Option.getOrNull(shellState.snapshot)?.projects;
  const projects = (shellProjects ?? [])
    .filter((project) => !isBoardProjectHidden(board, project.id))
    .map((project) => ({ id: project.id, title: project.title }));
  const stageView = { stages, projectStageConfigs, cards: [] };
  const ciProjects = projects.flatMap((project) => {
    const config = projectStageConfigs?.[project.id];
    if (config === undefined || config.ciSteps.length === 0) return [];
    return [
      {
        id: project.id,
        title: project.title,
        steps: config.ciSteps.length,
        active: config.stageSwitches[BOARD_SEED_STAGE_IDS.ci] === true,
      },
    ];
  });
  const canWrite = useEnvironmentScope(
    environmentId ?? ("" as EnvironmentId),
    AuthSettingsWriteScope,
  );
  const setStageDefault = useAtomCommand(boardEnvironment.setStageDefault);

  const createStage = useAtomCommand(boardEnvironment.createStage);
  const renameStage = useAtomCommand(boardEnvironment.renameStage);
  const reorderStage = useAtomCommand(boardEnvironment.reorderStage);
  const deleteStage = useAtomCommand(boardEnvironment.deleteStage);

  const [openStageId, setOpenStageId] = useState<string | null>(null);

  // ProviderModelPicker context (shared across every stage row).
  const settings = useBoardSettings();
  const ownProviders = useBoardServerProviders();
  // And the instance ids only workers have — a recipe names an id, and
  // it resolves on the worker the card runs on.
  // The card view keeps the same object across a clone's progress ticks, which
  // this page streams and the provider lists don't depend on.
  const workers = useBoardWorkersCardView(environmentId ?? ("" as EnvironmentId));
  const serverProviders = [...ownProviders, ...boardWorkerOnlyProviders(workers, ownProviders)];
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings, null),
  );
  const getModelOptions = (active: ActiveModel) =>
    getCustomModelOptionsByInstance(settings, serverProviders, active.instanceId, active.model);

  const crudEnabled = environmentId !== null && canWrite;

  const updateStage = (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => {
    update({ board: { pipeline: setBoardStageExecution(board, stageId, patch) } });
  };

  // The workspace default — what every stage below that names no
  // model of its own actually runs on.
  const defaultModel = board.defaultModel;
  const inheritedModelName =
    defaultModel === null
      ? null
      : boardModelDisplayName(defaultModel, getModelOptions, instanceEntries);

  const onRename = (stage: BoardStageDefinition, label: string) => {
    if (environmentId === null || label.length === 0 || label === stage.label) return;
    void renameStage({ environmentId, input: { stageId: stage.stageId, label } });
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const onDragEnd = (event: DragEndEvent) => {
    if (environmentId === null) return;
    const overId = event.over === null ? null : String(event.over.id);
    const activeId = String(event.active.id);
    if (overId === null || overId === activeId) return;
    const fromIndex = ordered.findIndex((stage) => stage.stageId === activeId);
    const toIndex = ordered.findIndex((stage) => stage.stageId === overId);
    if (fromIndex === -1 || toIndex === -1) return;
    const moved = ordered[fromIndex]!;
    const next = [...ordered];
    next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    // Refuse drops that break the spine client-side; the decider also guards
    // build-boundary crossings while cards are held — that refusal simply
    // snaps the row back when the stage list re-renders from server state.
    if (!orderKeepsSpine(next)) return;
    const position = next.findIndex((stage) => stage.stageId === activeId);
    const orderKey = pinOrderKeyBetween(
      next[position - 1]?.orderKey ?? null,
      next[position + 1]?.orderKey ?? null,
    );
    if (orderKey === null) return;
    void reorderStage({ environmentId, input: { stageId: moved.stageId, orderKey } });
  };

  const onDelete = (stage: BoardStageDefinition) => {
    if (environmentId === null) return;
    setOpenStageId(null);
    void deleteStage({ environmentId, input: { stageId: stage.stageId } });
  };

  const onSetDefault = (stage: BoardStageDefinition, on: boolean) => {
    if (environmentId === null) return;
    void setStageDefault({ environmentId, input: { stageId: stage.stageId, on } });
  };

  // A new stage lands just before CI, never between CI and merge.
  // "For one project" makes it off by default and on for that project.
  const onAddStage = (forProjectId: ProjectId | null) => {
    if (environmentId === null) return;
    const orderKey = boardNewStageOrderKey(stageBoardState(stages));
    if (orderKey === null) return;
    const stageId = BoardStageId.make(randomUUID());
    setOpenStageId(stageId);
    setAddingFor(null);
    void createStage({
      environmentId,
      input: {
        stageId,
        label: "New stage",
        orderKey,
        ...(forProjectId === null ? {} : { forProjectId }),
      },
    });
  };
  const [addingFor, setAddingFor] = useState<"choose" | null>(null);

  return (
    <SettingsSection id="board-pipeline" title={anchor.title} variant="plain">
      <p className="mb-2 max-w-xl px-3 text-board-13 leading-board-1-55 text-muted-foreground/80 sm:px-4">
        Each stage runs one agent, except code review, which runs a review loop. A card freezes its
        stage config the moment it enters the stage, so edits take effect the next time a card
        enters, never mid-flight.
      </p>
      {!crudEnabled ? (
        <p className="px-3 text-xs text-muted-foreground/70 sm:px-4">
          Connect an environment to add, rename, reorder, or delete stages.
        </p>
      ) : null}
      <div
        id="board-default-model"
        className="mx-3 mb-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:mx-4"
      >
        <ModelRow
          label="Default model"
          ariaLabel="Board default model"
          selection={defaultModel}
          placeholder="Select a model"
          instanceEntries={instanceEntries}
          getModelOptions={getModelOptions}
          onChange={(model) => update({ board: { defaultModel: model } })}
          modelOptions={defaultModel?.options}
          onModelOptionsChange={(options) => {
            if (defaultModel === null) return;
            update({
              board: {
                defaultModel:
                  options === undefined
                    ? { instanceId: defaultModel.instanceId, model: defaultModel.model }
                    : { instanceId: defaultModel.instanceId, model: defaultModel.model, options },
              },
            });
          }}
          // The default carries no access level: a stage's own posture is a
          // per-stage decision and every stage already names one, so
          // there is nothing here for a default to fill in.
          hideRuntimeMode
          runtimeMode="approval-required"
          onRuntimeModeChange={() => {}}
        />
        <p className="text-xs leading-normal text-muted-foreground/80">
          What a stage below runs on when it names no model of its own. Leave it unset and each
          stage must pick one; a stage that picks one always wins.
        </p>
      </div>
      <div className="mx-3 overflow-hidden rounded-xl border border-border bg-card shadow-xs sm:mx-4">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={ordered.map((stage) => stage.stageId)}
            strategy={verticalListSortingStrategy}
          >
            {ordered.map((stage, index) => (
              <StageAccordionRow
                key={stage.stageId}
                stage={stage}
                index={index}
                exec={resolveBoardStageExecution(board, stage.stageId)}
                ciProjects={ciProjects}
                coverage={boardStageProjectCoverage(
                  stageView,
                  stage,
                  projects.map((p) => p.id),
                )}
                projects={projects}
                onSetDefault={(on) => onSetDefault(stage, on)}
                expanded={openStageId === stage.stageId}
                crudEnabled={crudEnabled}
                instanceEntries={instanceEntries}
                getModelOptions={getModelOptions}
                inheritedModelName={inheritedModelName}
                onToggle={() =>
                  setOpenStageId((current) => (current === stage.stageId ? null : stage.stageId))
                }
                onRename={(label) => onRename(stage, label)}
                onDelete={() => onDelete(stage)}
                updateStage={updateStage}
              />
            ))}
          </SortableContext>
        </DndContext>
        {addingFor === null ? (
          <button
            type="button"
            disabled={!crudEnabled}
            className="flex w-full items-center gap-2 px-5 py-3 text-left text-board-13 font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => setAddingFor("choose")}
          >
            <PlusIcon className="size-3.5" />
            Add stage
          </button>
        ) : (
          <AddStageChooser
            onCancel={() => setAddingFor(null)}
            onAdd={onAddStage}
            projects={projects}
          />
        )}
      </div>
    </SettingsSection>
  );
}

/**
 * A `ModelRow`'s inheritance props. With a name to inherit the row
 * shows it as the placeholder and is no longer required; with nothing to inherit
 * it keeps the required-field language it had before there was a default.
 */
function inheritedModelRowProps(
  inheritedName: string | null,
  requiredMessage: string,
): { placeholder?: string; requiredMessage: string | null } {
  return inheritedName === null
    ? { requiredMessage }
    : { placeholder: `${inheritedName} (default)`, requiredMessage: null };
}

function StageAccordionRow(props: {
  stage: BoardStageDefinition;
  index: number;
  exec: BoardStageExecution;
  /** The projects with CI steps. */
  ciProjects: ReadonlyArray<BoardCiProject>;
  /** Which visible projects use the stage. */
  coverage: BoardStageProjectCoverage;
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  onSetDefault: (on: boolean) => void;
  expanded: boolean;
  crudEnabled: boolean;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  /** The workspace default's display name, or null. A row with no model of its
      own names the one it inherits rather than reading "Select a model". */
  inheritedModelName: string | null;
  onToggle: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
  updateStage: (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, exec, expanded } = props;
  const role = effectiveBoardStageRole(stage);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.stageId,
  });

  const isReview = isBoardReviewStageExecution(exec);
  const isMerge = isBoardMergeStageExecution(exec);
  // CI is a seed stage with no role, but it is the board's own: it is never
  // renamed, reordered or removed here.
  const isCi = isBoardCiStageExecution(exec);
  const fixed = isCi || stage.stageId === BOARD_SEED_STAGE_IDS.ci;
  const switchable = role === null && !fixed;
  const coverageChips: ReadonlyArray<{ text: string; tone: "auto" | "quiet" }> =
    expanded || !switchable
      ? []
      : [
          {
            text: boardStageDefaultForProjects(stage)
              ? "Default on"
              : stage.projectId !== null && props.coverage.included.length <= 1
                ? `Only ${props.projects.find((project) => project.id === stage.projectId)?.title ?? "one project"}`
                : "Opt-in",
            tone: "quiet" as const,
          },
          ...(props.coverage.excluded.length > 0 && props.coverage.included.length > 0
            ? [
                {
                  text: `${props.coverage.included.length} of ${props.coverage.included.length + props.coverage.excluded.length} projects`,
                  tone: "quiet" as const,
                },
              ]
            : []),
        ];
  const baseChips: ReadonlyArray<{ text: string; tone: "auto" | "quiet" }> = expanded
    ? []
    : isCi
      ? [
          { text: "Per project", tone: "quiet" as const },
          {
            text: `${exec.maxFixAttempts} ${exec.maxFixAttempts === 1 ? "fix" : "fixes"}`,
            tone: "quiet" as const,
          },
        ]
      : isMerge
        ? [
            // "Manual" is true of this stage but says nothing: it is manual by
            // design and cannot be otherwise. What the reader wants at a glance
            // is what the Merge button will do and whether branches get tidied.
            { text: exec.strategy, tone: "quiet" as const },
            // Auto-merge earns the "auto" tone the other stages use for
            // auto-execute: it is the one thing about this stage that runs
            // without a click, and the row above says so out loud.
            ...(exec.autoMerge ? [{ text: "Auto-merge", tone: "auto" as const }] : []),
            ...(exec.deleteBranchOnDone ? [{ text: "Delete branch", tone: "quiet" as const }] : []),
          ]
        : [
            exec.autoExecute
              ? { text: "Auto", tone: "auto" as const }
              : { text: "Manual", tone: "quiet" as const },
            ...(exec.autoExecute && isReview
              ? [{ text: `${exec.rounds} rounds`, tone: "quiet" as const }]
              : []),
            ...(exec.autoExecute && !isReview && role !== "plan"
              ? [{ text: `${msToMinutes(exec.timeoutMs)} min idle`, tone: "quiet" as const }]
              : []),
          ];
  const chips = [...coverageChips, ...baseChips];

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "border-b border-border",
        isDragging ? "relative z-10 bg-card shadow-md" : expanded ? "bg-card" : "",
      )}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {/* The header row is a composite control (drag handle, rename input,
          caret); the whole row toggles for pointer users while the caret
          button below carries the accessible expand/collapse semantics. */}
      <div
        className={cn(
          "flex cursor-pointer items-center gap-2.5 px-4 py-3 hover:bg-muted sm:px-5",
          expanded ? "bg-muted" : "",
        )}
        onClick={props.onToggle}
      >
        <button
          type="button"
          aria-label={`Reorder stage ${stage.label}`}
          className="flex w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 hover:text-foreground"
          disabled={!props.crudEnabled || fixed}
          onClick={(event) => event.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-accent font-mono text-board-11 font-semibold text-muted-foreground">
          {props.index + 1}
        </span>
        <StageNameField
          key={`name:${stage.stageId}:${stage.label}`}
          label={stage.label}
          editable={props.crudEnabled && !fixed}
          onRename={props.onRename}
        />
        {role !== null && role !== "done" ? (
          <span className="shrink-0 rounded-md bg-accent px-1.5 py-px font-mono text-board-11 font-medium text-muted-foreground">
            {role}
          </span>
        ) : null}
        <span className="min-w-2 flex-1" />
        {chips.map((chip) => (
          <StageChip key={chip.text} text={chip.text} tone={chip.tone} />
        ))}
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse stage ${stage.label}` : `Expand stage ${stage.label}`}
          className="flex shrink-0 items-center justify-center text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation();
            props.onToggle();
          }}
        >
          <ChevronDownIcon
            className={cn("size-4 transition-transform", expanded ? "rotate-180" : "")}
          />
        </button>
      </div>

      {expanded ? (
        <div className="flex flex-col px-4 pb-4 pt-0.5 sm:pl-13 sm:pr-5">
          {switchable ? (
            <StageProjectsRow
              coverage={props.coverage}
              defaultOn={boardStageDefaultForProjects(stage)}
              editable={props.crudEnabled}
              onSetDefault={props.onSetDefault}
              stage={stage}
            />
          ) : role !== null ? (
            <p className="pb-2 text-xs leading-normal text-muted-foreground">
              <LockIcon className="mr-1 inline size-3" />
              {BOARD_ROLE_STAGE_NOTE}
            </p>
          ) : null}
          {isCi ? (
            <CiStageBody
              stage={stage}
              exec={exec}
              ciProjects={props.ciProjects}
              instanceEntries={props.instanceEntries}
              getModelOptions={props.getModelOptions}
              inheritedModelName={props.inheritedModelName}
              updateStage={props.updateStage}
            />
          ) : isReview ? (
            <ReviewStageBody
              stage={stage}
              exec={exec}
              instanceEntries={props.instanceEntries}
              getModelOptions={props.getModelOptions}
              inheritedModelName={props.inheritedModelName}
              updateStage={props.updateStage}
            />
          ) : isMerge ? (
            <MergeStageBody
              stage={stage}
              exec={exec}
              instanceEntries={props.instanceEntries}
              getModelOptions={props.getModelOptions}
              inheritedModelName={props.inheritedModelName}
              updateStage={props.updateStage}
            />
          ) : (
            <SimpleStageBody
              stage={stage}
              role={role}
              exec={exec}
              instanceEntries={props.instanceEntries}
              getModelOptions={props.getModelOptions}
              inheritedModelName={props.inheritedModelName}
              updateStage={props.updateStage}
            />
          )}
          {role === null && !fixed ? (
            <RemoveStageButton disabled={!props.crudEnabled} onDelete={props.onDelete} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface BoardCiProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly steps: number;
  readonly active: boolean;
}

/** A stage's default for projects, and the projects it applies to.
    Each chip opens that project's Pipeline tab. */
function StageProjectsRow(props: {
  stage: BoardStageDefinition;
  defaultOn: boolean;
  coverage: BoardStageProjectCoverage;
  editable: boolean;
  onSetDefault: (on: boolean) => void;
}) {
  const included = new Set<string>(props.coverage.included);
  const all = [...props.coverage.included, ...props.coverage.excluded];
  const shell = useBoardSettingsProjectTitles();
  return (
    <div className="flex flex-col gap-2 pb-2">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <span className="text-board-13-5 text-foreground">Default for projects</span>
          <span className="text-xs text-muted-foreground">
            {props.defaultOn
              ? "Every project runs it unless it switches it off."
              : "Off unless a project switches it on."}
          </span>
        </div>
        <ToggleGroup
          aria-label={`${props.stage.label} default for projects`}
          disabled={!props.editable}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "on" || next === "off") props.onSetDefault(next === "on");
          }}
          size="xs"
          value={[props.defaultOn ? "on" : "off"]}
          variant="outline"
        >
          <Toggle value="on">On</Toggle>
          <Toggle value="off">Off</Toggle>
        </ToggleGroup>
      </div>
      {all.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">
            Applies to {props.coverage.included.length} of {all.length} projects
          </span>
          <div className="flex flex-wrap gap-1">
            {all.map((projectId) => (
              <Link
                className={cn(
                  "rounded-md border px-1.5 py-px text-board-11-5",
                  included.has(projectId)
                    ? "border-border text-foreground"
                    : "border-dashed border-border text-muted-foreground",
                )}
                key={projectId}
                params={{ projectId, tab: "pipeline" }}
                to="/settings/board/projects/$projectId/$tab"
              >
                {shell.get(projectId) ?? projectId}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function useBoardSettingsProjectTitles(): ReadonlyMap<string, string> {
  const environmentId = useBoardEnvironmentId();
  const shellState = useAtomValue(
    environmentShell.stateValueAtom(environmentId ?? ("" as EnvironmentId)),
  );
  const projects = Option.getOrNull(shellState.snapshot)?.projects;
  return new Map((projects ?? []).map((project) => [String(project.id), project.title]));
}

/** Removing a stage asks first; cards already in it stay as a retired column
    until they move on, but the decider refuses while any card sits there. */
function RemoveStageButton(props: { disabled: boolean; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="flex items-center gap-2 pt-3">
      {confirming ? (
        <>
          <span className="text-xs text-muted-foreground">
            Remove this stage for every project?
          </span>
          <Button size="xs" variant="destructive" onClick={props.onDelete}>
            Remove
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={props.disabled}
          className="gap-1.5 text-destructive-foreground hover:bg-destructive/10"
          onClick={() => setConfirming(true)}
        >
          <Trash2Icon className="size-3.5" />
          Remove stage
        </Button>
      )}
    </div>
  );
}

/** A new stage for every project, or made for one (off for the rest). */
function AddStageChooser(props: {
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  onAdd: (forProjectId: ProjectId | null) => void;
  onCancel: () => void;
}) {
  const [projectId, setProjectId] = useState<ProjectId | null>(props.projects[0]?.id ?? null);
  return (
    <div className="flex flex-col gap-2 px-5 py-3">
      <span className="text-board-13 font-medium text-foreground">New stage</span>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs" variant="outline" onClick={() => props.onAdd(null)}>
          For every project
        </Button>
        <span className="text-xs text-muted-foreground">or</span>
        <select
          aria-label="Project the stage is for"
          className="h-7 rounded-md border border-input bg-background px-2 text-xs"
          disabled={props.projects.length === 0}
          onChange={(event) => setProjectId(event.target.value as ProjectId)}
          value={projectId ?? ""}
        >
          {props.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.title}
            </option>
          ))}
        </select>
        <Button
          size="xs"
          variant="outline"
          disabled={projectId === null}
          onClick={() => props.onAdd(projectId)}
        >
          For this project only
        </Button>
        <span className="flex-1" />
        <Button size="xs" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
      <span className="text-xs text-muted-foreground">
        New stages go just before Continuous integration. A stage for one project is off by default;
        other projects can switch it on later.
      </span>
    </div>
  );
}

/**
 * The Continuous integration stage's body. The board runs the steps
 * itself; what is configured here is the fix agent that runs when one fails.
 * The steps belong to each project's t3o.json, so they are listed, not edited.
 */
function CiStageBody(props: {
  stage: BoardStageDefinition;
  exec: BoardStageExecutionCi;
  ciProjects: ReadonlyArray<BoardCiProject>;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  inheritedModelName: string | null;
  updateStage: (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, exec } = props;
  const set = (patch: Partial<BoardStageExecutionCi>) => props.updateStage(stage.stageId, patch);
  return (
    <>
      <p className="pb-1 text-xs leading-normal text-muted-foreground">
        Runs each project&apos;s CI steps in the card&apos;s worktree after code review. When a pass
        fails, a fix agent fixes every reported failure and CI runs again from the top. If the fix
        attempts run out, or the agent can&apos;t fix something, the card stops in CI and waits for
        you.
      </p>
      <div className="flex flex-col gap-1.5 py-2">
        <div className="flex items-center gap-2">
          <span className="text-board-13-5 text-foreground">Steps</span>
          <span className="rounded-md bg-accent px-1.5 py-px text-board-11 font-medium text-muted-foreground">
            Set per project
          </span>
        </div>
        {props.ciProjects.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            No project has CI steps yet. Add them on a project&apos;s CI tab.
          </span>
        ) : (
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {props.ciProjects.map((project) => (
              <li key={project.id}>
                <Link
                  className="text-foreground underline-offset-2 hover:underline"
                  params={{ projectId: project.id, tab: "ci" }}
                  to="/settings/board/projects/$projectId/$tab"
                >
                  {project.title}
                </Link>{" "}
                · {project.steps} {project.steps === 1 ? "step" : "steps"}
                {project.active ? "" : " · off"}
              </li>
            ))}
          </ul>
        )}
        <span className="text-xs leading-normal text-muted-foreground/80">
          On for projects with CI steps. CI can&apos;t be removed or renamed; switch it per project.
        </span>
      </div>
      <NumberRow
        label="Fix attempts"
        hint="Per CI visit. When they run out the card stops in CI for you."
        stepper={
          <NumberStepper
            value={exec.maxFixAttempts}
            min={0}
            max={10}
            ariaLabel="CI fix attempts"
            onChange={(maxFixAttempts) => set({ maxFixAttempts })}
          />
        }
      />
      <PromptRow
        id={`stage-prompt:${stage.stageId}`}
        label="Fix prompt"
        value={exec.prompt}
        defaultValue={DEFAULT_BOARD_CI_FIX_PROMPT}
        preamble={boardStepPreamble({
          card: { key: PREVIEW_CARD_KEY, title: PREVIEW_CARD_TITLE, stage: stage.stageId },
          stageLabel: stage.label,
          step: { stepLabel: null },
        })}
        postamble={[
          "Then the board adds the failed steps, a numbered list of the issues to fix, and each step's output, followed by:",
          ...boardCiFixPromptRules(2),
          "",
          boardStepPostamble({
            humanInLoop: false,
            role: null,
            step: { stepId: stage.stageId, stepLabel: null },
          }),
        ].join("\n")}
        missingMessage={exec.prompt.trim().length === 0 ? "A fix prompt is required." : null}
        onChange={(prompt) => set({ prompt })}
      />
      <ModelRow
        label="Fix model"
        ariaLabel="CI fix model"
        selection={exec.model}
        {...inheritedModelRowProps(
          props.inheritedModelName,
          "Pick the model the fix agent runs on.",
        )}
        instanceEntries={props.instanceEntries}
        getModelOptions={props.getModelOptions}
        onChange={(model) => set({ model })}
        modelOptions={exec.model?.options}
        onModelOptionsChange={(options) => {
          if (exec.model === null) return;
          set({
            model:
              options === undefined
                ? { instanceId: exec.model.instanceId, model: exec.model.model }
                : { instanceId: exec.model.instanceId, model: exec.model.model, options },
          });
        }}
        runtimeMode={effectiveBoardRuntimeMode(exec.runtimeMode, exec.mode)}
        onRuntimeModeChange={(runtimeMode) => set({ runtimeMode })}
      />
    </>
  );
}

/**
 * The merge-role stage's body. No "Auto execute" row: nothing runs on entry.
 * Auto-merge is a forge operation, not an agent run.
 */
function MergeStageBody(props: {
  stage: BoardStageDefinition;
  exec: BoardStageExecutionMerge;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  inheritedModelName: string | null;
  updateStage: (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, exec } = props;
  const set = (patch: Partial<BoardStageExecution>) => props.updateStage(stage.stageId, patch);

  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-board-13-5 text-foreground">Merge strategy</span>
          <span className="text-xs text-muted-foreground">
            How the Merge button integrates the card&apos;s pull request.
          </span>
        </div>
        <select
          aria-label="Merge strategy"
          className="h-8 shrink-0 rounded-md border border-input bg-popover px-2 text-board-13 text-foreground"
          onChange={(event) =>
            set({ strategy: event.target.value as BoardStageExecutionMerge["strategy"] })
          }
          value={exec.strategy}
        >
          <option value="squash">Squash and merge</option>
          <option value="merge">Merge commit</option>
          <option value="rebase">Rebase and merge</option>
        </select>
      </div>
      <ToggleRow
        label="Auto-merge when ready"
        hint="Merges every card that arrives here as soon as the forge accepts it, retrying a check that is still running. Cards already waiting here keep their Merge button; this is the policy for what arrives next. Leaving it off is what means “ask me before merging”; individual cards can still be armed from their own menu."
        checked={exec.autoMerge}
        ariaLabel="Auto-merge when ready"
        onChange={(checked) => set({ autoMerge: checked })}
      />
      <ToggleRow
        label="Auto delete branch when card done"
        hint="Deletes the remote branch once a card reaches Done with its pull request merged. The local branch waits for a worktree that still has it checked out."
        checked={exec.deleteBranchOnDone}
        ariaLabel="Auto delete branch when card done"
        onChange={(checked) => set({ deleteBranchOnDone: checked })}
      />
      <PromptRow
        id={`stage-prompt:${stage.stageId}`}
        label="Conflict resolution prompt"
        value={exec.prompt}
        defaultValue={DEFAULT_BOARD_MERGE_CONFLICT_PROMPT}
        preamble={boardStepPreamble({
          card: { key: PREVIEW_CARD_KEY, title: PREVIEW_CARD_TITLE, stage: stage.stageId },
          stageLabel: stage.label,
          // One step in this stage, so the run carries no step identity
          // and the preview shows no `Step:` line.
          step: { stepLabel: null },
        })}
        postamble={boardStepPostamble({
          // Unattended: the conflict fix reports through `board_complete_step`
          // rather than asking a human, which is what lets a successful one
          // finish the merge automatically.
          humanInLoop: false,
          role: "merge",
          step: { stepId: stage.stageId, stepLabel: null },
        })}
        onChange={(prompt) => set({ prompt })}
      />
      <ModelRow
        label="Model"
        ariaLabel="Conflict resolution model"
        selection={exec.model}
        {...inheritedModelRowProps(
          props.inheritedModelName,
          "Pick the model conflict resolution runs on.",
        )}
        instanceEntries={props.instanceEntries}
        getModelOptions={props.getModelOptions}
        onChange={(model) => set({ model })}
        modelOptions={exec.model?.options}
        onModelOptionsChange={(options) => {
          if (exec.model === null) return;
          set({
            model:
              options === undefined
                ? { instanceId: exec.model.instanceId, model: exec.model.model }
                : { instanceId: exec.model.instanceId, model: exec.model.model, options },
          });
        }}
        runtimeMode={effectiveBoardRuntimeMode(exec.runtimeMode, exec.mode)}
        onRuntimeModeChange={(runtimeMode) => set({ runtimeMode })}
      />
    </>
  );
}

/** Every non-review stage body; its rows follow the stage's effective role. */
function SimpleStageBody(props: {
  stage: BoardStageDefinition;
  role: BoardStageRole | null;
  exec: Exclude<BoardStageExecution, BoardStageExecutionReview>;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  inheritedModelName: string | null;
  updateStage: (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, role, exec } = props;
  const set = (patch: Partial<BoardStageExecution>) => props.updateStage(stage.stageId, patch);

  // What the envelope will actually do on this stage's common path: Planning
  // is forced human-in-the-loop, Building runs unattended (the with-plan pause
  // is retired), a roleless stage follows its own toggle.
  const previewHumanInLoop = role === "plan" ? true : role === "build" ? false : exec.humanInLoop;
  const unattended = role === "build" || (role !== "plan" && !exec.humanInLoop);

  return (
    <>
      <ToggleRow
        label="Auto execute"
        hint={exec.autoExecute ? undefined : "Cards rest here until a human moves them on."}
        checked={exec.autoExecute}
        ariaLabel="Auto execute this stage"
        onChange={(checked) => set({ autoExecute: checked })}
      />
      {exec.autoExecute ? (
        <>
          <PromptRow
            id={stage.stageId}
            label="Prompt"
            value={exec.prompt}
            defaultValue={
              role === "build"
                ? DEFAULT_BOARD_BUILD_PROMPT
                : role === "plan"
                  ? DEFAULT_BOARD_PLANNING_PROMPT
                  : undefined
            }
            preamble={boardStepPreamble({
              card: { key: PREVIEW_CARD_KEY, title: PREVIEW_CARD_TITLE, stage: stage.stageId },
              stageLabel: stage.label,
              // This stage runs one step, so the run carries no step identity
              // and the preview shows no `Step:` line — exactly
              // what the agent will see.
              step: { stepLabel: null },
            })}
            postamble={boardStepPostamble({
              humanInLoop: previewHumanInLoop,
              role,
              step: { stepId: stage.stageId, stepLabel: null },
            })}
            missingMessage={
              exec.prompt.trim().length === 0 ? "A prompt is required to auto-execute." : null
            }
            onChange={(prompt) => set({ prompt })}
          />
          <ModelRow
            label="Model"
            ariaLabel="Stage model"
            selection={exec.model}
            {...inheritedModelRowProps(
              props.inheritedModelName,
              "Pick the model this stage runs on.",
            )}
            instanceEntries={props.instanceEntries}
            getModelOptions={props.getModelOptions}
            onChange={(model) => set({ model })}
            modelOptions={exec.model?.options}
            onModelOptionsChange={(options) => {
              if (exec.model === null) return;
              set({
                model:
                  options === undefined
                    ? { instanceId: exec.model.instanceId, model: exec.model.model }
                    : { instanceId: exec.model.instanceId, model: exec.model.model, options },
              });
            }}
            runtimeMode={effectiveBoardRuntimeMode(exec.runtimeMode, exec.mode)}
            onRuntimeModeChange={(runtimeMode) => set({ runtimeMode })}
          />
          {role === "plan" && exec.kind === "simple" ? (
            <PlanReviewSettingsBlock
              stageId={stage.stageId}
              settings={exec.planReview}
              onChange={(planReview) => set({ planReview })}
            />
          ) : null}
          {role === null || role === "done" ? (
            <ToggleRow
              label="Agent can edit the card's worktree"
              hint="Off runs read-only in the project root; on gives the agent the card's branch and a concurrency slot."
              checked={exec.mode === "build"}
              ariaLabel="Agent can edit the card's worktree"
              onChange={(checked) => set({ mode: checked ? "build" : "plan" })}
            />
          ) : null}
          {role === "build" ? (
            <>
              <ToggleRow
                label="Pause for a human when no plan exists"
                checked={exec.humanInLoopWithoutPlan}
                ariaLabel="Human in the loop when no plan exists"
                onChange={(checked) => set({ humanInLoopWithoutPlan: checked })}
              />
              {/* The with-plan default is the one a sub-board child reads (a child always
                  counts as planned), so this row is the only UI way to make a split's
                  children pause. */}
              <ToggleRow
                label="Pause for a human when a plan exists"
                hint="Also governs sub-board children: a child's approved plan became its brief, so it counts as planned."
                checked={exec.humanInLoopWithPlan}
                ariaLabel="Human in the loop when a plan exists"
                onChange={(checked) => set({ humanInLoopWithPlan: checked })}
              />
            </>
          ) : null}
          {role === null || role === "done" ? (
            <ToggleRow
              label="Pause for a human"
              checked={exec.humanInLoop}
              ariaLabel="Human in the loop"
              onChange={(checked) => set({ humanInLoop: checked })}
            />
          ) : null}
          {role !== "plan" && unattended ? (
            <>
              <ToggleRow
                label="Auto advance to the next stage"
                checked={exec.autoAdvance}
                ariaLabel="Auto advance to the next stage"
                onChange={(checked) => set({ autoAdvance: checked })}
              />
              <NumberRow
                label="Stall timeout"
                hint="Time with no sign of life (no todo-list progress, no new commit) before the supervisor nudges the step. Not a cap on total run time: a build that keeps working never trips it."
                stepper={
                  <NumberStepper
                    value={msToMinutes(exec.timeoutMs)}
                    min={BOARD_STEP_TIMEOUT_MIN_MINUTES}
                    max={240}
                    step={5}
                    unit="min"
                    ariaLabel="Stall timeout in minutes"
                    onChange={(minutes) => set({ timeoutMs: minutesToMs(minutes) })}
                  />
                }
              />
              <NumberRow
                label="Attempts"
                hint="Consecutive stalls before the step gives up and asks a human."
                stepper={
                  <NumberStepper
                    value={exec.maxAttempts}
                    min={1}
                    max={BOARD_STEP_MAX_ATTEMPTS_MAX}
                    ariaLabel="Max attempts"
                    onChange={(maxAttempts) => set({ maxAttempts })}
                  />
                }
              />
            </>
          ) : null}
        </>
      ) : null}
      {isBoardBuildStageExecution(exec) ? (
        <SubmitStepBlock
          stage={stage}
          submit={exec.submit}
          stageModelName={
            exec.model === null
              ? props.inheritedModelName
              : boardModelDisplayName(exec.model, props.getModelOptions, props.instanceEntries)
          }
          instanceEntries={props.instanceEntries}
          getModelOptions={props.getModelOptions}
          onChange={(patch) => set({ submit: { ...exec.submit, ...patch } })}
        />
      ) : null}
    </>
  );
}

/**
 * Plan review defaults, on the plan-role stage. The default prompt is
 * never written into settings: Reset and an untouched prompt both store null.
 */
function PlanReviewSettingsBlock(props: {
  stageId: BoardStageId;
  settings: BoardPlanReviewSettings | undefined;
  onChange: (next: BoardPlanReviewSettings) => void;
}) {
  const current: BoardPlanReviewSettings = props.settings ?? {
    enabledByDefault: false,
    defaultRounds: DEFAULT_BOARD_PLAN_REVIEW_ROUNDS,
    prompt: null,
  };
  const set = (patch: Partial<BoardPlanReviewSettings>) => props.onChange({ ...current, ...patch });
  return (
    <>
      <PhaseHeader label="Plan review" />
      <ToggleRow
        label="Review plans by default"
        hint="Each card can still turn it on or off and set its own rounds."
        checked={current.enabledByDefault}
        ariaLabel="Review plans by default"
        onChange={(enabledByDefault) => set({ enabledByDefault })}
      />
      <NumberRow
        label="Default rounds"
        hint="Stops early once the reviewers converge."
        stepper={
          <NumberStepper
            value={current.defaultRounds}
            min={BOARD_PLAN_REVIEW_ROUNDS_MIN}
            max={BOARD_PLAN_REVIEW_ROUNDS_MAX}
            ariaLabel="Default plan review rounds"
            onChange={(defaultRounds) => set({ defaultRounds })}
          />
        }
      />
      <p className="pt-1 text-xs text-muted-foreground">
        Given to the planning agent when it posts its plan. {"{rounds}"} is the card's round count.
      </p>
      <PromptRow
        id={`${props.stageId}:plan-review`}
        label="Prompt"
        value={current.prompt ?? DEFAULT_BOARD_PLAN_REVIEW_PROMPT}
        defaultValue={DEFAULT_BOARD_PLAN_REVIEW_PROMPT}
        preamble={planReviewInstructionsLead(current.defaultRounds)}
        postamble={planReviewInstructionsClosing({
          rounds: current.defaultRounds,
          humanInLoop: true,
        })}
        onChange={(prompt) =>
          set({ prompt: prompt === DEFAULT_BOARD_PLAN_REVIEW_PROMPT ? null : prompt })
        }
      />
    </>
  );
}

/**
 * "Submit for merge (no review)": the Build stage's second exit, configured like
 * a review phase. Outside the `Auto execute` conditional because submitting is a
 * human click, available on a stage driven entirely by hand.
 */
function SubmitStepBlock(props: {
  stage: BoardStageDefinition;
  submit: BoardStepExecution;
  /** The model this step inherits when it names none — the Build stage's own,
      or the workspace default. Named rather than called "default", because
      saying "default" when the stage above actually decides is a lie the user
      cannot check. */
  stageModelName: string | null;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  onChange: (patch: Partial<BoardStepExecution>) => void;
}) {
  const { stage, submit } = props;
  return (
    <>
      <PhaseHeader label="Submit for merge (no review)" />
      <p className="mb-1 max-w-[62ch] text-board-12-5 leading-board-1-55 text-muted-foreground">
        The caret beside a finished card&apos;s forward button. One unattended run pushes the branch
        and opens its pull request, writing the title and body from the work, then the card goes
        straight to the merge stage, skipping code review.
      </p>
      <PromptRow
        id={`${stage.stageId}:${BOARD_SUBMIT_STEP_ID}`}
        label="Prompt"
        value={submit.prompt}
        defaultValue={DEFAULT_BOARD_SUBMIT_PROMPT}
        preamble={boardStepPreamble({
          card: { key: PREVIEW_CARD_KEY, title: PREVIEW_CARD_TITLE, stage: stage.stageId },
          stageLabel: stage.label,
          step: { stepLabel: BOARD_SUBMIT_STEP_LABEL },
        })}
        postamble={boardStepPostamble({
          // Machinery, and always unattended whatever the card's stance.
          humanInLoop: false,
          role: "build",
          step: { stepId: BOARD_SUBMIT_STEP_ID, stepLabel: BOARD_SUBMIT_STEP_LABEL },
        })}
        missingMessage={
          submit.prompt.trim().length === 0
            ? "A prompt is required, or the step runs with nothing to do."
            : null
        }
        onChange={(prompt) => props.onChange({ prompt })}
      />
      <ModelRow
        label="Model"
        ariaLabel="Submit for merge model"
        selection={submit.model}
        {...inheritedModelRowProps(props.stageModelName, "Pick the model this step runs on.")}
        instanceEntries={props.instanceEntries}
        getModelOptions={props.getModelOptions}
        onChange={(model) => props.onChange({ model })}
        modelOptions={submit.model?.options}
        onModelOptionsChange={(options) => {
          if (submit.model === null) return;
          props.onChange({
            model:
              options === undefined
                ? { instanceId: submit.model.instanceId, model: submit.model.model }
                : { instanceId: submit.model.instanceId, model: submit.model.model, options },
          });
        }}
        runtimeMode={effectiveBoardRuntimeMode(submit.runtimeMode, "build")}
        onRuntimeModeChange={(runtimeMode) => props.onChange({ runtimeMode })}
      />
      <NumberRow
        label="Stall timeout"
        hint="Time with no sign of life before the supervisor nudges the step."
        stepper={
          <NumberStepper
            value={msToMinutes(submit.timeoutMs)}
            min={BOARD_STEP_TIMEOUT_MIN_MINUTES}
            max={240}
            step={5}
            unit="min"
            ariaLabel="Submit stall timeout in minutes"
            onChange={(minutes) => props.onChange({ timeoutMs: minutesToMs(minutes) })}
          />
        }
      />
      <NumberRow
        label="Attempts"
        hint="Consecutive stalls before the step gives up and asks a human."
        stepper={
          <NumberStepper
            value={submit.maxAttempts}
            min={1}
            max={BOARD_STEP_MAX_ATTEMPTS_MAX}
            ariaLabel="Submit max attempts"
            onChange={(maxAttempts) => props.onChange({ maxAttempts })}
          />
        }
      />
    </>
  );
}

function ReviewStageBody(props: {
  stage: BoardStageDefinition;
  exec: BoardStageExecutionReview;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  inheritedModelName: string | null;
  updateStage: (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, exec } = props;
  const set = (patch: Partial<BoardStageExecutionReview>) =>
    props.updateStage(stage.stageId, patch as Partial<BoardStageExecution>);
  const setPhase = (phaseId: BoardReviewPhaseId, patch: Partial<BoardReviewPhaseExecution>) =>
    set({ phases: { ...exec.phases, [phaseId]: { ...exec.phases[phaseId], ...patch } } });
  // A phase with no model of its own runs on the review STAGE's model, and only
  // if that is unset on the workspace default (`resolvePhaseModel`). Name the
  // nearer one — saying "default" when the stage above actually decides would be
  // a lie the user cannot check.
  const phaseInheritedName =
    exec.model === null
      ? props.inheritedModelName
      : boardModelDisplayName(exec.model, props.getModelOptions, props.instanceEntries);

  return (
    <>
      <p className="mb-1 max-w-[62ch] text-board-12-5 leading-board-1-55 text-muted-foreground">
        A loop, not a single step: review the worktree, triage the findings, adjudicate the fixes,
        and repeat until a review pass raises no blocking findings or the round cap stops it. Each
        phase runs on its own model.
      </p>
      <ToggleRow
        label="Auto execute"
        checked={exec.autoExecute}
        ariaLabel="Auto execute this stage"
        onChange={(checked) => set({ autoExecute: checked })}
      />
      {exec.autoExecute ? (
        <>
          <NumberRow
            label="Rounds"
            hint="Stops early on a clean review pass."
            stepper={
              <NumberStepper
                value={exec.rounds}
                min={1}
                max={20}
                ariaLabel="Review rounds"
                onChange={(rounds) => set({ rounds })}
              />
            }
          />
          {/* The review loop runs unattended, so there is no human-in-the-loop gate
              to hide this behind; the reactor reads `autoAdvance` for review too. */}
          <ToggleRow
            label="Auto advance to the next stage"
            hint="On: the card moves itself on when the loop ends: a round with nothing blocking, or the round cap."
            checked={exec.autoAdvance}
            ariaLabel="Auto advance to the next stage"
            onChange={(checked) => set({ autoAdvance: checked })}
          />
          <ToggleRow
            label="Open pull requests as drafts (where available)"
            hint="Saves CI runs: full CI runs once the code review converges, not on every fix commit. Auto-merge waits for the repository's required checks."
            checked={exec.draftPullRequests}
            ariaLabel="Open pull requests as drafts"
            onChange={(checked) => set({ draftPullRequests: checked })}
          />
          {/* The loop's shape: the follow-ups are machinery with no
              settings of their own, so they show here and nowhere else. */}
          <div className="flex flex-col gap-1.5 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-board-13-5">Each round</span>
              <span className="flex-1" />
              {BOARD_REVIEW_PHASE_IDS.map((phaseId, index) => (
                <span key={phaseId} className="flex items-center gap-2">
                  {index === 0 ? null : <span className="text-xs text-muted-foreground">→</span>}
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-px pl-0.75 pr-2 text-xs font-medium">
                    <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-0.75 font-mono text-board-9-5 font-semibold text-muted-foreground">
                      {index + 1}
                    </span>
                    {BOARD_REVIEW_PHASE_LABELS[phaseId]}
                  </span>
                </span>
              ))}
            </div>
            <div className="flex items-start justify-end gap-1.5">
              <span className="text-xs text-muted-foreground">↳</span>
              {[
                { n: "2b", name: "Re-triage" },
                { n: "3b", name: "Re-adjudicate" },
              ].map((follow) => (
                <span
                  key={follow.n}
                  className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-input py-px pl-0.75 pr-2 text-board-11-5 font-medium text-muted-foreground"
                >
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-0.75 font-mono text-board-9-5 font-semibold text-muted-foreground">
                    {follow.n}
                  </span>
                  {follow.name}
                </span>
              ))}
            </div>
            <p className="m-0 max-w-[52ch] self-end text-right text-board-11-5/normal text-pretty text-muted-foreground">
              Only when the adjudicator overrules a finding, inside the same round, and they don't
              use a round. Re-triage and Re-adjudicate reuse the Triage and Adjudicate phase prompts
              and models.
            </p>
          </div>
          {BOARD_REVIEW_PHASE_IDS.map((phaseId, index) => {
            const phase = exec.phases[phaseId];
            return (
              <div key={phaseId}>
                <PhaseHeader step={index + 1} label={BOARD_REVIEW_PHASE_LABELS[phaseId]} />
                <PromptRow
                  id={`${stage.stageId}:${phaseId}`}
                  label="Prompt"
                  value={phase.prompt}
                  defaultValue={DEFAULT_BOARD_REVIEW_PHASES[phaseId].prompt}
                  // The real run wraps the step envelope around the phase envelope, and the
                  // completion sentence lives in the postamble, so the preview shows both.
                  preamble={[
                    boardStepPreamble({
                      card: {
                        key: PREVIEW_CARD_KEY,
                        title: PREVIEW_CARD_TITLE,
                        stage: stage.stageId,
                      },
                      stageLabel: stage.label,
                      step: {
                        stepId: reviewStepId(phaseId, 1),
                        stepLabel: reviewStepLabel(phaseId, 1),
                      },
                    }),
                    boardReviewPhasePreamble({ phase: phaseId, round: 1, rounds: exec.rounds }),
                  ].join("\n\n")}
                  postamble={[
                    // The draft line is the envelope's, not the
                    // user's, so it rides the preview rather than the prompt.
                    ...(boardDraftPullRequestLine({
                      draftPullRequests: exec.draftPullRequests,
                      phase: phaseId,
                    }) ?? []),
                    boardReviewPhaseProtocol({ phase: phaseId, round: 1 }),
                    boardStepPostamble({
                      // The review stage's role is fixed — `resolveBoardStageExecution`
                      // coerces this stage to the review member — and the loop
                      // always runs unattended.
                      humanInLoop: false,
                      role: "review",
                      step: {
                        stepId: reviewStepId(phaseId, 1),
                        stepLabel: reviewStepLabel(phaseId, 1),
                      },
                    }),
                  ].join("\n\n")}
                  onChange={(prompt) => setPhase(phaseId, { prompt })}
                />
                <ModelRow
                  label="Model"
                  ariaLabel={`${BOARD_REVIEW_PHASE_LABELS[phaseId]} model`}
                  selection={phase.model}
                  {...inheritedModelRowProps(
                    phaseInheritedName,
                    "Pick the model this phase runs on.",
                  )}
                  instanceEntries={props.instanceEntries}
                  getModelOptions={props.getModelOptions}
                  onChange={(model) => setPhase(phaseId, { model })}
                  modelOptions={phase.model?.options}
                  onModelOptionsChange={(options) => {
                    if (phase.model === null) return;
                    setPhase(phaseId, {
                      model:
                        options === undefined
                          ? { instanceId: phase.model.instanceId, model: phase.model.model }
                          : {
                              instanceId: phase.model.instanceId,
                              model: phase.model.model,
                              options,
                            },
                    });
                  }}
                  runtimeMode={effectiveBoardRuntimeMode(phase.runtimeMode, "build")}
                  onRuntimeModeChange={(runtimeMode) => setPhase(phaseId, { runtimeMode })}
                />
              </div>
            );
          })}
        </>
      ) : null}
    </>
  );
}

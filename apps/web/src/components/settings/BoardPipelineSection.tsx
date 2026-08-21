/**
 * Settings → Board → Pipeline (board settings redesign, after
 * `.plans/prototype/T3 Settings.dc.html`): a single bordered accordion of
 * stages — drag-handle reorder, inline rename, role key chips, collapsed-state
 * summary chips — where exactly one stage is expanded at a time.
 *
 * The per-stage body exposes only what the stage's effective role leaves
 * configurable: Planning (role `plan`) is forced read-only + human-in-the-loop
 * and Building (role `build`) forced build-mode at RESOLUTION
 * (`resolveBoardStageExecution`), so neither renders a mode or pause control
 * that could disagree with the runtime. The retired "pause when a plan
 * exists" toggle is gone with it. Roleless stages keep the capability behind
 * a clearer control — "Agent can edit the card's worktree" writes `mode`.
 *
 * Each prompt renders between its system Preamble / Postamble — composed by
 * the SAME contracts functions the server runs (`boardEnvelope.ts`), with
 * `{{card-key}}` placeholders where a run interpolates card identity — so
 * what the user reads here is exactly what wraps their prompt at run time.
 */
import {
  BOARD_REVIEW_PHASE_IDS,
  BOARD_REVIEW_PHASE_LABELS,
  BOARD_SEED_STAGES,
  BoardStageId,
  boardReviewPhasePreamble,
  boardReviewPhaseProtocol,
  boardStagesInOrder,
  boardStepPostamble,
  boardStepPreamble,
  effectiveBoardStageRole,
  isBoardReviewStageExecution,
  resolveBoardStageExecution,
  type BoardReviewPhaseExecution,
  type BoardReviewPhaseId,
  type BoardStageDefinition,
  type BoardStageExecution,
  type BoardStageExecutionReview,
  type BoardStageRole,
  type BoardState,
  type EnvironmentId,
  type ProviderInstanceId,
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
import {
  ChevronDownIcon,
  GripVerticalIcon,
  LockIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { primaryServerProvidersAtom } from "../../state/server";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { cn, randomUUID } from "../../lib/utils";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  minutesToMs,
  msToMinutes,
  parsePositiveIntInput,
  setBoardStageExecution,
} from "./BoardSettingsPanel.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsSection } from "./settingsLayout";

type ModelSelectionState = ReturnType<typeof resolveAppModelSelectionState>;
type InstanceEntries = ReturnType<typeof sortProviderInstanceEntries>;
type ModelOptionsByInstance = ReturnType<typeof getCustomModelOptionsByInstance>;
type ActiveModel = { instanceId: ProviderInstanceId; model: string };
type ModelSelection = ActiveModel | null;

/** The stand-in card identity for envelope previews: a run interpolates the
    real card, so the preview shows placeholders where values vary per card. */
const PREVIEW_CARD_KEY = "{{card-key}}";
const PREVIEW_CARD_TITLE = "{{card title}}";

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
        <span className="text-[13.5px] text-foreground">{props.label}</span>
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

/** The prototype's −/value/+ number control, shared by rounds, timeouts,
    attempts and the restyled concurrency / lifecycle rows. */
export function NumberStepper(props: {
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const step = props.step ?? 1;
  const clamp = (value: number) => Math.max(props.min, Math.min(props.max, value));
  return (
    <div className="flex h-8 shrink-0 items-center overflow-hidden rounded-lg border border-input bg-popover shadow-xs">
      <button
        type="button"
        aria-label={`Decrease ${props.ariaLabel}`}
        className="flex h-full w-8 items-center justify-center border-r border-border text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => props.onChange(clamp(props.value - step))}
      >
        <MinusIcon className="size-3.5" />
      </button>
      <Input
        key={`${props.ariaLabel}:${props.value}`}
        type="number"
        inputMode="numeric"
        defaultValue={String(props.value)}
        aria-label={props.ariaLabel}
        className="h-full w-14 rounded-none border-none bg-transparent text-center text-sm font-medium shadow-none focus-visible:ring-0"
        onBlur={(event) => {
          const parsed = parsePositiveIntInput(event.target.value, props.value);
          props.onChange(clamp(parsed));
        }}
      />
      {props.unit ? <span className="pr-2 text-xs text-muted-foreground">{props.unit}</span> : null}
      <button
        type="button"
        aria-label={`Increase ${props.ariaLabel}`}
        className="flex h-full w-8 items-center justify-center border-l border-border text-muted-foreground hover:bg-accent hover:text-foreground"
        onClick={() => props.onChange(clamp(props.value + step))}
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
        <span className="text-[13.5px] text-foreground">{props.label}</span>
        {props.hint ? <span className="text-xs text-muted-foreground">{props.hint}</span> : null}
      </div>
      {props.stepper}
    </div>
  );
}

/** A collapsible, read-only system prompt block (lock + "system" tag): the
    envelope text the server composes around the editable prompt. */
function SystemPromptDisclosure(props: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 py-1.5 text-left text-[11.5px] font-medium text-muted-foreground hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <LockIcon className="size-3 shrink-0" />
        <span>{props.label}</span>
        <span className="font-normal text-muted-foreground/70">system</span>
        <span className="flex-1" />
        <ChevronDownIcon
          className={cn("size-3.5 shrink-0 transition-transform", open ? "" : "-rotate-90")}
        />
      </button>
      {open ? (
        <p className="my-0 ml-[5px] whitespace-pre-wrap border-l-2 border-border py-1 pl-4 pr-2 font-mono text-xs leading-relaxed text-muted-foreground">
          {props.text}
        </p>
      ) : null}
    </div>
  );
}

/** The prompt row: system preamble, the editable body (read view clamps to a
    few lines with a fade + "See more"; Edit swaps in a textarea), the system
    postamble, and a word count. */
function PromptRow(props: {
  id: string;
  label: string;
  value: string;
  preamble: string;
  postamble: string;
  missingMessage?: string | null;
  onChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const clipped = !expanded && !editing && props.value.length > 190;
  const words = props.value.trim().length > 0 ? props.value.trim().split(/\s+/).length : 0;
  return (
    <div className="flex flex-col gap-1.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[13.5px] text-foreground">{props.label}</span>
        <span className="flex-1" />
        <Button
          size="xs"
          variant={editing ? "outline" : "ghost"}
          className={cn(
            "h-6 gap-1 px-2 text-xs",
            editing ? "border-primary text-primary" : "text-muted-foreground",
          )}
          aria-label={
            editing
              ? `Stop editing ${props.label.toLowerCase()}`
              : `Edit ${props.label.toLowerCase()}`
          }
          onClick={() => setEditing((current) => !current)}
        >
          <PencilIcon className="size-3" />
          {editing ? "Editing" : "Edit"}
        </Button>
      </div>

      <SystemPromptDisclosure label="Preamble" text={props.preamble} />

      {editing ? (
        <Textarea
          key={`prompt:${props.id}`}
          defaultValue={props.value}
          aria-label={`${props.label} text`}
          rows={Math.min(16, Math.max(4, props.value.split("\n").length + 2))}
          className="border-primary"
          onBlur={(event) => {
            if (event.target.value !== props.value) props.onChange(event.target.value);
          }}
        />
      ) : (
        <button
          type="button"
          className="relative cursor-text text-left"
          title="Click to edit"
          onClick={() => setEditing(true)}
        >
          <div
            className={cn(
              "whitespace-pre-wrap text-[13px] leading-relaxed text-foreground",
              expanded ? "" : "max-h-16 overflow-hidden",
            )}
          >
            {props.value.trim().length > 0 ? (
              props.value
            ) : (
              <span className="text-muted-foreground/70">No prompt yet — click to write one.</span>
            )}
          </div>
          {clipped ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-linear-to-b from-transparent to-card" />
          ) : null}
        </button>
      )}

      <div className="flex items-center gap-3">
        {!editing && (props.value.length > 190 || expanded) ? (
          <button
            type="button"
            className="text-xs font-medium text-info-foreground hover:underline"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "See less" : "See more"}
          </button>
        ) : null}
        {editing ? (
          <button
            type="button"
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setEditing(false)}
          >
            Done
          </button>
        ) : null}
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-muted-foreground">{words} words</span>
      </div>
      {props.missingMessage ? (
        <p className="text-xs text-destructive">{props.missingMessage}</p>
      ) : null}

      <SystemPromptDisclosure label="Postamble" text={props.postamble} />
    </div>
  );
}

/** The model row: the app's instance+model picker with an explicit Default
    (null → follows the global text-generation model) state. Picking a model
    stores an override; the reset affordance clears back to Default. */
function ModelRow(props: {
  label: string;
  ariaLabel: string;
  selection: ModelSelection;
  globalDefault: ModelSelectionState;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  onChange: (selection: ModelSelection) => void;
}) {
  const active = props.selection ?? {
    instanceId: props.globalDefault.instanceId,
    model: props.globalDefault.model,
  };
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="text-[13.5px] text-foreground">{props.label}</span>
      <div className="flex items-center gap-1.5">
        {props.selection === null ? (
          <span className="text-xs text-muted-foreground">Default</span>
        ) : (
          <SettingResetButton label={props.ariaLabel} onClick={() => props.onChange(null)} />
        )}
        <ProviderModelPicker
          activeInstanceId={active.instanceId}
          model={active.model}
          lockedProvider={null}
          instanceEntries={props.instanceEntries}
          modelOptionsByInstance={props.getModelOptions(active)}
          triggerVariant="outline"
          triggerAriaLabel={props.ariaLabel}
          onInstanceModelChange={(instanceId, model) => props.onChange({ instanceId, model })}
        />
      </div>
    </div>
  );
}

/** The numbered review-phase divider from the prototype. */
function PhaseHeader(props: { step: number; label: string }) {
  return (
    <div className="mt-3 mb-0.5 flex items-center gap-2">
      <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-border bg-muted font-mono text-[10.5px] font-semibold text-muted-foreground">
        {props.step}
      </span>
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-foreground">
        {props.label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// ── stage rows ─────────────────────────────────────────────────────────

function StageChip(props: { text: string; tone: "auto" | "quiet" }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full border px-2 py-px text-[11px] font-medium",
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

/** Client mirror of the decider's spine invariant (build before review, done
    last): an order that violates it is refused server-side, so don't offer it. */
function orderKeepsSpine(stages: ReadonlyArray<BoardStageDefinition>): boolean {
  const buildIndex = stages.findIndex((stage) => effectiveBoardStageRole(stage) === "build");
  const reviewIndex = stages.findIndex((stage) => effectiveBoardStageRole(stage) === "review");
  const doneIndex = stages.findIndex((stage) => effectiveBoardStageRole(stage) === "done");
  if (buildIndex >= 0 && reviewIndex >= 0 && buildIndex >= reviewIndex) return false;
  if (doneIndex >= 0 && doneIndex !== stages.length - 1) return false;
  return true;
}

export function BoardPipelineSection() {
  const board = usePrimarySettings((settings) => settings.board);
  const update = useUpdatePrimarySettings();
  const anchor = searchableSetting("board-pipeline");
  const environmentId = usePrimaryEnvironmentId();
  const stageList = useAtomValue(
    boardEnvironment.stageListAtom(environmentId ?? ("" as EnvironmentId)),
  );
  const stages = stageList.length > 0 ? stageList : BOARD_SEED_STAGES;
  const ordered = boardStagesInOrder(stageBoardState(stages));

  const createStage = useAtomCommand(boardEnvironment.createStage);
  const renameStage = useAtomCommand(boardEnvironment.renameStage);
  const reorderStage = useAtomCommand(boardEnvironment.reorderStage);
  const deleteStage = useAtomCommand(boardEnvironment.deleteStage);

  const [openStageId, setOpenStageId] = useState<string | null>(null);

  // ProviderModelPicker context (shared across every stage row).
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const globalDefault = resolveAppModelSelectionState(settings, serverProviders);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const getModelOptions = (active: ActiveModel) =>
    getCustomModelOptionsByInstance(settings, serverProviders, active.instanceId, active.model);

  const crudEnabled = environmentId !== null;

  const updateStage = (stageId: string, patch: Partial<BoardStageExecution>) => {
    update({ board: { pipeline: setBoardStageExecution(board.pipeline, stageId, patch) } });
  };

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

  // A new stage lands immediately before the done-role stage (the prototype's
  // "Add stage" behavior); with no done holder it appends.
  const onAddStage = () => {
    if (environmentId === null) return;
    const doneIndex = ordered.findIndex((stage) => effectiveBoardStageRole(stage) === "done");
    const before = doneIndex === -1 ? ordered[ordered.length - 1] : ordered[doneIndex - 1];
    const after = doneIndex === -1 ? undefined : ordered[doneIndex];
    const orderKey = pinOrderKeyBetween(before?.orderKey ?? null, after?.orderKey ?? null);
    if (orderKey === null) return;
    const stageId = BoardStageId.make(randomUUID());
    setOpenStageId(stageId);
    void createStage({ environmentId, input: { stageId, label: "New stage", orderKey } });
  };

  return (
    <SettingsSection id="board-pipeline" title={anchor.title}>
      <p className="max-w-xl px-3 text-[13px] leading-[1.55] text-muted-foreground/80 sm:px-4">
        Each stage runs a single agent step. A card freezes its stage config the moment it enters
        the stage, so edits take effect the next time a card enters, never mid-flight.
      </p>
      {!crudEnabled ? (
        <p className="px-3 text-xs text-muted-foreground/70 sm:px-4">
          Connect an environment to add, rename, reorder, or delete stages.
        </p>
      ) : null}
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
                expanded={openStageId === stage.stageId}
                crudEnabled={crudEnabled}
                globalDefault={globalDefault}
                instanceEntries={instanceEntries}
                getModelOptions={getModelOptions}
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
        <button
          type="button"
          disabled={!crudEnabled}
          className="flex w-full items-center gap-2 px-5 py-3 text-left text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={onAddStage}
        >
          <PlusIcon className="size-3.5" />
          Add stage
        </button>
      </div>
    </SettingsSection>
  );
}

function StageAccordionRow(props: {
  stage: BoardStageDefinition;
  index: number;
  exec: BoardStageExecution;
  expanded: boolean;
  crudEnabled: boolean;
  globalDefault: ModelSelectionState;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  onToggle: () => void;
  onRename: (label: string) => void;
  onDelete: () => void;
  updateStage: (stageId: string, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, exec, expanded } = props;
  const role = effectiveBoardStageRole(stage);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: stage.stageId,
  });

  const isReview = isBoardReviewStageExecution(exec);
  const chips: ReadonlyArray<{ text: string; tone: "auto" | "quiet" }> = expanded
    ? []
    : [
        exec.autoExecute
          ? { text: "Auto", tone: "auto" as const }
          : { text: "Manual", tone: "quiet" as const },
        ...(exec.autoExecute && isReview
          ? [{ text: `${exec.rounds} rounds`, tone: "quiet" as const }]
          : []),
        ...(exec.autoExecute && !isReview && role !== "plan"
          ? [{ text: `${msToMinutes(exec.timeoutMs)} min`, tone: "quiet" as const }]
          : []),
      ];

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
          disabled={!props.crudEnabled}
          onClick={(event) => event.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVerticalIcon className="size-3.5" />
        </button>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-accent font-mono text-[11px] font-semibold text-muted-foreground">
          {props.index + 1}
        </span>
        <Input
          key={`name:${stage.stageId}:${stage.label}`}
          defaultValue={stage.label}
          aria-label="Stage name"
          disabled={!props.crudEnabled}
          className="-ml-1.5 h-7 w-40 border-transparent bg-transparent text-sm font-medium shadow-none hover:border-border hover:bg-popover focus-visible:border-primary focus-visible:bg-popover"
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => props.onRename(event.target.value.trim())}
        />
        {role !== null && role !== "done" ? (
          <span className="shrink-0 rounded-md bg-accent px-1.5 py-px font-mono text-[11px] font-medium text-muted-foreground">
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
        <div className="flex flex-col px-4 pb-4 pt-0.5 sm:pl-[52px] sm:pr-5">
          {isReview ? (
            <ReviewStageBody
              stage={stage}
              exec={exec}
              globalDefault={props.globalDefault}
              instanceEntries={props.instanceEntries}
              getModelOptions={props.getModelOptions}
              updateStage={props.updateStage}
            />
          ) : (
            <SimpleStageBody
              stage={stage}
              role={role}
              exec={exec}
              globalDefault={props.globalDefault}
              instanceEntries={props.instanceEntries}
              getModelOptions={props.getModelOptions}
              updateStage={props.updateStage}
            />
          )}
          {role === null ? (
            <div className="flex items-center pt-3">
              <Button
                size="xs"
                variant="outline"
                disabled={!props.crudEnabled}
                className="gap-1.5 text-destructive-foreground hover:bg-destructive/10"
                onClick={props.onDelete}
              >
                <Trash2Icon className="size-3.5" />
                Remove stage
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Every non-review stage body. The rows a stage exposes follow its effective
    role: `plan` is forced read-only + human-in-the-loop (no mode / pause /
    ceiling rows), `build` runs the worktree unattended-with-plan (no worktree
    or generic pause rows), and a roleless stage keeps the full set behind the
    clearer worktree-access toggle. */
function SimpleStageBody(props: {
  stage: BoardStageDefinition;
  role: BoardStageRole | null;
  exec: Exclude<BoardStageExecution, BoardStageExecutionReview>;
  globalDefault: ModelSelectionState;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  updateStage: (stageId: string, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, role, exec } = props;
  const set = (patch: Partial<BoardStageExecution>) => props.updateStage(stage.stageId, patch);

  // What the envelope will actually do on this stage's common path: Planning
  // is forced human-in-the-loop, Building runs unattended (the with-plan pause
  // is retired), a roleless stage follows its own toggle.
  const previewHumanInLoop = role === "plan" ? true : role === "build" ? false : exec.humanInLoop;
  const previewInstanceId = exec.model?.instanceId ?? props.globalDefault.instanceId;
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
            preamble={boardStepPreamble({
              card: { key: PREVIEW_CARD_KEY, title: PREVIEW_CARD_TITLE, stage: stage.label },
              step: { stepLabel: stage.label, maxAttempts: exec.maxAttempts },
              attempt: 1,
            })}
            postamble={boardStepPostamble({
              humanInLoop: previewHumanInLoop,
              providerInstanceId: previewInstanceId,
              role,
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
            globalDefault={props.globalDefault}
            instanceEntries={props.instanceEntries}
            getModelOptions={props.getModelOptions}
            onChange={(model) => set({ model })}
          />
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
            <ToggleRow
              label="Pause for a human when no plan exists"
              checked={exec.humanInLoopWithoutPlan}
              ariaLabel="Human in the loop when no plan exists"
              onChange={(checked) => set({ humanInLoopWithoutPlan: checked })}
            />
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
                label="Timeout"
                stepper={
                  <NumberStepper
                    value={msToMinutes(exec.timeoutMs)}
                    min={5}
                    max={240}
                    step={5}
                    unit="min"
                    ariaLabel="Timeout in minutes"
                    onChange={(minutes) => set({ timeoutMs: minutesToMs(minutes) })}
                  />
                }
              />
              <NumberRow
                label="Attempts"
                stepper={
                  <NumberStepper
                    value={exec.maxAttempts}
                    min={1}
                    max={20}
                    ariaLabel="Max attempts"
                    onChange={(maxAttempts) => set({ maxAttempts })}
                  />
                }
              />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function ReviewStageBody(props: {
  stage: BoardStageDefinition;
  exec: BoardStageExecutionReview;
  globalDefault: ModelSelectionState;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  updateStage: (stageId: string, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, exec } = props;
  const set = (patch: Partial<BoardStageExecutionReview>) =>
    props.updateStage(stage.stageId, patch as Partial<BoardStageExecution>);
  const setPhase = (phaseId: BoardReviewPhaseId, patch: Partial<BoardReviewPhaseExecution>) =>
    set({ phases: { ...exec.phases, [phaseId]: { ...exec.phases[phaseId], ...patch } } });

  return (
    <>
      <p className="mb-1 max-w-[62ch] text-[12.5px] leading-[1.55] text-muted-foreground">
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
          {BOARD_REVIEW_PHASE_IDS.map((phaseId, index) => {
            const phase = exec.phases[phaseId];
            return (
              <div key={phaseId}>
                <PhaseHeader step={index + 1} label={BOARD_REVIEW_PHASE_LABELS[phaseId]} />
                <PromptRow
                  id={`${stage.stageId}:${phaseId}`}
                  label="Prompt"
                  value={phase.prompt}
                  preamble={boardReviewPhasePreamble({
                    phase: phaseId,
                    round: 1,
                    rounds: exec.rounds,
                  })}
                  postamble={boardReviewPhaseProtocol({ phase: phaseId, round: 1 })}
                  onChange={(prompt) => setPhase(phaseId, { prompt })}
                />
                <ModelRow
                  label="Model"
                  ariaLabel={`${BOARD_REVIEW_PHASE_LABELS[phaseId]} model`}
                  selection={phase.model}
                  globalDefault={props.globalDefault}
                  instanceEntries={props.instanceEntries}
                  getModelOptions={props.getModelOptions}
                  onChange={(model) => setPhase(phaseId, { model })}
                />
              </div>
            );
          })}
        </>
      ) : null}
    </>
  );
}

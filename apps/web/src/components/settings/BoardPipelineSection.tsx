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
  DEFAULT_BOARD_BUILD_PROMPT,
  DEFAULT_BOARD_PLANNING_PROMPT,
  DEFAULT_BOARD_REVIEW_PHASES,
  boardReviewPhasePreamble,
  boardReviewPhaseProtocol,
  reviewStepId,
  reviewStepLabel,
  boardStagesInOrder,
  boardStepPostamble,
  boardStepPreamble,
  effectiveBoardRuntimeMode,
  effectiveBoardStageRole,
  DEFAULT_BOARD_MERGE_CONFLICT_PROMPT,
  isBoardMergeStageExecution,
  isBoardReviewStageExecution,
  ProviderInstanceId,
  resolveBoardStageExecution,
  type BoardReviewPhaseExecution,
  type BoardReviewPhaseId,
  type BoardStageDefinition,
  type BoardStageExecution,
  type BoardStageExecutionMerge,
  type BoardStageExecutionReview,
  type BoardStageRole,
  type ProviderOptionSelection,
  type RuntimeMode,
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
import {
  ChevronDownIcon,
  GripVerticalIcon,
  MinusIcon,
  PencilIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

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
import { getCustomModelOptionsByInstance } from "../../modelSelection";
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
import { AccessLevelPicker } from "../chat/AccessLevelPicker";
import { ModelPickerContent } from "../chat/ModelPickerContent";
import { TraitsPicker } from "../chat/TraitsPicker";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
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

type InstanceEntries = ReturnType<typeof sortProviderInstanceEntries>;
type ModelOptionsByInstance = ReturnType<typeof getCustomModelOptionsByInstance>;
type ActiveModel = { instanceId: ProviderInstanceId; model: string };
type ModelSelection = ActiveModel | null;

/** The stand-in card identity for envelope previews: a run interpolates the
    real card, so the preview shows placeholders where values vary per card. */
const PREVIEW_CARD_KEY = "{{card-key}}";
const PREVIEW_CARD_TITLE = "{{card title}}";

/** Only reached when the server reports no provider instances at all; the
    picker then has nothing to list, and the trigger still reads "Select a
    model". */
const EMPTY_INSTANCE_ID = ProviderInstanceId.make("none");

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
    attempts and the concurrency rows.

    The field is a plain `<input>`, not the shared `Input`: that component puts
    the class list on a bordered wrapper span and keeps the real element out of
    reach, so neither the stepper's own chrome nor the `appearance` reset that
    hides the browser's native spin buttons (redundant beside −/+, and they
    crowd the value) could be applied to it. The value is controlled with a
    free-text draft so typing is never fought, and the draft is dropped the
    moment −/+ writes a new value — an uncontrolled field would keep showing
    what the user last typed.

    A `nullable` stepper also carries an unset state — per-instance concurrency
    means "no override", not zero — shown as `placeholder` and reached by
    clearing the field. −/+ never lands back on it: from unset they step off
    `stepFrom`, the value the unset state actually resolves to (the global
    limit), so the first nudge continues from what the user sees rather than
    from the minimum. */
type NumberStepperCommon = {
  min: number;
  max: number;
  step?: number;
  unit?: string;
  ariaLabel: string;
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
        <span className="text-[13.5px] text-foreground">{props.label}</span>
        {props.hint ? <span className="text-xs text-muted-foreground">{props.hint}</span> : null}
      </div>
      {props.stepper}
    </div>
  );
}

/** One side of the system envelope, rendered inline above or below the
    editable body: the text the server composes around the prompt, tagged
    "System" so it reads as chrome rather than something the user can type in.
    Empty envelopes (a phase with no postamble, say) render nothing at all
    rather than an empty grey band. */
function SystemEnvelope(props: { text: string; edge: "top" | "bottom"; label: string }) {
  if (props.text.trim().length === 0) return null;
  return (
    <div
      className={cn(
        "relative bg-muted py-2.5 pr-[74px] pl-3.5 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground",
        props.edge === "bottom" ? "border-b border-border" : "border-t border-border",
      )}
      // A named note, not bare text: the visible "System" pill says what the
      // band is, and the role gives the name somewhere valid to live for a
      // screen reader that lands here between the prompt's two halves.
      role="note"
      aria-label={`${props.label} (system)`}
    >
      {props.text}
      <span className="absolute top-2 right-2.5 rounded-full border border-border bg-card px-1.5 py-px font-sans text-[10.5px] font-medium text-muted-foreground">
        System
      </span>
    </div>
  );
}

/**
 * The prompt row, laid out as the single document a run actually sends:
 * system preamble, the editable body, system postamble — one bordered card,
 * read top to bottom, so the envelope is visible in place instead of hidden
 * behind a disclosure the user has to open to see what wraps their words.
 *
 * The body is the only editable band: clicking it (or Edit) swaps in a
 * textarea. While editing, the text is a local `draft` committed to the store
 * on blur — the same commit-on-blur pattern the number steppers use — so
 * typing never writes settings per keystroke and Reset can rewrite the field
 * in place without a remount race. The whole document clamps to a few hundred
 * pixels with a fade + "See more" so a long envelope cannot push the rest of
 * the stage off screen.
 *
 * When `defaultValue` is given, a prompt that differs from it is "Modified":
 * the badge shows while reading, and while editing it becomes a Reset control
 * (confirmed by a modal, since a reset discards the user's prompt text).
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
  // Clipping is MEASURED, not guessed from character count: a short prompt
  // with many lines overflows the clamp just as a long single-line one does,
  // and a silent cut with no fade or "See more" would hide content. The
  // measurement is on the document, not the body, because the envelope shares
  // the same clamp.
  const documentRef = useRef<HTMLDivElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const clamped = !editing && !expanded;
  useLayoutEffect(() => {
    const element = documentRef.current;
    if (element === null || !clamped) {
      setClipped(false);
      return;
    }
    setClipped(element.scrollHeight > element.clientHeight + 1);
  }, [props.value, props.preamble, props.postamble, clamped]);

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
        <span className="text-[13.5px] text-foreground">{props.label}</span>
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
              <span className="font-mono text-[11px] text-muted-foreground">Modified</span>
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
            className="block w-full [&_textarea]:resize-y [&_textarea]:bg-card [&_textarea]:px-3.5 [&_textarea]:py-3 [&_textarea]:text-[13px] [&_textarea]:leading-relaxed [&_textarea]:text-foreground"
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
          <button
            type="button"
            className="block w-full cursor-text px-3.5 py-3 text-left text-[13px] leading-relaxed whitespace-pre-wrap text-foreground"
            title="Click to edit"
            onClick={startEditing}
          >
            {props.value.trim().length > 0 ? (
              props.value
            ) : (
              <span className="text-muted-foreground/70">No prompt yet — click to write one.</span>
            )}
          </button>
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
        <span className="font-mono text-[11px] text-muted-foreground">{words} words editable</span>
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

/**
 * The model row. A stage names the model it runs on EXPLICITLY — there is no
 * "Default" state to fall into, because the board never had a default worth
 * advertising: the old one was a compiled-in codex + `gpt-5.6-luna` pair the
 * user may never have enabled, so "Default" named a model that could not run.
 * An unset stage reads "Select a model" and, while the stage auto-executes,
 * says so in the same required-field language the prompt uses.
 *
 * The trigger is local rather than `ProviderModelPicker`'s, which always
 * renders a concrete model name (falling back to the instance's first option)
 * and so cannot show "nothing picked yet". The popup is the app's own
 * `ModelPickerContent`, so the list, search and favourites are identical.
 */
function ModelRow(props: {
  label: string;
  ariaLabel: string;
  selection: ModelSelection;
  requiredMessage?: string | null;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  onChange: (selection: ModelSelection) => void;
  /** Reasoning/effort selections for the chosen model, and the setter (t3o-21).
      Rendered as the composer's TraitsPicker; hidden when no model is picked. */
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  onModelOptionsChange: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
  /** The stage/phase agent authority (t3o-21) — the user's, on the same row as
      the model, exactly like the chat composer. */
  runtimeMode: RuntimeMode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const [open, setOpen] = useState(false);
  // With nothing picked the popup still needs an instance to open on: use the
  // first available one, with an empty model so no row reads as selected.
  const firstEntry = props.instanceEntries.find((entry) => entry.enabled && entry.isAvailable);
  const active: ActiveModel = props.selection ?? {
    instanceId: firstEntry?.instanceId ?? props.instanceEntries[0]?.instanceId ?? EMPTY_INSTANCE_ID,
    model: "",
  };
  const modelOptions = props.getModelOptions(active);
  const activeEntry =
    props.selection === null
      ? null
      : (props.instanceEntries.find((entry) => entry.instanceId === active.instanceId) ?? null);
  const selectedOption = modelOptions
    .get(active.instanceId)
    ?.find((option) => option.slug === active.model);
  const triggerLabel =
    props.selection === null
      ? "Select a model"
      : selectedOption
        ? getTriggerDisplayModelName(selectedOption)
        : active.model;

  return (
    <div className="flex flex-col gap-1 py-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-[13.5px] text-foreground">{props.label}</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={props.ariaLabel}
                  className="max-w-56 justify-between gap-1.5"
                />
              }
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {activeEntry ? (
                  <ProviderInstanceIcon
                    driverKind={activeEntry.driverKind}
                    displayName={activeEntry.displayName}
                    accentColor={activeEntry.accentColor}
                    showBadge={Boolean(activeEntry.accentColor)}
                    className="size-4"
                    iconClassName="size-4"
                    indicatorBackground="var(--input)"
                  />
                ) : null}
                <span
                  className={cn(
                    "truncate",
                    props.selection === null ? "text-muted-foreground" : "",
                  )}
                >
                  {triggerLabel}
                </span>
              </span>
              <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
            </PopoverTrigger>
            <PopoverPopup
              align="end"
              className="border-0 bg-transparent p-0 shadow-none before:hidden [-webkit-backdrop-filter:none]! [--viewport-inline-padding:0] [backdrop-filter:none]!"
              viewportClassName="rounded-lg !overflow-hidden p-0"
            >
              <ModelPickerContent
                activeInstanceId={active.instanceId}
                model={active.model}
                lockedProvider={null}
                lockedContinuationGroupKey={null}
                instanceEntries={props.instanceEntries}
                modelOptionsByInstance={modelOptions}
                terminalOpen={false}
                onRequestClose={() => setOpen(false)}
                onInstanceModelChange={(instanceId, model) => {
                  props.onChange({ instanceId, model });
                  setOpen(false);
                }}
              />
            </PopoverPopup>
          </Popover>
          {props.selection !== null && activeEntry !== null ? (
            <TraitsPicker
              provider={activeEntry.driverKind}
              models={activeEntry.models}
              model={active.model}
              prompt=""
              onPromptChange={() => {}}
              modelOptions={props.modelOptions}
              allowPromptInjectedEffort={false}
              triggerVariant="outline"
              triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
              onModelOptionsChange={props.onModelOptionsChange}
            />
          ) : null}
          <AccessLevelPicker
            value={props.runtimeMode}
            onChange={props.onRuntimeModeChange}
            ariaLabel={`${props.ariaLabel} access level`}
            triggerClassName="rounded-lg border border-input bg-popover shadow-xs"
          />
        </div>
      </div>
      {props.selection === null && props.requiredMessage ? (
        <p className="text-xs text-destructive">{props.requiredMessage}</p>
      ) : null}
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

/**
 * A stage's name: plain text that becomes a field only once you click it.
 *
 * Rendering every name in a permanent text box drew a border and a drop shadow
 * around each one and reserved a fixed-width well, which shoved the role chip
 * far off the name it labels. Text sized to its content keeps the chip beside
 * the name, and the box appears exactly when it means something — you are
 * typing in it.
 */
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
      <button
        type="button"
        title="Click to rename"
        className="min-w-0 shrink-0 cursor-text truncate rounded-md px-1 py-0.5 text-left text-sm font-medium text-foreground hover:bg-popover hover:inset-ring hover:inset-ring-border"
        onClick={(event) => {
          event.stopPropagation();
          setEditing(true);
        }}
      >
        {props.label}
      </button>
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
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );
  const getModelOptions = (active: ActiveModel) =>
    getCustomModelOptionsByInstance(settings, serverProviders, active.instanceId, active.model);

  const crudEnabled = environmentId !== null;

  const updateStage = (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => {
    update({ board: { pipeline: setBoardStageExecution(board, stageId, patch) } });
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
        Each stage runs one agent, except code review, which runs a review loop. A card freezes its
        stage config the moment it enters the stage, so edits take effect the next time a card
        enters, never mid-flight.
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
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
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
  const chips: ReadonlyArray<{ text: string; tone: "auto" | "quiet" }> = expanded
    ? []
    : isMerge
      ? [
          // "Manual" is true of this stage but says nothing: it is manual by
          // design and cannot be otherwise. What the reader wants at a glance
          // is what the Merge button will do and whether branches get tidied.
          { text: exec.strategy, tone: "quiet" as const },
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
        <StageNameField
          key={`name:${stage.stageId}:${stage.label}`}
          label={stage.label}
          editable={props.crudEnabled}
          onRename={props.onRename}
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
              instanceEntries={props.instanceEntries}
              getModelOptions={props.getModelOptions}
              updateStage={props.updateStage}
            />
          ) : isMerge ? (
            <MergeStageBody
              stage={stage}
              exec={exec}
              instanceEntries={props.instanceEntries}
              getModelOptions={props.getModelOptions}
              updateStage={props.updateStage}
            />
          ) : (
            <SimpleStageBody
              stage={stage}
              role={role}
              exec={exec}
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

/**
 * The merge-role stage's body.
 *
 * Deliberately short, and deliberately WITHOUT an "Auto execute" row: nothing
 * in this stage runs on entry. Merging is always a human click, and the only
 * agent this stage ever starts is the conflict-resolution step — started by a
 * merge that was refused for conflicts, never by a card arriving here.
 */
function MergeStageBody(props: {
  stage: BoardStageDefinition;
  exec: BoardStageExecutionMerge;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  updateStage: (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => void;
}) {
  const { stage, exec } = props;
  const set = (patch: Partial<BoardStageExecution>) => props.updateStage(stage.stageId, patch);

  return (
    <>
      <div className="flex items-center justify-between gap-4 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="text-[13.5px] text-foreground">Merge strategy</span>
          <span className="text-xs text-muted-foreground">
            How the Merge button integrates the card&apos;s pull request.
          </span>
        </div>
        <select
          aria-label="Merge strategy"
          className="h-8 shrink-0 rounded-md border border-input bg-popover px-2 text-[13px] text-foreground"
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
          // (t3o-19, D4) and the preview shows no `Step:` line.
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
        requiredMessage="Pick the model conflict resolution runs on."
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

/** Every non-review stage body. The rows a stage exposes follow its effective/** Every non-review stage body. The rows a stage exposes follow its effective
    role: `plan` is forced read-only + human-in-the-loop (no mode / pause /
    ceiling rows), `build` runs the worktree unattended-with-plan (no worktree
    or generic pause rows), and a roleless stage keeps the full set behind the
    clearer worktree-access toggle. */
function SimpleStageBody(props: {
  stage: BoardStageDefinition;
  role: BoardStageRole | null;
  exec: Exclude<BoardStageExecution, BoardStageExecutionReview>;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
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
              // (t3o-19, D4) and the preview shows no `Step:` line — exactly
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
            requiredMessage="Pick the model this stage runs on."
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
                label="Stall timeout"
                hint="Time with no sign of life — no todo-list progress, no new commit — before the supervisor nudges the step. Not a cap on total run time: a build that keeps working never trips it."
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
    </>
  );
}

function ReviewStageBody(props: {
  stage: BoardStageDefinition;
  exec: BoardStageExecutionReview;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  updateStage: (stageId: BoardStageId, patch: Partial<BoardStageExecution>) => void;
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
                  defaultValue={DEFAULT_BOARD_REVIEW_PHASES[phaseId].prompt}
                  // A review phase's real run is the step envelope wrapped
                  // around the phase envelope (the executor composes the phase
                  // prompt, and the reactor then wraps THAT). The preview
                  // reproduces both layers so the user sees the whole thing —
                  // and since t3o-19 D6 moved the completion sentence out of
                  // the protocol and into the postamble, showing only the
                  // phase layer would hide the completion contract entirely.
                  preamble={[
                    boardStepPreamble({
                      card: {
                        key: PREVIEW_CARD_KEY,
                        title: PREVIEW_CARD_TITLE,
                        stage: stage.stageId,
                      },
                      stageLabel: stage.label,
                      step: { stepLabel: reviewStepLabel(phaseId, 1) },
                    }),
                    boardReviewPhasePreamble({ phase: phaseId, round: 1, rounds: exec.rounds }),
                  ].join("\n\n")}
                  postamble={[
                    boardReviewPhaseProtocol({ phase: phaseId, round: 1 }),
                    boardStepPostamble({
                      // The review stage's role is fixed — `resolveBoardStageExecution`
                      // coerces this stage to the review member — and the loop
                      // always runs unattended (D2/D6).
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
                  requiredMessage="Pick the model this phase runs on."
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

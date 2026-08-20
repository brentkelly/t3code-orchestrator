/**
 * Settings → Board (t3o-15, D4). Per-stage execution config (auto-execute,
 * prompt, model, mode, human-in-the-loop, auto-advance, timeout, attempts),
 * stage CRUD (create / rename / reorder / delete), plus per-project card
 * identity, concurrency ceilings and lifecycle windows. Execution config and
 * project edits reach the decider / reactor, so the panel reads and writes
 * through `usePrimarySettings` / `useUpdatePrimarySettings`; stage CRUD is a
 * board command dispatched through the environment.
 *
 * The pipeline is keyed by STAGE ID, so a rename never orphans a stage's config.
 * A stage's resolved config is frozen onto the card at stage entry (D12), so a
 * mid-flight edit here takes effect only on the next entry, never on a running
 * card.
 */
import {
  BOARD_REVIEW_PHASE_IDS,
  BOARD_REVIEW_PHASE_LABELS,
  BOARD_SEED_STAGES,
  BoardStageId,
  DEFAULT_BOARD_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT,
  DEFAULT_BOARD_KEY_PREFIX,
  ProviderInstanceId,
  boardStagesInOrder,
  isBoardReviewStageExecution,
  resolveBoardProjectAccent,
  resolveBoardStageExecution,
  type BoardReviewPhaseExecution,
  type BoardReviewPhaseId,
  type BoardSettings,
  type BoardStageDefinition,
  type BoardStageExecution,
  type BoardStageExecutionReview,
  type BoardState,
  type BoardWorktreeRetention,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { pinOrderKeyBetween } from "@t3tools/client-runtime/state/thread-sort";
import { useAtomValue } from "@effect/atom-react";
import { ChevronDownIcon, ChevronUpIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import * as Option from "effect/Option";

import {
  PROJECT_ACCENT_NAMES,
  isProjectAccentName,
  projectAccent,
  type ProjectAccentName,
} from "../../board/projectAccent";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { boardEnvironment } from "../../state/board";
import { environmentShell } from "../../state/shell";
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
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import {
  minutesToMs,
  msToMinutes,
  normalizeKeyPrefixInput,
  parsePositiveIntInput,
  setBoardInstanceConcurrency,
  setBoardProjectSetting,
  setBoardStageExecution,
} from "./BoardSettingsPanel.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const ACCENT_AUTO = "__auto__";

const WORKTREE_RETENTION_LABELS: Record<BoardWorktreeRetention, string> = {
  "reclaim-on-archive": "Reclaim when a card is archived",
  "reclaim-on-merge": "Reclaim when a card is merged",
  keep: "Keep worktrees until removed manually",
};

/** Built-in driver ids (the canonical set is `ServerSettings.providers`, so
    this never drifts from contracts) plus any configured custom instances — the
    recipe step and concurrency selects offer these. Free text would risk an
    invalid slug that fails the whole-settings decode on save. */
function useProviderInstanceIds(): ReadonlyArray<string> {
  const providers = usePrimarySettings((settings) => settings.providers);
  const providerInstances = usePrimarySettings((settings) => settings.providerInstances);
  return useMemo(
    () => [...new Set([...Object.keys(providers), ...Object.keys(providerInstances)])],
    [providers, providerInstances],
  );
}

export function BoardSettingsPanel() {
  const board = usePrimarySettings((settings) => settings.board);
  const update = useUpdatePrimarySettings();
  const instanceIds = useProviderInstanceIds();
  const environmentId = usePrimaryEnvironmentId();

  return (
    <SettingsPageContainer>
      <ProjectsSection board={board} environmentId={environmentId} update={update} />
      <PipelineSection board={board} update={update} />
      <ConcurrencySection board={board} instanceIds={instanceIds} update={update} />
      <LifecycleSection board={board} update={update} />
    </SettingsPageContainer>
  );
}

type UpdateFn = ReturnType<typeof useUpdatePrimarySettings>;

// ── Projects ───────────────────────────────────────────────────────────

function ProjectsSection({
  board,
  environmentId,
  update,
}: {
  board: BoardSettings;
  environmentId: EnvironmentId | null;
  update: UpdateFn;
}) {
  const anchor = searchableSetting("board-projects");
  return (
    <SettingsSection id="board-projects" title={anchor.title}>
      <SettingsRow
        title="Card keys and colour"
        description="The prefix for this project's card keys (e.g. T3 → T3-42) and the colour its cards show on the board. A project's first card assigns an acronym from its name (mesh.web → MW) and keeps it; set a prefix here to override it before those keys exist."
      >
        {environmentId === null ? (
          <p className="pt-2 text-sm text-muted-foreground">
            Connect an environment to configure its projects.
          </p>
        ) : (
          <ProjectRows board={board} environmentId={environmentId} update={update} />
        )}
      </SettingsRow>
    </SettingsSection>
  );
}

function ProjectRows({
  board,
  environmentId,
  update,
}: {
  board: BoardSettings;
  environmentId: EnvironmentId;
  update: UpdateFn;
}) {
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const projects = Option.getOrNull(shellState.snapshot)?.projects ?? [];

  const setProject = (
    projectId: ProjectId,
    patch: Parameters<typeof setBoardProjectSetting>[2],
  ) => {
    update({ board: { projects: setBoardProjectSetting(board.projects, projectId, patch) } });
  };

  if (projects.length === 0) {
    return (
      <p className="pt-2 text-sm text-muted-foreground">No projects in this environment yet.</p>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2 pb-2">
      {projects.map((project) => {
        const entry = board.projects[project.id];
        const accentName = resolveBoardProjectAccent(board, project.id);
        const accentValue: ProjectAccentName | typeof ACCENT_AUTO = isProjectAccentName(accentName)
          ? accentName
          : ACCENT_AUTO;
        return (
          <div
            key={project.id}
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 px-3 py-2"
          >
            <span
              className={cn(
                "size-2.5 shrink-0 rounded-full",
                projectAccent(project.id, accentName).dot,
              )}
            />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
              {project.title}
            </span>
            <Input
              key={`${project.id}:${entry?.keyPrefix ?? ""}`}
              defaultValue={entry?.keyPrefix ?? ""}
              placeholder={DEFAULT_BOARD_KEY_PREFIX}
              aria-label={`Card key prefix for ${project.title}`}
              className="h-7 w-24 text-sm"
              onBlur={(event) => {
                const next = normalizeKeyPrefixInput(event.target.value);
                if (next !== (entry?.keyPrefix ?? null))
                  setProject(project.id, { keyPrefix: next });
              }}
            />
            <Select
              value={accentValue}
              onValueChange={(value) =>
                setProject(project.id, {
                  accentColor: value === ACCENT_AUTO ? null : (value as ProjectAccentName),
                })
              }
            >
              <SelectTrigger aria-label={`Accent for ${project.title}`} size="xs" className="w-32">
                <SelectValue>{accentValue === ACCENT_AUTO ? "Auto" : accentValue}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value={ACCENT_AUTO}>Auto</SelectItem>
                {PROJECT_ACCENT_NAMES.map((name) => (
                  <SelectItem key={name} value={name}>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={cn("size-2 rounded-full", projectAccent(project.id, name).dot)}
                      />
                      {name}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        );
      })}
    </div>
  );
}

// ── Pipeline (stage execution) ─────────────────────────────────────────────

const STAGE_ROLE_LABELS: Record<"build" | "review" | "done", string> = {
  build: "build",
  review: "review",
  done: "done",
};

/** A `BoardState` shell so `boardStagesInOrder` / `resolveBoardStageExecution`
    can order the stage list the same way the board does. */
function stageBoardState(stages: ReadonlyArray<BoardStageDefinition>): BoardState {
  return { cards: [], stages, nextCardNumberByProject: {} };
}

function PipelineSection({ board, update }: { board: BoardSettings; update: UpdateFn }) {
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

  // ProviderModelPicker context (shared across every stage card).
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const globalDefault = resolveAppModelSelectionState(settings, serverProviders);
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
  );

  const crudEnabled = environmentId !== null;

  const updateStage = (stageId: string, patch: Partial<BoardStageExecution>) => {
    update({ board: { pipeline: setBoardStageExecution(board.pipeline, stageId, patch) } });
  };

  // Model-picker options for a given active selection, shared by the uniform
  // stage card (one model) and the review card (one per phase).
  const getModelOptions = (active: ActiveModel) =>
    getCustomModelOptionsByInstance(settings, serverProviders, active.instanceId, active.model);

  const onRename = (stage: BoardStageDefinition, label: string) => {
    if (environmentId === null || label.length === 0 || label === stage.label) return;
    void renameStage({ environmentId, input: { stageId: stage.stageId, label } });
  };

  const onReorder = (stage: BoardStageDefinition, index: number, direction: -1 | 1) => {
    if (environmentId === null) return;
    // Recompute the moved stage's key so it lands between its new neighbours.
    const orderKey =
      direction === -1
        ? pinOrderKeyBetween(
            ordered[index - 2]?.orderKey ?? null,
            ordered[index - 1]?.orderKey ?? null,
          )
        : pinOrderKeyBetween(
            ordered[index + 1]?.orderKey ?? null,
            ordered[index + 2]?.orderKey ?? null,
          );
    if (orderKey === null) return;
    void reorderStage({ environmentId, input: { stageId: stage.stageId, orderKey } });
  };

  const onDelete = (stage: BoardStageDefinition) => {
    if (environmentId === null) return;
    void deleteStage({ environmentId, input: { stageId: stage.stageId } });
  };

  const onAddStage = () => {
    if (environmentId === null) return;
    const last = ordered[ordered.length - 1];
    const orderKey = pinOrderKeyBetween(last?.orderKey ?? null, null);
    if (orderKey === null) return;
    void createStage({
      environmentId,
      input: { stageId: BoardStageId.make(randomUUID()), label: "New stage", orderKey },
    });
  };

  return (
    <SettingsSection id="board-pipeline" title={anchor.title}>
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Each stage runs a single agent step. A card freezes its stage's execution config onto its
        card the moment it enters the stage, so edits here take effect the next time a card enters
        the stage, never mid-flight. Two stages — <strong>Building</strong> and{" "}
        <strong>Planning</strong> — ship auto-executing.
      </p>
      {!crudEnabled ? (
        <p className="px-3 text-xs text-muted-foreground/70 sm:px-4">
          Connect an environment to add, rename, reorder, or delete stages.
        </p>
      ) : null}
      <div className="flex flex-col gap-4 pt-1">
        {ordered.map((stage, index) => {
          const exec = resolveBoardStageExecution(board, stage.stageId);
          // The one settings-side branch on stage kind (D1/D4): the review-loop
          // member gets its bespoke card (rounds + a block per phase); every
          // other stage gets the uniform single-step card.
          if (isBoardReviewStageExecution(exec)) {
            return (
              <ReviewStageCard
                key={stage.stageId}
                stage={stage}
                index={index}
                stageCount={ordered.length}
                exec={exec}
                crudEnabled={crudEnabled}
                globalDefault={globalDefault}
                instanceEntries={instanceEntries}
                getModelOptions={getModelOptions}
                updateStage={updateStage}
                onRename={(label) => onRename(stage, label)}
                onReorder={(direction) => onReorder(stage, index, direction)}
              />
            );
          }
          const active = exec.model ?? {
            instanceId: globalDefault.instanceId,
            model: globalDefault.model,
          };
          const modelOptionsByInstance = getModelOptions(active);
          return (
            <StageCard
              key={stage.stageId}
              stage={stage}
              index={index}
              stageCount={ordered.length}
              exec={exec}
              crudEnabled={crudEnabled}
              activeModel={active}
              globalDefault={globalDefault}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              updateStage={updateStage}
              onRename={(label) => onRename(stage, label)}
              onReorder={(direction) => onReorder(stage, index, direction)}
              onDelete={() => onDelete(stage)}
            />
          );
        })}
      </div>
      <div className="px-3 pt-1 sm:px-4">
        <Button size="xs" variant="secondary" disabled={!crudEnabled} onClick={onAddStage}>
          <PlusIcon className="size-3.5" />
          Add stage
        </Button>
      </div>
    </SettingsSection>
  );
}

type ModelSelectionState = ReturnType<typeof resolveAppModelSelectionState>;
type InstanceEntries = ReturnType<typeof sortProviderInstanceEntries>;
type ModelOptionsByInstance = ReturnType<typeof getCustomModelOptionsByInstance>;
type ActiveModel = { instanceId: ProviderInstanceId; model: string };

/**
 * The bespoke Code review card (t3o-16, AC1/AC2). Unlike the uniform stage
 * card, it exposes a `Rounds` cap and one block per compiled-in phase — each
 * with its OWN prompt and model — and deliberately offers NO add / remove /
 * reorder control and NO uniform prompt, model or mode field: the phases are a
 * product decision, only their prompts and models are settings (D2).
 */
function ReviewStageCard({
  stage,
  index,
  stageCount,
  exec,
  crudEnabled,
  globalDefault,
  instanceEntries,
  getModelOptions,
  updateStage,
  onRename,
  onReorder,
}: {
  stage: BoardStageDefinition;
  index: number;
  stageCount: number;
  exec: BoardStageExecutionReview;
  crudEnabled: boolean;
  globalDefault: ModelSelectionState;
  instanceEntries: InstanceEntries;
  getModelOptions: (active: ActiveModel) => ModelOptionsByInstance;
  updateStage: (stageId: string, patch: Partial<BoardStageExecution>) => void;
  onRename: (label: string) => void;
  onReorder: (direction: -1 | 1) => void;
}) {
  const set = (patch: Partial<BoardStageExecutionReview>) =>
    updateStage(stage.stageId, patch as Partial<BoardStageExecution>);
  const setPhase = (phaseId: BoardReviewPhaseId, patch: Partial<BoardReviewPhaseExecution>) =>
    set({ phases: { ...exec.phases, [phaseId]: { ...exec.phases[phaseId], ...patch } } });

  return (
    <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          key={`name:${stage.stageId}:${stage.label}`}
          defaultValue={stage.label}
          aria-label="Stage name"
          disabled={!crudEnabled}
          className="h-7 w-44 text-sm font-medium"
          onBlur={(event) => onRename(event.target.value.trim())}
        />
        <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {STAGE_ROLE_LABELS.review}
        </span>
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Move stage up"
          disabled={!crudEnabled || index === 0}
          onClick={() => onReorder(-1)}
        >
          <ChevronUpIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Move stage down"
          disabled={!crudEnabled || index === stageCount - 1}
          onClick={() => onReorder(1)}
        >
          <ChevronDownIcon className="size-3.5" />
        </Button>
      </div>

      <p className="mt-2 text-[13px] leading-[1.45] text-muted-foreground/80">
        A loop, not a single step: review the worktree, triage the findings, adjudicate the fixes,
        and repeat until a review pass raises no blocking findings or the round cap stops it. Each
        phase runs on its own model.
      </p>

      <label className="mt-3 flex items-center justify-between gap-2 text-sm text-foreground">
        <span>Auto execute</span>
        <Switch
          checked={exec.autoExecute}
          onCheckedChange={(checked) => set({ autoExecute: Boolean(checked) })}
          aria-label="Auto execute this stage"
        />
      </label>

      <label className="mt-3 flex items-center justify-between gap-2 text-sm text-foreground">
        <span>Rounds</span>
        <Input
          key={`rounds:${stage.stageId}`}
          type="number"
          min={1}
          defaultValue={String(exec.rounds)}
          aria-label="Review rounds"
          className="h-7 w-20 text-sm"
          onBlur={(event) => {
            const rounds = parsePositiveIntInput(event.target.value, exec.rounds);
            if (rounds !== exec.rounds) set({ rounds });
          }}
        />
      </label>

      <div className="mt-3 flex flex-col gap-3">
        {BOARD_REVIEW_PHASE_IDS.map((phaseId) => {
          const phase = exec.phases[phaseId];
          const usesModel = phase.model !== null;
          const active = phase.model ?? {
            instanceId: globalDefault.instanceId,
            model: globalDefault.model,
          };
          return (
            <div key={phaseId} className="rounded-lg border border-border/50 px-3 py-2.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {BOARD_REVIEW_PHASE_LABELS[phaseId]}
              </p>
              <Textarea
                key={`phase-prompt:${stage.stageId}:${phaseId}`}
                defaultValue={phase.prompt}
                aria-label={`${BOARD_REVIEW_PHASE_LABELS[phaseId]} prompt`}
                rows={3}
                className="mt-2"
                onBlur={(event) => {
                  if (event.target.value !== phase.prompt)
                    setPhase(phaseId, { prompt: event.target.value });
                }}
              />
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-sm text-foreground">Use a specific model</span>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  {usesModel ? (
                    <ProviderModelPicker
                      activeInstanceId={active.instanceId}
                      model={active.model}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={getModelOptions(active)}
                      triggerVariant="outline"
                      triggerAriaLabel={`${BOARD_REVIEW_PHASE_LABELS[phaseId]} model`}
                      onInstanceModelChange={(instanceId, model) =>
                        setPhase(phaseId, { model: { instanceId, model } })
                      }
                    />
                  ) : null}
                  <Switch
                    checked={usesModel}
                    onCheckedChange={(checked) =>
                      setPhase(phaseId, {
                        model: checked
                          ? { instanceId: globalDefault.instanceId, model: globalDefault.model }
                          : null,
                      })
                    }
                    aria-label={`Use a specific model for the ${BOARD_REVIEW_PHASE_LABELS[phaseId]} phase`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StageCard({
  stage,
  index,
  stageCount,
  exec,
  crudEnabled,
  activeModel,
  globalDefault,
  instanceEntries,
  modelOptionsByInstance,
  updateStage,
  onRename,
  onReorder,
  onDelete,
}: {
  stage: BoardStageDefinition;
  index: number;
  stageCount: number;
  exec: BoardStageExecution;
  crudEnabled: boolean;
  activeModel: ActiveModel;
  globalDefault: ModelSelectionState;
  instanceEntries: InstanceEntries;
  modelOptionsByInstance: ModelOptionsByInstance;
  updateStage: (stageId: string, patch: Partial<BoardStageExecution>) => void;
  onRename: (label: string) => void;
  onReorder: (direction: -1 | 1) => void;
  onDelete: () => void;
}) {
  const set = (patch: Partial<BoardStageExecution>) => updateStage(stage.stageId, patch);

  const usesModel = exec.model !== null;
  const active = activeModel;

  const isBuildRole = stage.role === "build";
  // "Unattended" stages run without a human gate, so they expose auto-advance
  // and the timeout / attempt ceilings; the build stage always exposes them.
  const unattended = isBuildRole || !exec.humanInLoop;
  const promptMissing = exec.autoExecute && exec.prompt.trim().length === 0;

  return (
    <div className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          key={`name:${stage.stageId}:${stage.label}`}
          defaultValue={stage.label}
          aria-label="Stage name"
          disabled={!crudEnabled}
          className="h-7 w-44 text-sm font-medium"
          onBlur={(event) => onRename(event.target.value.trim())}
        />
        {stage.role !== null ? (
          <span className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
            {STAGE_ROLE_LABELS[stage.role]}
          </span>
        ) : null}
        <span className="flex-1" />
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Move stage up"
          disabled={!crudEnabled || index === 0}
          onClick={() => onReorder(-1)}
        >
          <ChevronUpIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Move stage down"
          disabled={!crudEnabled || index === stageCount - 1}
          onClick={() => onReorder(1)}
        >
          <ChevronDownIcon className="size-3.5" />
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Delete stage"
          disabled={!crudEnabled || stage.role !== null}
          onClick={onDelete}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>

      <label className="mt-3 flex items-center justify-between gap-2 text-sm text-foreground">
        <span>Auto execute</span>
        <Switch
          checked={exec.autoExecute}
          onCheckedChange={(checked) => set({ autoExecute: Boolean(checked) })}
          aria-label="Auto execute this stage"
        />
      </label>

      {exec.autoExecute ? (
        <div className="mt-3 flex flex-col gap-3">
          <div>
            <Textarea
              key={`prompt:${stage.stageId}`}
              defaultValue={exec.prompt}
              aria-label="Stage prompt"
              rows={3}
              placeholder="Prompt for this stage's agent step. Wrapped by the completion/question envelope at run time."
              onBlur={(event) => {
                if (event.target.value !== exec.prompt) set({ prompt: event.target.value });
              }}
            />
            {promptMissing ? (
              <p className="mt-1 text-xs text-destructive">A prompt is required to auto-execute.</p>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-sm text-foreground">Use a specific model</span>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {usesModel ? (
                <ProviderModelPicker
                  activeInstanceId={active.instanceId}
                  model={active.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerVariant="outline"
                  triggerAriaLabel="Stage model"
                  onInstanceModelChange={(instanceId, model) =>
                    set({ model: { instanceId, model } })
                  }
                />
              ) : null}
              <Switch
                checked={usesModel}
                onCheckedChange={(checked) =>
                  set({
                    model: checked
                      ? { instanceId: globalDefault.instanceId, model: globalDefault.model }
                      : null,
                  })
                }
                aria-label="Use a specific model for this stage"
              />
            </div>
          </div>

          <label className="flex items-center justify-between gap-2 text-sm text-foreground">
            <span>Mode</span>
            <Select
              value={exec.mode}
              onValueChange={(value) => {
                if (value) set({ mode: value as "plan" | "build" });
              }}
            >
              <SelectTrigger aria-label="Stage mode" size="xs" className="w-32">
                <SelectValue>{exec.mode === "plan" ? "Plan" : "Build"}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value="plan">Plan</SelectItem>
                <SelectItem value="build">Build</SelectItem>
              </SelectPopup>
            </Select>
          </label>

          {isBuildRole ? (
            <>
              <label className="flex items-center justify-between gap-2 text-sm text-foreground">
                <span>Pause for a human when a plan exists</span>
                <Switch
                  checked={exec.humanInLoopWithPlan}
                  onCheckedChange={(checked) => set({ humanInLoopWithPlan: Boolean(checked) })}
                  aria-label="Human in the loop when a plan exists"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm text-foreground">
                <span>Pause for a human when no plan exists</span>
                <Switch
                  checked={exec.humanInLoopWithoutPlan}
                  onCheckedChange={(checked) => set({ humanInLoopWithoutPlan: Boolean(checked) })}
                  aria-label="Human in the loop when no plan exists"
                />
              </label>
            </>
          ) : (
            <label className="flex items-center justify-between gap-2 text-sm text-foreground">
              <span>Pause for a human</span>
              <Switch
                checked={exec.humanInLoop}
                onCheckedChange={(checked) => set({ humanInLoop: Boolean(checked) })}
                aria-label="Human in the loop"
              />
            </label>
          )}

          {unattended ? (
            <label className="flex items-center justify-between gap-2 text-sm text-foreground">
              <span>Auto advance to the next stage</span>
              <Switch
                checked={exec.autoAdvance}
                onCheckedChange={(checked) => set({ autoAdvance: Boolean(checked) })}
                aria-label="Auto advance to the next stage"
              />
            </label>
          ) : null}

          {unattended ? (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="w-16 shrink-0">Timeout</span>
                <Input
                  key={`timeout:${stage.stageId}:${exec.timeoutMs}`}
                  type="number"
                  min={1}
                  defaultValue={msToMinutes(exec.timeoutMs)}
                  aria-label="Timeout in minutes"
                  className="h-7 w-24 text-sm"
                  onBlur={(event) => {
                    const minutes = parsePositiveIntInput(
                      event.target.value,
                      msToMinutes(exec.timeoutMs),
                    );
                    const timeoutMs = minutesToMs(minutes);
                    if (timeoutMs !== exec.timeoutMs) set({ timeoutMs });
                  }}
                />
                <span>min</span>
              </label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="w-16 shrink-0">Attempts</span>
                <Input
                  key={`attempts:${stage.stageId}:${exec.maxAttempts}`}
                  type="number"
                  min={1}
                  defaultValue={exec.maxAttempts}
                  aria-label="Max attempts"
                  className="h-7 w-24 text-sm"
                  onBlur={(event) => {
                    const maxAttempts = parsePositiveIntInput(event.target.value, exec.maxAttempts);
                    if (maxAttempts !== exec.maxAttempts) set({ maxAttempts });
                  }}
                />
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Concurrency ────────────────────────────────────────────────────────

function ConcurrencySection({
  board,
  instanceIds,
  update,
}: {
  board: BoardSettings;
  instanceIds: ReadonlyArray<string>;
  update: UpdateFn;
}) {
  const anchor = searchableSetting("board-concurrency");
  return (
    <SettingsSection id="board-concurrency" title={anchor.title}>
      <SettingsRow
        title="Global limit"
        description="The maximum number of build steps running at once across all provider instances."
        control={
          <Input
            key={`global:${board.concurrency.globalMaxConcurrent}`}
            type="number"
            min={1}
            defaultValue={board.concurrency.globalMaxConcurrent}
            aria-label="Global concurrency limit"
            className="h-8 w-24 text-sm"
            onBlur={(event) => {
              const value = parsePositiveIntInput(
                event.target.value,
                board.concurrency.globalMaxConcurrent,
              );
              if (value !== board.concurrency.globalMaxConcurrent) {
                update({ board: { concurrency: { globalMaxConcurrent: value } } });
              }
            }}
          />
        }
      />
      <SettingsRow
        title="Per-provider limits"
        description="Optionally cap concurrent steps for a specific provider instance. Blank uses the global limit."
      >
        <div className="mt-2 flex flex-col gap-2 pb-2">
          {instanceIds.map((id) => {
            const current = board.concurrency.perInstance[ProviderInstanceId.make(id)];
            return (
              <div key={id} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{id}</span>
                <Input
                  key={`perInstance:${id}:${current ?? ""}`}
                  type="number"
                  min={1}
                  defaultValue={current ?? ""}
                  placeholder="Global"
                  aria-label={`Concurrency limit for ${id}`}
                  className="h-7 w-24 text-sm"
                  onBlur={(event) => {
                    const raw = event.target.value.trim();
                    const value =
                      raw.length === 0 ? null : parsePositiveIntInput(raw, current ?? 1);
                    update({
                      board: {
                        concurrency: {
                          perInstance: setBoardInstanceConcurrency(
                            board.concurrency.perInstance,
                            ProviderInstanceId.make(id),
                            value,
                          ),
                        },
                      },
                    });
                  }}
                />
              </div>
            );
          })}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}

// ── Lifecycle ──────────────────────────────────────────────────────────

function LifecycleSection({ board, update }: { board: BoardSettings; update: UpdateFn }) {
  const anchor = searchableSetting("board-archive-window");
  const defaults = DEFAULT_UNIFIED_SETTINGS.board.lifecycle;
  return (
    <SettingsSection id="board-lifecycle" title="Lifecycle">
      <SettingsRow
        id="board-archive-window"
        title={anchor.title}
        description={`Cards auto-archive after this many days in Done. Default is ${DEFAULT_BOARD_ARCHIVE_AFTER_DAYS} days.`}
        control={
          <Input
            key={`archive:${board.lifecycle.archiveAfterDays}`}
            type="number"
            min={1}
            defaultValue={board.lifecycle.archiveAfterDays}
            aria-label="Archive window in days"
            className="h-8 w-24 text-sm"
            onBlur={(event) => {
              const value = parsePositiveIntInput(
                event.target.value,
                board.lifecycle.archiveAfterDays,
              );
              if (value !== board.lifecycle.archiveAfterDays) {
                update({ board: { lifecycle: { archiveAfterDays: value } } });
              }
            }}
          />
        }
      />
      <SettingsRow
        title="Worktree retention"
        description="When a card's git worktree is reclaimed after its work is done."
        control={
          <Select
            value={board.lifecycle.worktreeRetention}
            onValueChange={(value) =>
              update({
                board: { lifecycle: { worktreeRetention: value as BoardWorktreeRetention } },
              })
            }
          >
            <SelectTrigger aria-label="Worktree retention" className="w-full sm:w-72">
              <SelectValue>
                {WORKTREE_RETENTION_LABELS[board.lifecycle.worktreeRetention]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(WORKTREE_RETENTION_LABELS) as BoardWorktreeRetention[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {WORKTREE_RETENTION_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <p className="px-3 text-xs text-muted-foreground/70 sm:px-4">
        Defaults: reclaim {defaults.worktreeRetention === "reclaim-on-archive" ? "on archive" : ""},
        archive after {DEFAULT_BOARD_ARCHIVE_AFTER_DAYS} days, global concurrency{" "}
        {DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT}.
      </p>
    </SettingsSection>
  );
}

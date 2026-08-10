/**
 * Settings → Board (t3o-07). The typed pipeline recipe (D10) plus per-project
 * card identity, concurrency ceilings, and lifecycle windows. Every field is
 * server-authoritative (it reaches the decider / reactors), so the panel reads
 * and writes through `usePrimarySettings` / `useUpdatePrimarySettings`.
 *
 * Recipe and project edits send whole maps (the `providerInstances` discipline):
 * a stage's step list and the projects map are replaced wholesale, never
 * partially patched, so a running card's snapshotted recipe (captured on stage
 * entry, t3o-10) can never be corrupted by a mid-flight edit — the edit takes
 * effect on the next stage entry.
 */
import {
  BOARD_STAGES,
  DEFAULT_BOARD_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT,
  DEFAULT_BOARD_KEY_PREFIX,
  ProviderInstanceId,
  resolveBoardProjectAccent,
  type BoardSettings,
  type BoardStage,
  type BoardStep,
  type BoardWorktreeRetention,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useAtomValue } from "@effect/atom-react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useMemo } from "react";
import * as Option from "effect/Option";

import {
  PROJECT_ACCENT_NAMES,
  isProjectAccentName,
  projectAccent,
  type ProjectAccentName,
} from "../../board/projectAccent";
import { BOARD_STAGE_LABELS } from "../../board/boardStages";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { environmentShell } from "../../state/shell";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import {
  appendBoardStep,
  makeNewBoardStep,
  minutesToMs,
  msToMinutes,
  normalizeKeyPrefixInput,
  parsePositiveIntInput,
  removeBoardStep,
  setBoardInstanceConcurrency,
  setBoardProjectSetting,
  setBoardStepField,
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
      <PipelineSection board={board} instanceIds={instanceIds} update={update} />
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
        description="The prefix for this project's card keys (e.g. T3 → T3-42) and the colour its cards show on the board. Prefixes cannot be derived from the project name, so they are explicit."
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

// ── Pipeline recipe ──────────────────────────────────────────────────────

function PipelineSection({
  board,
  instanceIds,
  update,
}: {
  board: BoardSettings;
  instanceIds: ReadonlyArray<string>;
  update: UpdateFn;
}) {
  const anchor = searchableSetting("board-pipeline");
  const setStages = (stage: BoardStage, steps: ReadonlyArray<BoardStep>) => {
    update({ board: { pipeline: { [stage]: steps } } });
  };
  return (
    <SettingsSection id="board-pipeline" title={anchor.title}>
      <p className="px-3 text-[13px] leading-[1.45] text-muted-foreground/80 sm:px-4">
        Each stage runs an ordered list of steps — one short-lived agent thread per step. A card
        snapshots its stage's recipe on entry, so edits here take effect the next time a card enters
        the stage, never mid-flight. In this release only <strong>Building</strong> is executed; the
        rest are stored for when later stages automate.
      </p>
      <div className="flex flex-col gap-4 pt-1">
        {BOARD_STAGES.map((stage) => {
          const steps = board.pipeline[stage] ?? [];
          return (
            <div key={stage} className="rounded-xl border border-border/60 px-3 py-3 sm:px-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">
                  {BOARD_STAGE_LABELS[stage]}
                  <span className="ml-2 text-xs font-normal text-muted-foreground">
                    {steps.length === 0
                      ? "No steps"
                      : `${steps.length} step${steps.length === 1 ? "" : "s"}`}
                  </span>
                </h3>
                <Button
                  size="xs"
                  variant="secondary"
                  onClick={() => setStages(stage, appendBoardStep(steps, makeNewBoardStep(steps)))}
                >
                  <PlusIcon className="size-3.5" />
                  Add step
                </Button>
              </div>
              {steps.length > 0 ? (
                <div className="mt-3 flex flex-col gap-3">
                  {steps.map((step, index) => (
                    <StepEditor
                      key={step.id}
                      step={step}
                      instanceIds={instanceIds}
                      onChange={(patch) => setStages(stage, setBoardStepField(steps, index, patch))}
                      onRemove={() => setStages(stage, removeBoardStep(steps, index))}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </SettingsSection>
  );
}

function StepEditor({
  step,
  instanceIds,
  onChange,
  onRemove,
}: {
  step: BoardStep;
  instanceIds: ReadonlyArray<string>;
  onChange: (patch: Partial<BoardStep>) => void;
  onRemove: () => void;
}) {
  const instanceOptions = [...new Set([...instanceIds, step.providerInstanceId as string])];
  return (
    <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          key={`label:${step.id}:${step.label}`}
          defaultValue={step.label}
          aria-label="Step label"
          className="h-7 w-40 text-sm"
          onBlur={(event) => {
            const label = event.target.value.trim();
            if (label.length > 0 && label !== step.label) onChange({ label });
          }}
        />
        <span className="flex-1" />
        <Button size="icon-xs" variant="ghost" aria-label="Remove step" onClick={onRemove}>
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-16 shrink-0">Provider</span>
          <Select
            value={step.providerInstanceId}
            onValueChange={(value) => {
              if (value) onChange({ providerInstanceId: ProviderInstanceId.make(value) });
            }}
          >
            <SelectTrigger aria-label="Provider instance" size="xs" className="w-full">
              <SelectValue>{step.providerInstanceId}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {instanceOptions.map((id) => (
                <SelectItem key={id} value={id}>
                  {id}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-16 shrink-0">Model</span>
          <Input
            key={`model:${step.id}:${step.model}`}
            defaultValue={step.model}
            aria-label="Model"
            className="h-7 flex-1 text-sm"
            onBlur={(event) => {
              const model = event.target.value.trim();
              if (model.length > 0 && model !== step.model) onChange({ model });
            }}
          />
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-16 shrink-0">Timeout</span>
          <Input
            key={`timeout:${step.id}:${step.timeoutMs}`}
            type="number"
            min={1}
            defaultValue={msToMinutes(step.timeoutMs)}
            aria-label="Timeout in minutes"
            className="h-7 w-24 text-sm"
            onBlur={(event) => {
              const minutes = parsePositiveIntInput(
                event.target.value,
                msToMinutes(step.timeoutMs),
              );
              const timeoutMs = minutesToMs(minutes);
              if (timeoutMs !== step.timeoutMs) onChange({ timeoutMs });
            }}
          />
          <span>min</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="w-16 shrink-0">Attempts</span>
          <Input
            key={`attempts:${step.id}:${step.maxAttempts}`}
            type="number"
            min={1}
            defaultValue={step.maxAttempts}
            aria-label="Max attempts"
            className="h-7 w-24 text-sm"
            onBlur={(event) => {
              const maxAttempts = parsePositiveIntInput(event.target.value, step.maxAttempts);
              if (maxAttempts !== step.maxAttempts) onChange({ maxAttempts });
            }}
          />
        </label>
      </div>
      <Textarea
        key={`prompt:${step.id}`}
        defaultValue={step.promptTemplate}
        aria-label="Prompt template"
        rows={3}
        placeholder="Prompt for this step. Wrapped by the completion/question envelope at run time."
        className="mt-2"
        onBlur={(event) => {
          if (event.target.value !== step.promptTemplate) {
            onChange({ promptTemplate: event.target.value });
          }
        }}
      />
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

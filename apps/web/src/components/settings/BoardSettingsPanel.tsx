/**
 * Settings → Board (t3o-15, redesigned after `.plans/prototype/T3
 * Settings.dc.html`). Per-project card identity, the pipeline accordion
 * (`BoardPipelineSection`), concurrency ceilings and lifecycle windows — all
 * sharing the prototype's bordered-card aesthetic. Execution config and
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
  DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT,
  DEFAULT_BOARD_KEY_PREFIX,
  DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE,
  ProviderInstanceId,
  resolveBoardProjectAccent,
  type BoardSettings,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
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
import { environmentShell } from "../../state/shell";
import { cn } from "../../lib/utils";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  normalizeKeyPrefixInput,
  setBoardInstanceConcurrency,
  setBoardProjectSetting,
} from "./BoardSettingsPanel.logic";
import { BoardPipelineSection, NumberStepper } from "./BoardPipelineSection";
import { searchableSetting } from "./settingsSearch";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

const ACCENT_AUTO = "__auto__";

/** Built-in driver ids (the canonical set is `ServerSettings.providers`, so
    this never drifts from contracts) plus any configured custom instances — the
    concurrency rows offer these. Free text would risk an invalid slug that
    fails the whole-settings decode on save. */
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
      <BoardPipelineSection />
      <ConcurrencySection board={board} instanceIds={instanceIds} update={update} />
      <LifecycleSection board={board} update={update} />
    </SettingsPageContainer>
  );
}

type UpdateFn = ReturnType<typeof useUpdatePrimarySettings>;

/** The prototype's bordered card list container, shared by every non-pipeline
    section so the page reads as one system. */
function CardListContainer(props: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mx-3 flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-xs sm:mx-4",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

/** A label/description + control row inside a `CardListContainer`. */
function CardRow(props: { label: string; description?: string; control: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13.5px] text-foreground">{props.label}</span>
        {props.description ? (
          <span className="max-w-md text-xs text-muted-foreground">{props.description}</span>
        ) : null}
      </div>
      {props.control}
    </div>
  );
}

// ── Card keys and colour ───────────────────────────────────────────────

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
      <p className="max-w-xl px-3 text-[13px] leading-[1.55] text-muted-foreground/80 sm:px-4">
        The prefix for this project's card keys (e.g. T3 → T3-42) and the colour its cards show on
        the board. A project's first card assigns an acronym from its name (mesh.web → MW) and keeps
        it; set a prefix here to override it before those keys exist.
      </p>
      {environmentId === null ? (
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Connect an environment to configure its projects.
        </p>
      ) : (
        <ProjectRows board={board} environmentId={environmentId} update={update} />
      )}
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
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        No projects in this environment yet.
      </p>
    );
  }

  return (
    <div className="mx-3 flex flex-col gap-2 sm:mx-4">
      {projects.map((project) => {
        const entry = board.projects[project.id];
        const accentName = resolveBoardProjectAccent(board, project.id);
        const accentValue: ProjectAccentName | typeof ACCENT_AUTO = isProjectAccentName(accentName)
          ? accentName
          : ACCENT_AUTO;
        return (
          <div
            key={project.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                projectAccent(project.id, accentName).dot,
              )}
            />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-foreground">
              {project.title}
            </span>
            <Input
              key={`${project.id}:${entry?.keyPrefix ?? ""}`}
              defaultValue={entry?.keyPrefix ?? ""}
              placeholder={DEFAULT_BOARD_KEY_PREFIX}
              aria-label={`Card key prefix for ${project.title}`}
              className="h-7.5 w-24 font-mono text-[13px] uppercase"
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
      <CardListContainer>
        <CardRow
          label="Global limit"
          description="The maximum number of build steps running at once across all provider instances."
          control={
            <NumberStepper
              value={board.concurrency.globalMaxConcurrent}
              min={1}
              max={99}
              ariaLabel="Global concurrency limit"
              onChange={(value) => {
                if (value !== board.concurrency.globalMaxConcurrent) {
                  update({ board: { concurrency: { globalMaxConcurrent: value } } });
                }
              }}
            />
          }
        />
        <div className="h-px bg-border" />
        <p className="pt-1 text-xs text-muted-foreground">
          Optionally cap concurrent steps for a specific provider instance. Clear a value to fall
          back to the global limit.
        </p>
        {instanceIds.map((id) => {
          const current = board.concurrency.perInstance[ProviderInstanceId.make(id)];
          return (
            <div key={id} className="flex items-center justify-between gap-4 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{id}</span>
              <NumberStepper
                nullable
                value={current ?? null}
                min={1}
                max={99}
                // Unset means "follow the global limit", so that is both what
                // the field reads and where −/+ start counting from.
                placeholder="Global"
                stepFrom={board.concurrency.globalMaxConcurrent}
                ariaLabel={`Concurrency limit for ${id}`}
                onChange={(value) => {
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
      </CardListContainer>
    </SettingsSection>
  );
}

// ── Lifecycle ──────────────────────────────────────────────────────────

function LifecycleSection({ board, update }: { board: BoardSettings; update: UpdateFn }) {
  const anchor = searchableSetting("board-reclaim-worktree-on-done");
  return (
    <SettingsSection id="board-lifecycle" title="Lifecycle">
      <div id="board-reclaim-worktree-on-done" className="px-3 sm:px-4">
        <CardRow
          label={anchor.title}
          description="Remove a card's git worktree as soon as it reaches Done with its pull request merged, instead of waiting for it to be archived. Archiving always reclaims either way."
          control={
            <Switch
              checked={board.lifecycle.reclaimWorktreeOnDone}
              onCheckedChange={(checked) =>
                update({
                  board: { lifecycle: { reclaimWorktreeOnDone: Boolean(checked) } },
                })
              }
              aria-label={anchor.title}
            />
          }
        />
      </div>
      <p className="px-3 text-xs text-muted-foreground/70 sm:px-4">
        Defaults: reclaim worktrees at Done {DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE ? "on" : "off"},
        global concurrency {DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT}.
      </p>
    </SettingsSection>
  );
}

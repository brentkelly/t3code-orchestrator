/**
 * Settings → Board → General (t3o-15, redesigned after `.plans/prototype/T3
 * Settings.dc.html`; split into pages by T3O-49). Per-project card identity,
 * the import notices, concurrency ceilings and lifecycle windows — all
 * sharing the prototype's bordered-card aesthetic. Execution config and
 * project edits reach the decider / reactor, so the panel reads and writes
 * through `useBoardSettings` / `useUpdateBoardSettings` — the board server's
 * settings (T3O-71); stage CRUD is a board command dispatched through the
 * environment.
 *
 * The pipeline is keyed by STAGE ID, so a rename never orphans a stage's config.
 * A stage's resolved config is frozen onto the card at stage entry (D12), so a
 * mid-flight edit here takes effect only on the next entry, never on a running
 * card.
 */
import {
  DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT,
  DEFAULT_BOARD_KEY_PREFIX,
  DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE,
  ProviderInstanceId,
  type BoardSettings,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { EyeIcon, EyeOffIcon, SettingsIcon, WorkflowIcon } from "lucide-react";
import * as Option from "effect/Option";

import { projectAccent, projectIconColorOf } from "../../board/projectAccent";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { environmentShell } from "../../state/shell";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import {
  normalizeKeyPrefixInput,
  setBoardInstanceConcurrency,
  setBoardProjectSetting,
} from "./BoardSettingsPanel.logic";
import { BoardPipelineSection, NumberStepper } from "./BoardPipelineSection";
import { BoardSettingsCard, BoardSettingsCardRow } from "../../board/settings/boardSettingsCards";
import { BoardImportNotices } from "../../board/settings/BoardImportNotice";
import { BoardWorkerSettings } from "../../board/workers/BoardWorkerSettings";
import { useBoardWorkers } from "../../board/workers/boardWorkersState";
import { boardShowsWorkers } from "../../board/workers/cardWorker";
import { WorkerConcurrencySection } from "../../board/workers/WorkerConcurrencySection";
import { boardLocalConcurrencyDiverges } from "../../board/workers/workerConcurrency";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";
import { BoardServerSection } from "../../board/BoardServerSettings";
import {
  useBoardEnvironment,
  useBoardServerProviders,
  useBoardSettings,
  useUpdateBoardSettings,
} from "../../board/useBoardEnvironmentId";

/** The provider instances the server reports, built-in drivers included, plus
    any configured custom instances — the concurrency rows offer these. Free text
    would risk an invalid slug that fails the whole-settings decode on save. */
function useProviderInstanceIds(): ReadonlyArray<string> {
  const providers = useBoardServerProviders();
  const providerInstances = useBoardSettings((settings) => settings.providerInstances);
  return [
    ...new Set([
      ...providers.map((provider) => String(provider.instanceId)),
      ...Object.keys(providerInstances),
    ]),
  ];
}

/** Settings → Board → General (T3O-49): the board server, display, the
    project list with its import notices, the global pipeline, concurrency, workers and
    lifecycle.
    The layout resolves the board server first. */
export function BoardSettingsPanel() {
  const resolution = useBoardEnvironment();
  return (
    <>
      <BoardServerSection />
      {/* Without a reachable board server there are no settings to show or save; the sections
          would only read defaults and drop every edit. */}
      {resolution.kind === "ready" ? (
        <BoardSettingsSections environmentId={resolution.environmentId} />
      ) : null}
    </>
  );
}

/** The board server's own settings; rendered only once that server resolves. */
function BoardSettingsSections({ environmentId }: { environmentId: EnvironmentId }) {
  const board = useBoardSettings((settings) => settings.board);
  const update = useUpdateBoardSettings();
  const instanceIds = useProviderInstanceIds();

  return (
    <>
      <DisplaySection board={board} update={update} />
      {/* T3O-49: committed t3o.json files waiting to import. */}
      <BoardImportNotices />
      <ProjectsSection board={board} environmentId={environmentId} update={update} />
      <BoardPipelineSection />
      <BoardConcurrencySettings
        board={board}
        environmentId={environmentId}
        instanceIds={instanceIds}
        update={update}
      />
      {/* T3O-62: the board's workers, and which projects each has checked out. */}
      <BoardWorkerSettings environmentId={environmentId} />
      <LifecycleSection board={board} update={update} />
    </>
  );
}

type UpdateFn = ReturnType<typeof useUpdateBoardSettings>;

// ── Projects ───────────────────────────────────────────────────────────

function ProjectsSection({
  board,
  environmentId,
  update,
}: {
  board: BoardSettings;
  environmentId: EnvironmentId;
  update: UpdateFn;
}) {
  const anchor = searchableSetting("board-projects");
  return (
    <SettingsSection id="board-projects" title={anchor.title} variant="plain">
      <p className="mb-2 max-w-xl px-3 text-[13px] leading-[1.55] text-muted-foreground/80 sm:px-4">
        The prefix for each project's card keys (e.g. T3 → T3-42). Cards take their colour from the
        project's icon; the gear opens the project's settings to change it. The flow icon opens its
        pipeline and CI. The eye hides a project and its cards from the board without touching them.
      </p>
      <ProjectRows board={board} environmentId={environmentId} update={update} />
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
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);

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
        const hidden = entry?.hidden ?? false;
        return (
          <div
            key={project.id}
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs"
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                projectAccent(project.id, projectIconColorOf(project)).dot,
              )}
            />
            <span
              className={cn(
                "min-w-0 truncate text-[13.5px] font-medium",
                hidden ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {project.title}
            </span>
            {hidden ? (
              <span className="shrink-0 rounded-full border border-border px-1.75 py-px text-[11px] font-medium text-muted-foreground">
                Hidden
              </span>
            ) : null}
            <span className="min-w-2 flex-1" />
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
            <div className="flex shrink-0 items-center gap-0.5">
              {/* T3O-49: the project's pipeline, CI and t3o.json. */}
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                title={`${project.title} pipeline & CI`}
                aria-label={`Open ${project.title} pipeline & CI`}
                render={
                  <Link
                    to="/settings/board/projects/$projectId/$tab"
                    params={{ projectId: project.id, tab: "pipeline" }}
                  />
                }
              >
                <WorkflowIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn("text-muted-foreground", hidden && "border border-border")}
                title={hidden ? "Show on the board" : "Hide from the board"}
                aria-label={
                  hidden
                    ? `Show ${project.title} on the board`
                    : `Hide ${project.title} from the board`
                }
                aria-pressed={hidden}
                onClick={() => setProject(project.id, { hidden: !hidden })}
              >
                {hidden ? <EyeOffIcon /> : <EyeIcon />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                title={`${project.title} icon & colour (project settings)`}
                aria-label={`Open ${project.title} project settings`}
                render={
                  <Link
                    to="/projects/$projectKey"
                    params={{
                      projectKey: deriveLogicalProjectKeyFromSettings(
                        { ...project, environmentId },
                        projectGroupingSettings,
                      ),
                    }}
                  />
                }
              >
                <SettingsIcon />
              </Button>
            </div>
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
    <SettingsSection id="board-concurrency" title={anchor.title} variant="plain">
      <BoardSettingsCard>
        <BoardSettingsCardRow
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
      </BoardSettingsCard>
    </SettingsSection>
  );
}

/**
 * Concurrency, per worker once the board has any (T3O-65, D11). A local-only
 * board keeps the section exactly as it was, unless a per-worker override for
 * this server outlived the workers.
 */
function BoardConcurrencySettings(props: {
  board: BoardSettings;
  environmentId: EnvironmentId;
  instanceIds: ReadonlyArray<string>;
  update: UpdateFn;
}) {
  const workers = useBoardWorkers(props.environmentId);
  if (
    !boardShowsWorkers(workers.state) &&
    !boardLocalConcurrencyDiverges(props.board.concurrency)
  ) {
    return (
      <ConcurrencySection
        board={props.board}
        instanceIds={props.instanceIds}
        update={props.update}
      />
    );
  }
  const anchor = searchableSetting("board-concurrency");
  return (
    <SettingsSection id="board-concurrency" title={anchor.title} variant="plain">
      <WorkerConcurrencySection
        concurrency={props.board.concurrency}
        localInstanceIds={props.instanceIds}
        onChange={(patch) => props.update({ board: { concurrency: patch } })}
        workers={workers.state}
      />
    </SettingsSection>
  );
}

// ── Display ────────────────────────────────────────────────────────────

function DisplaySection({ board, update }: { board: BoardSettings; update: UpdateFn }) {
  const anchor = searchableSetting("board-auto-collapse-empty-stages");
  return (
    <SettingsSection id="board-display" title="Display" variant="plain">
      <BoardSettingsCard id="board-auto-collapse-empty-stages">
        <BoardSettingsCardRow
          label={anchor.title}
          description="Stages with no cards fold to a narrow strip and open again when a card lands in them. Applies to everyone using this board."
          control={
            <Switch
              checked={board.display.autoCollapseEmptyStages}
              onCheckedChange={(checked) =>
                update({ board: { display: { autoCollapseEmptyStages: Boolean(checked) } } })
              }
              aria-label={anchor.title}
            />
          }
        />
      </BoardSettingsCard>
    </SettingsSection>
  );
}

// ── Lifecycle ──────────────────────────────────────────────────────────

function LifecycleSection({ board, update }: { board: BoardSettings; update: UpdateFn }) {
  const anchor = searchableSetting("board-reclaim-worktree-on-done");
  const autoArchive = searchableSetting("board-auto-archive-done");
  return (
    <SettingsSection id="board-lifecycle" title="Lifecycle" variant="plain">
      <BoardSettingsCard id="board-reclaim-worktree-on-done">
        <BoardSettingsCardRow
          label={anchor.title}
          description="Remove a card's git worktree as soon as it reaches Done, instead of waiting for it to be archived. A worktree holding uncommitted changes or unpushed commits is kept and flagged on the card. Archiving always reclaims either way."
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
      </BoardSettingsCard>
      <BoardSettingsCard id="board-auto-archive-done">
        <BoardSettingsCardRow
          label={autoArchive.title}
          description="Archive cards left untouched in Done for this many days. With worktrees reclaimed at Done, a card whose worktree was kept for unsaved work stays in Done. Archiving never removes unsaved work, and archived cards can be restored from the archive."
          control={
            <Switch
              checked={board.lifecycle.autoArchiveDone}
              onCheckedChange={(checked) =>
                update({ board: { lifecycle: { autoArchiveDone: Boolean(checked) } } })
              }
              aria-label={autoArchive.title}
            />
          }
        />
        {board.lifecycle.autoArchiveDone ? (
          <BoardSettingsCardRow
            label="Days in Done before archiving"
            control={
              <NumberStepper
                value={board.lifecycle.autoArchiveAfterDays}
                min={1}
                max={365}
                ariaLabel="Days in Done before archiving"
                onChange={(value) => {
                  if (value !== board.lifecycle.autoArchiveAfterDays) {
                    update({ board: { lifecycle: { autoArchiveAfterDays: value } } });
                  }
                }}
              />
            }
          />
        ) : null}
      </BoardSettingsCard>
      <p className="px-3 text-xs text-muted-foreground/70 sm:px-4">
        Defaults: reclaim worktrees at Done {DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE ? "on" : "off"},
        auto-archive off ({DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS} days when on), global concurrency{" "}
        {DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT}.
      </p>
    </SettingsSection>
  );
}

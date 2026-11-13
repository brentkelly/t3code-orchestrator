/**
 * Settings > Board > General. Reads and writes the board server's settings via
 * `useBoardSettings` / `useUpdateBoardSettings`. Config is keyed by stage id
 * and frozen onto a card at stage entry, so edits apply on the next entry.
 */
import {
  DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_GLOBAL_MAX_CONCURRENT,
  DEFAULT_BOARD_KEY_PREFIX,
  DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE,
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
import { Switch } from "../ui/switch";
import {
  normalizeKeyPrefixInput,
  setBoardProjectSetting,
} from "./BoardSettingsPanel.logic";
import { BoardPipelineSection, NumberStepper } from "./BoardPipelineSection";
import { BoardSettingsCard, BoardSettingsCardRow } from "../../board/settings/boardSettingsCards";
import { BoardImportNotices } from "../../board/settings/BoardImportNotice";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";
import { BoardServerSection } from "../../board/BoardServerSettings";
import {
  useBoardEnvironment,
  useBoardSettings,
  useUpdateBoardSettings,
} from "../../board/useBoardEnvironmentId";
import { BoardInput } from "../../board/ui/BoardInput";
import { BoardButton } from "../../board/ui/BoardButton";

/** Settings → Board → General: the board server, display, the
    project list with its import notices, the global pipeline, the capacity note and lifecycle.
    Workers have their own page.
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

  return (
    <>
      <DisplaySection board={board} update={update} />
      {/* Committed t3o.json files waiting to import. */}
      <BoardImportNotices />
      <ProjectsSection board={board} environmentId={environmentId} update={update} />
      <BoardPipelineSection />
      <BoardCapacityNote />
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
      <p className="mb-2 max-w-xl px-3 text-board-13 leading-board-1-55 text-muted-foreground/80 sm:px-4">
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
                "min-w-0 truncate text-board-13-5 font-medium",
                hidden ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {project.title}
            </span>
            {hidden ? (
              <span className="shrink-0 rounded-full border border-border px-1.75 py-px text-board-11 font-medium text-muted-foreground">
                Hidden
              </span>
            ) : null}
            <span className="min-w-2 flex-1" />
            <BoardInput
              key={`${project.id}:${entry?.keyPrefix ?? ""}`}
              defaultValue={entry?.keyPrefix ?? ""}
              placeholder={DEFAULT_BOARD_KEY_PREFIX}
              aria-label={`Card key prefix for ${project.title}`}
              className="h-7.5 w-24"
              look="key-prefix"
              onBlur={(event) => {
                const next = normalizeKeyPrefixInput(event.target.value);
                if (next !== (entry?.keyPrefix ?? null))
                  setProject(project.id, { keyPrefix: next });
              }}
            />
            <div className="flex shrink-0 items-center gap-0.5">
              {/* The project's pipeline, CI and t3o.json. */}
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
              <BoardButton
                variant="ghost"
                size="icon-sm"
                look={hidden ? "muted-pressed" : "muted"}
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
              </BoardButton>
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

// ── Capacity ───────────────────────────────────────────────────────────

/**
 * T3o: the board's concurrency limits are gone (T3O-86). Each worker decides what it offers,
 * and each project's baseline says what a card reserves; this note points at both.
 */
function BoardCapacityNote() {
  const anchor = searchableSetting("board-concurrency");
  return (
    <SettingsSection id="board-concurrency" title={anchor.title} variant="plain">
      <BoardSettingsCard>
        <p className="py-1 text-board-13-5 text-muted-foreground">
          Limits are now{" "}
          <Link to="/settings/board/workers" className="text-foreground underline">
            this server's capacity
          </Link>{" "}
          and each project's baseline, set on its Resources tab.
        </p>
      </BoardSettingsCard>
    </SettingsSection>
  );
}

// ── Display ────────────────────────────────────────────────────────────

function DisplaySection({ board, update }: { board: BoardSettings; update: UpdateFn }) {
  const anchor = searchableSetting("board-auto-collapse-empty-stages");
  const emphasis = searchableSetting("board-cost-emphasis");
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
      <BoardSettingsCard id="board-cost-emphasis">
        <BoardSettingsCardRow
          label={emphasis.title}
          description="A Done card that cost at least this many dollars shows its cost in full ink, and the List's Over filter uses the same amount. Applies to everyone using this board."
          control={
            <NumberStepper
              value={Math.max(1, Math.round(board.display.costEmphasisUsd))}
              min={1}
              max={10000}
              ariaLabel={emphasis.title}
              onChange={(value) => {
                if (value !== board.display.costEmphasisUsd) {
                  update({ board: { display: { costEmphasisUsd: value } } });
                }
              }}
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

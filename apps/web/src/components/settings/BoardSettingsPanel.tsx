/**
 * Settings > Board > General. Reads and writes the board server's settings via
 * `useBoardSettings` / `useUpdateBoardSettings`. Config is keyed by stage id
 * and frozen onto a card at stage entry, so edits apply on the next entry.
 */
import {
  DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS,
  DEFAULT_BOARD_RECLAIM_WORKTREE_ON_DONE,
  type BoardSettings,
} from "@t3tools/contracts";

import { Switch } from "../ui/switch";
import { NumberStepper } from "./BoardPipelineSection";
import { BoardSettingsCard, BoardSettingsCardRow } from "../../board/settings/boardSettingsCards";
import { searchableSetting } from "./settingsSearch";
import { SettingsSection } from "./settingsLayout";
import { BoardServerSection } from "../../board/BoardServerSettings";
import {
  useBoardEnvironment,
  useBoardSettings,
  useUpdateBoardSettings,
} from "../../board/useBoardEnvironmentId";

/** Settings → Board → General: the board server, display and lifecycle. Pipeline, Projects
    and Workers have their own pages.
    The layout resolves the board server first. */
export function BoardSettingsPanel() {
  const resolution = useBoardEnvironment();
  return (
    <>
      <BoardServerSection />
      {/* Without a reachable board server there are no settings to show or save; the sections
          would only read defaults and drop every edit. */}
      {resolution.kind === "ready" ? <BoardSettingsSections /> : null}
    </>
  );
}

/** The board server's own settings; rendered only once that server resolves. */
function BoardSettingsSections() {
  const board = useBoardSettings((settings) => settings.board);
  const update = useUpdateBoardSettings();

  return (
    <>
      <DisplaySection board={board} update={update} />
      <LifecycleSection board={board} update={update} />
    </>
  );
}

type UpdateFn = ReturnType<typeof useUpdateBoardSettings>;

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
        auto-archive off ({DEFAULT_BOARD_AUTO_ARCHIVE_AFTER_DAYS} days when on).
      </p>
    </SettingsSection>
  );
}

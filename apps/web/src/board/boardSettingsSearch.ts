/**
 * T3o board settings search index (t3o-07).
 *
 * Spread into the core `SETTINGS_SEARCH_ITEMS` (`components/settings/settingsSearch.ts`)
 * as `...BOARD_SETTINGS_SEARCH_ITEMS` — a t3o-02a registry spread, so each
 * board setting is findable beside the settings it belongs to without
 * enumerating board entries in that upstream-owned file. New board settings
 * register here, next to the panel section they anchor to. `targetId`s match
 * the section/row `id`s in `BoardSettingsPanel`.
 */
import type { SettingsSearchItem } from "../components/settings/settingsSearch";

export const BOARD_SETTINGS_SEARCH_ITEMS = [
  // T3O-71: which server's board this device shows.
  {
    id: "board-server",
    title: "Board server",
    to: "/settings/board",
    searchTerms: ["central board remote environment connection"],
  },
  // T3O-40: board display preferences.
  { id: "board-display", title: "Board display", to: "/settings/board" },
  {
    id: "board-auto-collapse-empty-stages",
    title: "Auto-collapse empty stages",
    to: "/settings/board",
    targetId: "board-display",
    searchTerms: ["fold hide empty columns"],
  },
  { id: "board-projects", title: "Projects", to: "/settings/board" },
  {
    id: "board-key-prefix",
    title: "Card key prefix",
    to: "/settings/board",
    targetId: "board-projects",
  },
  {
    id: "board-project-visibility",
    title: "Hide a project from the board",
    to: "/settings/board",
    targetId: "board-projects",
  },
  // T3O-49: the global stage list has its own page.
  {
    id: "board-pipeline",
    title: "Pipeline",
    to: "/settings/board/pipeline",
    searchTerms: ["stages default for projects continuous integration ci round trips"],
  },
  // T3O-49: each project's pipeline, CI and t3o.json live on its own page,
  // reached from the project list.
  {
    id: "board-project-pipelines",
    title: "Project pipelines and CI",
    to: "/settings/board",
    targetId: "board-projects",
    searchTerms: ["t3o.json import export per project stages override ci steps"],
  },
  {
    id: "board-default-model",
    title: "Board default model",
    to: "/settings/board/pipeline",
    targetId: "board-pipeline",
  },
  { id: "board-concurrency", title: "Board concurrency", to: "/settings/board" },
  // T3O-62: the distributed board.
  { id: "board-workers", title: "Workers", to: "/settings/board" },
  {
    id: "board-default-worker",
    title: "Default worker",
    to: "/settings/board",
    targetId: "board-workers",
  },
  { id: "board-project-checkouts", title: "Project checkouts", to: "/settings/board" },
  {
    id: "board-reclaim-worktree-on-done",
    title: 'Reclaim worktrees at "Done"',
    to: "/settings/board",
    targetId: "board-lifecycle",
  },
  {
    id: "board-auto-archive-done",
    title: "Auto-archive Done cards",
    to: "/settings/board",
    targetId: "board-lifecycle",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

/** Breadcrumb labels for Settings → Board's own pages (T3O-49). */
export function boardSettingsBreadcrumbLabel(pathname: string): string | null {
  if (pathname.startsWith("/settings/board/projects/")) return "Board project";
  return null;
}

/** Anchors that moved from the single board page to its Pipeline page
    (T3O-49), so an old `/settings/board#board-pipeline` link still lands. */
export function isBoardPipelinePageAnchor(hash: string): boolean {
  const anchor = hash.replace(/^#/, "");
  return anchor === "board-pipeline" || anchor === "board-default-model";
}

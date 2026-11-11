/**
 * Board settings search entries, spread into the core `SETTINGS_SEARCH_ITEMS`
 * so the upstream file needs no per-entry edits. `targetId`s match the section
 * and row ids in the board settings panels.
 */
import type { SettingsSearchItem } from "../components/settings/settingsSearch";

export const BOARD_SETTINGS_SEARCH_ITEMS = [
  // Which server's board this device shows.
  {
    id: "board-server",
    title: "Board server",
    to: "/settings/board",
    searchTerms: ["central board remote environment connection"],
  },
  // Board display preferences.
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
  {
    id: "board-pipeline",
    title: "Pipeline",
    to: "/settings/board",
    searchTerms: ["stages default for projects continuous integration ci fix attempts"],
  },
  // Each project's pipeline, CI and t3o.json live on its own page,
  // reached from the project list.
  {
    id: "board-project-pipelines",
    title: "Project pipelines and CI",
    to: "/settings/board",
    targetId: "board-projects",
    searchTerms: ["t3o.json import export per project stages override ci steps stop on failure"],
  },
  {
    id: "board-default-model",
    title: "Board default model",
    to: "/settings/board",
    targetId: "board-pipeline",
  },
  { id: "board-concurrency", title: "Board concurrency", to: "/settings/board" },
  // The distributed board.
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

/** Breadcrumb labels for Settings → Board's own pages. */
export function boardSettingsBreadcrumbLabel(pathname: string): string | null {
  if (pathname.startsWith("/settings/board/projects/")) return "Board project";
  return null;
}

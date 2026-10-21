repo: brentkelly/t3code
branch: main
path: apps/web/src

## Last sync

date: 2026-10-21T09:59:18Z

### Updated in this project

- Added Distributed Board.dc.html: workers, project checkouts, per-worker concurrency, card worker picker/chip, move dialogs, notices, thread access.
- docs/t3o/status-colours.md not found on main; colours follow the rules given in the brief.

## Sync history

- 2026-08-03T09:31:01Z — Built Kanban board mode on the t3code shell; tokens from apps/web/src/index.css; lucide icons; sidebar and top-bar controls matched.

## Screen map

| Screen                                               | Repo files                                                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T3 Code Kanban.dc.html — app chrome, sidebar, topbar | apps/web/src/index.css, apps/web/src/components/AppSidebarLayout.tsx, apps/web/src/components/SidebarV2.tsx                                                     |
| Sidebar header art                                   | apps/web/src/components/SidebarStageBackdrop.tsx                                                                                                                |
| Sidebar rows / search / project scope                | apps/web/src/components/ui/sidebar.tsx, apps/web/src/components/SidebarV2.tsx                                                                                   |
| Top-bar control cluster                              | apps/web/src/components/ProjectScriptsControl.tsx, apps/web/src/components/ui/button.tsx                                                                        |
| Board, cards, columns                                | apps/web/src/components/ui/card.tsx, apps/web/src/components/ui/badge.tsx                                                                                       |
| Distributed Board.dc.html — all worker surfaces      | apps/web/src/index.css, apps/web/src/components/ui/dialog.tsx, apps/web/src/components/ui/button.tsx                                                            |
| Task modal / create dialog / artifact drawer         | apps/web/src/components/ui/dialog.tsx, apps/web/src/components/ui/dialog-styles.ts, apps/web/src/components/ui/button.tsx, apps/web/src/components/ui/input.tsx |

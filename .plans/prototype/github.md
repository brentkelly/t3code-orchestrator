repo: brentkelly/t3code
branch: main
path: apps/web/src

## Last sync
date: 2026-08-03T09:31:01Z

### Updated in this project
- Built a Kanban board mode on top of the t3code workspace shell (top-level Threads / Board switch).
- Theme, radii, typography and control styles lifted from `apps/web/src/index.css` tokens (light + dark).
- Chrome icons redrawn from the real lucide-react set used across the app; sidebar header now uses the actual nightly stage art.
- Sidebar rows match `sidebarMenuButtonVariants`; top-bar controls match Button `size="xs" variant="outline"`.

## Screen map
| Screen | Repo files |
| --- | --- |
| T3 Code Kanban.dc.html — app chrome, sidebar, topbar | apps/web/src/index.css, apps/web/src/components/AppSidebarLayout.tsx, apps/web/src/components/SidebarV2.tsx |
| Sidebar header art | apps/web/src/components/SidebarStageBackdrop.tsx |
| Sidebar rows / search / project scope | apps/web/src/components/ui/sidebar.tsx, apps/web/src/components/SidebarV2.tsx |
| Top-bar control cluster | apps/web/src/components/ProjectScriptsControl.tsx, apps/web/src/components/ui/button.tsx |
| Board, cards, columns | apps/web/src/components/ui/card.tsx, apps/web/src/components/ui/badge.tsx |
| Task modal / create dialog / artifact drawer | apps/web/src/components/ui/dialog.tsx, apps/web/src/components/ui/dialog-styles.ts, apps/web/src/components/ui/button.tsx, apps/web/src/components/ui/input.tsx |

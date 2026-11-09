import type { BoardCardActivityKind } from "@t3tools/contracts";

const LABELS: Partial<Record<BoardCardActivityKind, string>> = {
  "card-created": "Created",
  "card-moved": "Moved",
  "card-project-changed": "Moved project",
  "plans-proposed": "Plans proposed",
  "plan-written": "Plan written",
  "plans-approved": "Plans approved",
  "card-step-completed": "Step completed",
  "card-input-requested": "Input requested",
  "card-archived": "Archived",
  "card-unarchived": "Restored",
  "card-worktree-failed": "Worktree failed",
  "card-pull-request-linked": "Pull request linked",
  "card-pull-request-state-changed": "Pull request updated",
  "card-pull-request-merged": "Pull request merged",
};

export function boardActivityLabel(kind: BoardCardActivityKind): string {
  return LABELS[kind] ?? kind.replace(/^card-/, "").replaceAll("-", " ");
}

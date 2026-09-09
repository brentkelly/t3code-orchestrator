# UI spec — New-task drafts & moving a task between projects

## 1. New-task draft persistence

**Goal:** nothing typed into the New task modal is lost by accident.

**Save**

- While the modal is open, save the draft to local storage (one draft, key `t3-kanban-new-card-draft`).
- Saved fields: title, brief HTML, project, base branch, workflow, labels, dependencies, start-time setting, target stage.
- Not saved: file attachments (blobs can't be serialised).
- Save continuously while the modal is open (autosave every ~0.7s is enough), and once more on close.
- A draft only counts as a draft if title, brief, or dependencies have content. Otherwise clear the stored draft.

**Close vs discard**

- X, backdrop click and Esc = close and keep the draft.
- The footer button is the only destructive path:
  - draft has content → label "Discard draft", destructive hover (red border/text), clears storage and closes.
  - draft empty → label "Cancel", plain close.
- When the draft has content, show muted text left of that button: "Closing keeps this draft".

**Restore**

- Opening New task with a stored draft loads all saved fields and shows an info banner at the top of the modal body:
  - text: "Unsaved draft restored. Attachments aren't kept."
  - button: "Start fresh" — clears storage and all fields, modal stays open.
- The stage the modal is opened from is overridden by the draft's saved stage.
- Creating the task clears the stored draft.

## 2. Change a task's project after creation

**Where:** card detail modal, side panel, the "Project ·" row.

**Rule:** editable while the task is before Building. From Building onward it is pinned (a worktree and branch exist).

**Editable state**

- Row renders as a dropdown button: project dot, project name, chevron. Tooltip: "Move this task to another project".
- Menu (200px wide, opens upward, left-aligned) lists all projects with:
  - project dot + name
  - the ID the task would be reissued as, right-aligned in mono (e.g. `MW-43`)
  - check mark on the current project
- Note above the options: "Moving reissues the task ID and resets the base branch and dependencies."

**On selecting a different project**

1. Reissue the key using the new project's prefix and its next free number (T3-, MW-, RL-).
2. Set base branch to the new project's default branch.
3. Clear the task's own dependencies.
4. Remove the task's old key from any other task's dependency list.
5. Card id stays the same, so the open modal and board position are unaffected.

**Locked state**

- Row renders as plain text: dot + project name + small padlock glyph.
- Tooltip: "Pinned — the build has a worktree on this project".

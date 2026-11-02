# Grouping, nested boards and List view: implementation brief

This brief describes the changes to make in the production app. The prototype in `t3o.dc.html` is the reference for behaviour and visuals. It doesn't describe the production code, and its data shapes are illustrative, so map them onto your own models.

Reference points in the prototype are given as **method names** (logic, in the `Component` class) and **template hooks** (the `{{ name }}` values a block binds to). Search the file for either one to find the code.

---

## 1. Model

- **A group is a card with children, and a leaf is a card without them.** Only leaves move through the pipeline (Planning → Ready → Building → Code review → Ready for merge → Done).
- **Nesting.** Groups nest to any depth. A child records its parent in `parentKey`.
- **Group settings** live on the group card as `group`:
  ```
  { target: "inherit" | "own", branch, autoBuild, autoMerge, autoPlan,
    started, placed, prevStatus, integrated, heading }
  ```
  - `placed` is the column the human put the group in.
  - `prevStatus` is the leaf stage the card had before it became a group, so it can be restored.
  - `heading` marks an empty group the user created on purpose. A group stays a group while it has `group` set, even with no children.
  - See `GROUP_DEFAULT`.
- **The group's stage is derived, never set by hand.** See `syncGroups()`, which runs after every change to cards (it's called from `sweepAutoStart()`).
  - **Done** when every *active* child is done. Active means every child not in Deferred.
  - With an own branch, the group first shows **Code review** (the integration review) until `integrated` is set.
  - **Building** while any active child is at Building or later.
  - Otherwise it sits in `placed`.
- **Merge target.**
  - `targetOf(g)` gives where a group's children merge: its own branch, otherwise inherited from its parent, otherwise trunk.
  - `landsOn(c)` gives where a card itself merges.
- **Started.** A leaf is started from Building onward (it has a worktree or branch). See `isStarted()`.
- **Deferred.** This stage exists **only on sub-boards** (`DEFERRED`, `SUB_STAGES`). Moving a deferred card to the root board turns it into a Backlog card.
- **Grouping alone never touches git.**

## 2. Status colour vocabulary (fixed)

| Colour | Meaning |
| --- | --- |
| green (`--success`) | done, and only done |
| blue (`--info`) | running |
| violet (`--attention`) | waiting on a human |
| amber (`--warning`) | blocked |

- **Group colours.** Group progress pips and counts follow this table (`pipStyle()`, `groupStats()`). A group with deferred children left is not green.
- **Planned / Needs planning badges** (split gate) are deliberately neutral.
- **Unclear decisions** (decision log) use violet, because they need human review.

## 3. Group cards on a board

Template hook: `c.group`. Logic: `groupCardVm()`.

- **Look.** Keep the existing stacked-card shadow; it already marks a card as a group.
- **Contents:**
  - one pip per active child
  - `n/m` done
  - "N need(s) you" in violet and "N blocked" in amber
  - a **Board ›** button that drills in
  - a meta line: `+N deferred · → branch` (shown only for own branch) and the auto-build state
- **Stats truncate; the Board button never wraps.**
- **Hidden on group cards:** the group's own thread, review, todo, PR and plan-count indicators. Its pipeline is paused.
- **Board filter.** Each board (the root and every sub-board) and the List view keep their own filter text (`queryKey()`, `queryFor()`).

### Drag rules for groups

Logic: `dropRefusal(card, toStatus)`. A refused column gets a dashed outline, and a tooltip follows the cursor (`dragTip`). Don't call `preventDefault` there, so the browser shows a no-drop cursor.

| Drag target | Result |
| --- | --- |
| Backlog / Sprint / Planning | Moves the heading only (updates `placed`). Refused if the group is already live. |
| Building | The "start" gesture. Opens a confirmation (dialog `kind: "start"`, `startGroup()`). |
| Building, auto-build on | Sets `started`, and the cascade begins. |
| Building, auto-build off | A one-off start of the ready, unblocked children. |
| Building, no ready children | Refused: "No children are ready to start." |
| Ready | Refused. |
| Code review / Ready for merge / Done | Refused, with a tooltip explaining they're reached automatically. |
| Backwards out of Building while children are active | Refused. The tooltip says to turn off auto-build to pause. |

- **Deferred column.** A started card can't be dragged into Deferred.

## 4. Sub-board

Reached by drilling into any group. Logic: `buildBoard()` with `opts.drill`.

- **Columns:**
  - Deferred, then every normal stage.
  - Empty columns before Ready, and an empty Deferred column, **auto-collapse**. This keeps a fully planned split looking like today's sub-board.
  - A user's manual expand or collapse overrides the auto-collapse (`setColCollapsed()`).
- **Header:**
  - a breadcrumb of the group's ancestors
  - the key and title
  - `n/m done · N deferred`
  - the resolved target chip `→ branch`
  - the auto-build state
  - Dependency chart and **Group settings** popover buttons
  - **Back** goes up one level.
- **Deferred column:**
  - A hint line: "Not this round. Doesn't count toward done."
  - A **New phase** button (`openPhase()`, `confirmPhase()`).
  - The dialog lists the deferred cards, all ticked to start with.
  - The title is pre-filled `‹Group›: Phase 2`, or `Phase n+1` if the title already ends in `: Phase n`.
  - Confirming creates a **sibling** group in the parent's Backlog and moves the ticked cards into its Backlog.
- **Final review banner.** Shown only when the group has its own branch.

## 5. Group settings

Logic: `groupSettingsVm()`. The same controls appear in two places: the sub-board header popover, and the group card's popup window (`groupSettings`).

- **Merge target.**
  - A segmented control: Inherit / Own integration branch.
  - Shows the resolved target, plus a note on where the group's own review merges.
  - Locked while any descendant leaf has started; the reason is shown.
- **Auto-build.**
  - When on, ready children with their dependencies met start themselves once the group is `started` (`autoBuildsFor()`, `sweepAutoStart()`).
  - The note changes between "armed", "on" and "off".
  - Turning it off never interrupts a running child.
- **Auto-merge to trunk.**
  - Enabled only when the resolved target is trunk. Off by default.
  - When off, children stop at Ready for merge unless they have their own per-card override.
  - Children merging into an integration branch auto-merge under auto-build (`autoMergeOn()`).
- **Auto-plan.** Children entering Planning are planned by the agent, get a decision log, and stop at Ready (in `sweepAutoStart()`).

## 6. Card popup for a group

- **Header:** a "Group · N cards" chip.
- **Action area:**
  - **Open board** (primary) plus a one-line explanation of why the group is in its current stage (`groupNote`).
  - No progress or advance button.
- **Side panel:** the Group settings section replaces Workflow and Stage.
- **Tabs:**
  - Plans/Cards (the children in dependency order), Plan, Brief.
  - The thread tab is locked while the planning thread is settled.
- **Plan pane:** a **Planning thread** box (`planThreadVm()`) with "Reopen thread".
  - When deferred cards exist, it suggests planning them as the next phase.
  - Reopening unlocks the thread tab and pre-fills the composer.
- **Archive (in the ⋯ menu):** opens the archive confirmation instead of archiving straight away.
- **Leaf child of a group:** its Stage list also includes Deferred.

## 7. Split approval gate

Rendered at the end of the planning thread for cards with a pending proposal. Template hook: `cardThread.proposal`. Logic: `proposalVm()`, `approveSplit()`.

- **Each child row** shows:
  - its number and title
  - its dependencies
  - a **Planned** badge (solid outline, document-check icon) or a **Needs planning** badge (dashed)
  - where it lands: `→ Ready` / `→ Backlog`
- **Agent's recommendation.** Auto-build (switch) and merge target (segmented control) arrive pre-set to it and stay editable.
  - The footer states the recommendation.
  - If edited, it says so and offers **Use recommended**.
- **Approving:**
  - Creates the children: Planned → Ready with a plan, Needs planning → Backlog with a brief only.
  - Sets the group settings and keeps the group in Planning.
  - **Starts nothing.**
- **Ask for changes:** pre-fills the composer.
- **Sample data** (`PROPOSALS`):
  - T3-193 is the fully planned case: auto-build on, own branch.
  - T3-216 is the epic case: auto-build off, inherit.
- **Board card.** While a proposal is pending, the card shows violet "Input needed" and "Split proposed · N cards".

## 8. Auto-plan and the decision log

- **Auto-plan button.** "Auto-plan → Build", a secondary button in the action area of any leaf in Planning without a pending proposal (`canAutoPlan`, `autoPlan()`).
  - The tooltip explains that it ends planning, decides what's left, approves the plan and starts building.
  - The plan is always approved, even when decisions are flagged unclear.
  - The card moves to Building and the Summary pane opens with the log expanded.
- **Decision log.** A collapsible section on the Summary pane (`decisionVm()`, template hook `decisionLog`).
  - It's recorded for every planning session. The Summary tab now appears from Ready onward when a log exists, with "The build summary appears here when the build finishes" until then.
  - **Each entry:** the question, the decision, a one-line reason, who decided (Agent/You), and a flag of normal, important or unclear.
  - **Order:** unclear first, then important, then normal. Unclear rows have a violet tint and badge; important rows have a neutral outlined badge.
  - **Header:** the count plus a flag summary.
  - **Default state:** open by default for auto-planned cards with unclear entries.
  - **Auto-planned cards past Building** show **Send back to build with changes** and **Create follow-up card**.

## 9. List view (new top-level mode)

A tab between Board and Threads. Logic: `listVm()`.

- **Layout.**
  - An indented outline of the card tree for the current project scope.
  - Columns: Name, Stage, Status, Progress, Merges into. Rows are 35px.
  - Each row has a faint bottom border at about 7% of the foreground colour.
  - Indent is 22px per level. Deferred rows are dimmed.
- **Name cell:**
  - an expand/collapse caret (groups only)
  - a checkbox
  - the key pill and title (bold for groups)
  - the child count
  - a board icon to drill in (groups only)
  - an **eye** icon for "View details", which opens the card popup
- **Status cell:**
  - Leaves: Needs you (violet), Running (blue), Blocked (amber).
  - Groups: roll-up counts in the same colours.
- **Progress cell:** mini pips plus `n/m`, for groups only.
- **Selection.**
  - Click selects one row, shift-click selects a range, cmd/ctrl-click toggles.
  - Esc clears the selection. Double-click opens the card.
- **Toolbar, nothing selected:**
  - scope name and counts
  - a **stage filter** (multi-select checklist with counts, plus "Show all stages")
  - a short hint
  - **New group** (an empty heading)
- **Toolbar, with a selection:**
  - **Indent** (Tab) and **Outdent** (⇧Tab), each disabled with a reason when not possible
  - **Move to…** (a tree picker that includes "Top level")
  - **Group into new…**
  - **Archive** (only when one row is selected)
  - **Clear**
- **Indent and outdent.**
  - Indent puts the selection under the previous sibling (`listIndentTarget()`).
  - Outdent puts it directly after its parent, one level up (`listOutdentInfo()`).
  - Both require the selected cards to share a parent.
- **Drag and drop** (row `onDragOver` / `onDrop` in `listVm()`):
  - Dragging a selected row moves the whole selection.
  - The top or bottom 28% of a target row inserts before or after it, at the same level, shown as a 2px line.
  - The middle nests the cards inside it, shown as a filled, outlined row.
  - The dragged cards and their subtrees are invalid targets and are dimmed.
- **Filtering** (the text box plus stage filter):
  - Rows that match, and ancestors of matching rows, are shown.
  - Ancestors kept only for context are dimmed, and groups expand automatically.
  - Memoise by card id, not key.

All moves (toolbar, keyboard, drag) go through one function, `tryMove(ids, parentKey, afterId, beforeId)`, which applies the guard rails below.

## 10. Guard rails and dialogs

One generic dialog shell (`dialogVm()`, template hook `dlg`) with optional parts: options, a title input, checkboxes, an item list, a losses box and a typed-ID confirmation. Enter confirms.

- **Moving a card inside itself:** refused with an error toast.
- **Cross-project groups:** refused.
- **Moving a started card into a group whose resolved target differs:**
  - Refused with an error toast ending "Rebase onto `‹target›` first."
  - Descendants that sit under an own-branch group keep their target and aren't checked.
- **Making a started leaf the parent** (dialog `kind: "started"`, `confirmStarted()`):
  - **Option 1, Create a shared parent** (the default): asks for a title, then puts X and the moved cards side by side under a new group. No typed confirmation.
  - **Option 2, Cancel work on X and make it the parent:** destructive and shown in red. Lists what's abandoned (commits on the branch, the thread stopping, the PR closing or the branch deleted) and requires typing the card ID.
  - **Option 3:** Cancel.
- **Archiving a group** (dialog `kind: "archive"`, `confirmArchive()`):
  - Always warns, listing children building, PRs open and branches to be deleted (remote copies included).
  - Notes that unarchiving restores cards, plans and history but not branch work.
  - Requires typing the card ID.
  - Archives the whole subtree.
- **A group losing its last child** (by outdent, move or drag):
  - It reverts to an ordinary card at `prevStatus`, capped at Sprint (`revertEmpty()`).
  - A toast says so.
- **Toasts.**
  - Neutral for info, red-tinted for errors, with an optional action ("Open", "Open board").
  - They auto-dismiss after 6s (9s for errors).

## 11. Constraints

- No continuously repainting animations in the new UI. The status dots are static.
- Agents can propose a regrouping but never apply one without approval. If you build that, reuse the split-gate pattern from section 7.
- Desktop and web only.

## 12. Sample data in the prototype

Useful for checking behaviour. The stage for each group is derived, as in production.

| Card | What it demonstrates |
| --- | --- |
| T3-200 | An epic group (inherit, auto-build off). Children in every state, two deferred. Its child T3-208 is a nested group with its own Deferred child. |
| T3-188 | Today's sub-board case (own branch `feat/board-mode`, auto-build on and started). |
| T3-193 / T3-216 | Pending split gates (fully planned and epic). |
| T3-196 | Try Auto-plan → Build. |
| T3-202 | An auto-planned decision log with an unclear entry. |
| T3-179 | A human-led decision log. |
| List view | Select T3-182 and press Tab to get the started-card dialog. Move T3-186 into T3-188 to get the refused-move error. Archive T3-200 to get the subtree warning. |

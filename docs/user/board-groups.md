# Groups on the board

A group is a card that holds other cards. Its column follows its children: it moves to **Building**
once any child is underway, and to **Done** once every child that counts is done. You never move a
group through the later columns by hand.

## Reading a group card

A group card wears a stacked edge. Instead of a thread or a pull request it shows one bar per child,
how many are done (`3/5`), how many need you (violet) and how many are blocked (amber), and a line
with any deferred cards, its own branch if it has one, and whether auto-build is on.

## Opening a group's board

Select **Board ›** on the card, or **Open board** in its popup, to see the group's cards on their own
board. Groups nest: open a group inside a group the same way. The breadcrumb names every level, and
**Back** goes up one level at a time.

From the keyboard, **Alt+↓** on a focused group card opens its board and **Alt+↑** goes back up. The
command palette has both too: **Open ‹key›'s board** for the selected group, and **Board: back up one
level**.

Each board keeps its own filter text, so filtering inside a group leaves the main board as it was.

## Starting a group

Drag the group to **Building**. You are asked to confirm first:

- With **Auto-build** on, the group is armed: ready children start now, and the rest start as they
  become ready with their dependencies met. This works even when nothing is ready yet.
- With it off, the ready children with no unmet dependencies start once. Children that become ready
  later wait for you.

Dragging a group to **Backlog**, **Sprint** or **Planning** only moves where it sits, and only before
any child has started. A column the group can't go to shows a dashed outline while you drag, and a
note by the pointer says why. To pause a group that is building, turn off auto-build: running
children finish and no new ones start.

## Deferred and the next phase

Inside a group, the **Deferred** column holds work set aside for a later round. Deferred cards don't
count toward the group being done. A card that has started can't be deferred.

Select **New phase** in the Deferred column to move deferred cards into a new group next to this one,
in its parent's Backlog. Every deferred card starts ticked, and the title is filled in for you as
`‹Group›: Phase 2` (or the next number, if the group is already a phase).

## Group settings

Open **Group settings** from the group board's header, or from the group's popup:

- **Merge target** — **Inherit** sends children wherever the group itself merges. **Own branch**
  gives the group an integration branch that its children merge into, reviewed and merged on as a
  whole once they are all done. It can't change once a child has started.
- **Auto-build** — ready children start themselves once the group has started.
- **Auto-merge to trunk** — children merge as soon as the forge accepts. It applies only when they
  merge into trunk, and is off by default.
- **Auto-plan** — children entering Planning are planned by the agent and stop at Ready.

## Regrouping in the List view

The **List** tab, between Board and Threads (also **Go to List** in the command palette), shows
every card in the project scope as an outline, with each group's children indented under it. It
uses the same project picker as the board and keeps its own filter text. Filtering by text or by
stage keeps the matching cards and the groups above them; those groups are dimmed and open
automatically.

Click a row to select it, shift-click to select a range, and Cmd/Ctrl-click to add or remove one.
Escape clears the selection, and double-click opens the card. With cards selected:

- **Indent** (Tab) puts them under the card just above them. **Outdent** (Shift+Tab) moves them out
  of their group, to just after it. Both need the selected cards to share a parent, and each says
  why when it can't be used. Tab only does this while the list has focus.
- **Move to…** picks any group, or the top level.
- **Group into new…** creates a group where the cards sit and moves them into it. **New group**,
  with nothing selected, creates an empty one to fill later.
- **Archive** archives one card. A group asks first, as above.

You can also drag rows. Dropping on the top or bottom edge of a row places the cards beside it;
dropping on the middle puts them inside it. Moving cards never touches git, but some moves are
refused: a card can't go inside itself, a started card can't move somewhere that merges into a
different branch until it is rebased, and a card can't join a group whose integration branch lives
in another project's repository. Putting cards under a card that has already started asks whether to
create a shared parent for both instead. A group that loses its last child becomes an ordinary card
again, back in Sprint at the latest.

## Archiving a group

Archiving a group archives everything inside it, and it always asks first. The warning lists the
children still building, the pull requests that close, and the branches that are deleted, remote
copies included. Type the group's key to confirm. Restoring the group brings back its cards, plans
and history, but not the work on their branches.

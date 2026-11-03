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

## Archiving a group

Archiving a group archives everything inside it, and it always asks first. The warning lists the
children still building, the pull requests that close, and the branches that are deleted, remote
copies included. Type the group's key to confirm. Restoring the group brings back its cards, plans
and history, but not the work on their branches.

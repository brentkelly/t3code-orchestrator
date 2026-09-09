# Moving a card to another project

A card belongs to a project, and the project is where its work happens: the repository the agent
checks out, the branch it cuts, the pull request it opens. You pick it when you create the card, and
if you picked wrong you can change it — up until the card starts building.

## Changing it

The card's detail shows **Project ·** with a dot and the project's name, next to Base and Branch.
While the card is still changeable, that row is a dropdown.

The menu lists your projects, and against each one it shows the ID the card would be reissued as —
`MW-43`, `RL-19` — so you can see what the card is about to be called before you commit to it. A
check marks the project the card is in now.

Choosing a different project asks you to confirm, and the dialog says exactly what is about to
happen. It always asks, because one part of the move cannot be taken back.

## What the move changes

**The card gets a new ID.** A card is numbered within its project, so moving it means reissuing it
under the new project's prefix. The old ID is retired for good: it is not handed to the next card
created in the old project, and moving the card back does not give it back — you get a third ID, not
the first one. That is the part worth pausing over, because the old ID may already be written down
somewhere.

**Its base branch resets** to the new project's default. A branch you named by hand belongs to the
old repository and almost certainly does not exist in the new one, so the card goes back to
following whatever the new project's default branch is. If you want something else there, pick it
again after the move.

**A running agent is stopped.** If the card is mid-conversation — a planning interview, say — that
agent is working in the old repository, so it is stopped and its thread let go. The work it produced
is not lost: a plan lives on the card, not in the conversation.

**The stage starts again** in the new project, on a new thread, if that stage runs by itself. A card
sitting in Backlog or Sprint has nothing running, so nothing restarts.

## What the move leaves alone

The card itself is the same card. Its title, brief, attachments, labels, checklist, schedule and
model choices all come with it, and it keeps its place in the column it is standing in — so the
board does not jump under you and an open card stays open.

Its dependencies come too, including ones that now point at cards in a different project. That is
allowed: dependencies are between cards, not within a project, and you can pick a card from another
project in the dependency list yourself. Cards from elsewhere are marked with their project's dot.
On a big board that list is long, so it shows the first fifty and counts the rest — type to narrow
it and the card you want comes to the top.

Threads already attached to the card stay attached, and stay where they are — a conversation cannot
move between projects. If you send another message in one, it still runs against the old
repository. The confirmation dialog tells you how many threads that applies to.

## When you cannot move it

From **Building** onward the project is pinned, and the row becomes plain text with a padlock. Hover
it and it says why.

The reason is not really the column the card is in — it is that something with the old project's
name on it already exists. A card that has been built has a worktree and a branch cut in that
repository, and if it has ever opened a pull request its old ID is printed on it. Dragging such a
card back to **Ready** does not unpin it, because none of that has gone away.

Two other cards are pinned as well:

- **A card inside a sub-board** takes its project from the card it was split out of, and branches
  off that card's integration branch. There is nothing to choose.
- **A card that has been split** builds through its children, so moving it would have to reissue
  every child's ID and stop every child's agent. Move it before you split it, or not at all.

## What is offered in the menu

Projects you have hidden from the board are left out — moving a card into one would make it vanish —
and so are projects that are not on this machine, which would fail later, when the card tried to
build. The card's own project is always shown, so the row can always tell you where the card
actually is.

The ID beside each project is a preview of the next number free there. It is almost always the one
you get; a card created in that project a moment before yours can move it by one.

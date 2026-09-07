# Choosing a card's base branch

Every card branches off something. By default that is the project's default branch — whatever
`main` is called in your repository — and most cards never need anything else. When one does, the
base branch is a property of the card, chosen when you create it and changeable afterwards.

## Setting it when you create a card

The **New card** dialog puts **Base branch** beside **Project**, because the base is a branch in
that project's checkout. It opens on the project's default, marked `default` in the list.

The list is searchable, and it covers branches that exist only on your remote as well as local
ones. Picking a remote-only branch stores the plain branch name — the card gets a local copy of it
when it starts building.

Changing the project changes which branches are on offer, so the picker resets to the new project's
default.

Leaving the picker alone is not the same as picking the default by hand: a card that has never
expressed an opinion follows your project's default wherever it goes, so renaming or moving that
default carries the card with it.

That includes cards already building. If you move your project's default while such a card is in
flight, it is treated exactly as though you had retargeted it by hand — amber note, rebase onto the
new default during its next review round. Pick a branch by hand on any card you want left where it
is.

## Changing it on an open card

The card's detail shows **Base ·** with the branch it works against, next to Project and Branch.
The dropdown there is the same picker.

If the card has not started building yet, the change is immediate — nothing has been cut, so there
is nothing to reconcile.

If the card already has a branch, changing the base means the work on that branch has to move.
You are asked to confirm, and the dialog names the card's branch, the branch it was cut from, and
the branch you are pointing it at.

After you confirm, the card carries an amber note saying which branch it was cut from and which one
it is now based on. The note is not a warning you have to dismiss: it disappears on its own once the
card is rebased, and it disappears just as readily if you change your mind and put the base back.

## What actually happens next

The rebase runs during the card's next round of **Code review**. The agent fetches the new base,
rebases the card's branch onto it, resolves any conflicts, runs your project's checks, and
force-pushes with `--force-with-lease`. One more review round then runs on the rebased change before
the card can merge, so nothing reaches **Ready for merge** with a diff nobody reviewed.

If the card already has a pull request open, the same step retargets it at the new base. That has to
happen, because a pull request keeps whatever branch it was opened against: left alone it would show
a diff against the old base and eventually merge into it. If it is somehow left behind, the card says
so at **Ready for merge** and refuses to merge until the pull request and the card agree — you can
retarget it on the forge yourself and click **Merge** again.

If the rebase cannot be finished safely, it stops, leaves the worktree clean, and says why. The card
keeps its amber note, because nothing has been reconciled.

A card you retarget and then never send back through review keeps its note indefinitely. That is
accurate: the card really is pointing at a branch it has not been rebased onto.

## Where the base branch shows up

- **Planning, Building and Code review** are all told which branch the card works against. Planning
  runs in your project folder rather than the card's worktree, so it is also told that what is
  checked out there may not be the code the card will change.
- **Building** cuts the card's branch from the base.
- **Code review** opens the card's pull request against it, and retargets an existing one when you
  change the base.

If the branch you named does not exist anywhere — not locally, not on your remote — the card does
not build. It says which branch it could not find, and you can fix the name and try again. It never
quietly falls back to your default branch: a card that builds off the wrong branch is worse than a
card that has not started.

## Cards inside a sub-board

A card split into a sub-board gives its children an integration branch, and every child branches off
that. Children show their base as read-only, naming the parent it came from — there is nothing to
choose, because choosing it for one child would be choosing it for the split.

The parent's own base branch is what its integration branch is cut from, so basing a split on
`release/2.4` puts the whole split there.

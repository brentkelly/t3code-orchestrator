# Asking an agent to tidy the board

An agent with board access can create cards, move them, and now take them off the board again —
archiving, restoring, and deleting. So "these three are duplicates, archive them" or "drop the card
we decided against" is something you can ask for in chat instead of clicking through the board.

## Archive is the one it reaches for

Archiving is reversible. The card, its threads and its history all survive; it leaves the columns,
stops holding up the cards that depend on it, and stays readable in the archive. An agent can put it
back, too, so a card archived by mistake costs you one more sentence.

Three things it cannot archive: a card that is already archived, a card whose split-off plan cards
are still working, and the card it is working on. It will tell you which children to finish first.
Archiving cleans up a card's checkout, and restoring the card does not bring that checkout back, so
an agent archiving its own card would pull the ground out from under itself mid-sentence — archive
that one yourself from the card's menu.

## Delete is final, and it says so

Deleting a card destroys it. The card leaves the board, the conversations attached to it go with it,
and its worktree and branches are cleaned up — unmerged work on that branch included. Its ID is
never handed out again. The agent is told to prefer archiving and to delete only when you have asked
for the card and its history to be gone.

It cannot delete the card it is working on either, for the same reason and then some: that card owns
the conversation it is speaking to you in as well as the checkout it is running inside. Delete that
one yourself from the card's menu.

A card that has been split cannot be deleted while its plan cards exist, either — those are separate
cards with their own branches, and each one has to go first.

## Finding the card

Ask for a card by name and the agent looks it up by ID, title, or column. Archived cards are off the
board, so they do not show up in an ordinary listing; the agent can include them when it is looking
for something to restore or delete.

An archive or a restore is recorded in the card's activity with the agent named as the actor, so you
can see what it did and when. A delete leaves nothing behind to record it on — that is what deleting
means here.

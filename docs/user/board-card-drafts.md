# Drafts on the New card dialog

Whatever you have typed into the **New card** dialog is kept when the dialog closes. Hit Esc by
mistake, click the backdrop, close the tab, reload the page — the next time you open **New card**
it comes back the way you left it, under a note saying so.

Everything on the dialog is kept: the title, the brief, the project, the base branch, the stage,
labels, dependencies, the clock, and the files you attached.

## Getting back to a blank card

The restored draft carries a **Start fresh** button. It empties the dialog and leaves it open, so
you can start typing the card you actually came here to write.

## Throwing a draft away

The footer button is the only thing that discards. While there is something to lose it reads
**Discard draft**, and the dialog says **Closing keeps this draft** beside it so you know the ✕ is
not the same act. With nothing typed there is nothing to keep, and it goes back to a plain
**Cancel**.

Creating the card also clears the draft — the card is where the words live now.

## What counts as a draft

A title, a brief, a dependency or an attachment. Choosing a project, a stage or a label on its own
does not make a draft, so opening the dialog and closing it again leaves nothing behind. Empty the
fields and the draft is gone too.

## Drafts stay where you wrote them

There is one draft per board. A card you start inside a card's own sub-board is waiting for you
there, not on the main board, and each server you connect to keeps its own.

## Attachments

Files you attached come back with the draft. They have already been uploaded, so restoring them
does not depend on the file still being on the machine you attached it from.

Two things to know. A file that was still uploading when the page reloaded is not kept — only
finished uploads are, and closing the dialog on its own loses nothing either way. And a file
restored after a reload has no retry: if it will not attach, remove it and attach it again.
Each attachment is held for a day from when it finished uploading — carrying on typing does not
extend it — after which the draft comes back without that file and says so.

See also [Board card attachments](./board-attachments.md).

# Board card attachments

A card's brief can carry screenshots and files. Paste a screenshot (⌘V) or drop files into the
brief when you create a card, or any time you edit it. Pasted images appear as thumbnails above
the brief text; other files appear as chips below it, next to the **Attach files** button. Remove
any of them with its ✕.

Attachments upload as soon as you add them. When creating a card, **Create card** becomes
available once every upload has finished; a failed upload can be retried or removed. On an open
card, changes save immediately, with no separate save step.

Images can be up to 10 MB. On servers that support file uploads, other files can be up to the
limit the server advertises, capped at 50 MB. A card holds up to 20 attachments. The column card
shows a paperclip with the count.

Attachments belong to the card, not to a branch: they are stored with T3 Code's own data, so they
survive a worktree being cleaned up or a project being cloned again. Deleting a card deletes its
files.

## What the agent sees

Every thread working on the card can list its attachments, with the path of each file, through the
card context it already reads, and open any of them on demand. Files added after a thread started
show up the next time it looks. When the board starts a build or planning thread, the brief's
images are also shown to the agent on its first message, so a card that is mostly a screenshot
("fix this") is understood from the start. Review rounds and follow-up turns read the files by path
rather than receiving them again.

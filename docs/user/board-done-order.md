# Where a finished card lands

Done reads newest-first. A card that reaches it — because the board advanced it, because you
merged its pull request, or because you sent it on with the card's forward button — goes to the
**top** of the column, above everything that finished before it. The work you just finished is the
work you see, without scrolling past a week of it.

Every other column is unchanged. A card advancing into Building, Code review or Ready for merge
keeps the position it already had, which matters most in Building: position there is queue
priority, and an advance must not quietly reshuffle the queue.

A card created straight into Done follows the same rule and lands on top. Everywhere else, a new
card starts at the bottom — see [Where a new card lands](./board-new-card-order.md).

## Dragging still means what you dropped

Dragging a card into Done puts it exactly where you dropped it. You named a position, so the board
uses it rather than sending the card to the top. Reordering within Done works the same way as any
other column, so a card can always be moved after it lands.

## Clearing out Done automatically

Turn on **Settings → Board → Auto-archive Done cards** to have the board archive cards left
untouched in Done for a set number of days (7 unless you change it). It is off until you turn it on,
and when you do, cards already past the window are archived within a minute.

Any change to a card in Done restarts its count. A card whose worktree holds unsaved work stays in
Done so you can deal with it; see [When a card gives its worktree back](./board-worktree-cleanup.md).
Archived cards can be restored from the archive, and a restored card gets a fresh count.

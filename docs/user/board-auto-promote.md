# Moving unblocked Backlog cards into Sprint

A project can move every Backlog card that is ready to start into Sprint by itself. Backlog then
holds only work that is still waiting on something else.

This is off until you turn it on for that project.

## Turn it on

1. Open **Settings** and select **Board**.
2. Find the project.
3. Turn on **Auto-move unblocked Backlog cards to Sprint**.

Every Backlog card in that project with no unfinished dependencies moves to Sprint. New cards
created in Backlog with nothing waiting do the same. A card that depends on two others stays in
Backlog until **both** are Done (or archived).

A second switch, **Include sub-board children**, is off by default. On the default pipeline
children start at Ready, so they never sit in Backlog and this switch does nothing. Turn it on
only if the sub-board floor includes Backlog.

Turning the setting off leaves cards where they are. It never moves a card backwards.

## Parking

If you move a card from Sprint (or any later stage) back to Backlog, it stays there. The card wears
a **Parked** chip. Open the card and press **Unpark** to let it go to Sprint again, if nothing is
blocking it.

Giving the card a new unfinished dependency also clears the park: when that work finishes, the card
moves on its own like any other.

## Together with a scheduled start

A time on the card still has to arrive. If the time is in the future, the card waits in Backlog even
when nothing is blocking it. If the time arrives while the card is still blocked, it waits for the
last dependency, then moves.

## Small print

- The board checks every thirty seconds as well as reacting to each card finishing, so a card moves
  within about half a minute of becoming ready at worst.
- A dependency that finishes while the server is off is picked up when it comes back.
- This only ever moves Backlog → Sprint. It does not start a build.

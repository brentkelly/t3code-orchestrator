# Starting a card the moment it is unblocked

A card that depends on another card waits at **Ready** until the card it depends on is done. Until
then its **Begin build** button is off, and the card says who it is waiting for.

Under that, on a card that is waiting, is a switch: **Start automatically when unblocked**. Turn it
on and the card moves itself into Building the moment its last dependency finishes. You do not have
to come back and check.

## Where the switch appears

Only on a card that is actually waiting for something — open at **Ready**, with at least one
dependency still unfinished. Everywhere else there is nothing for it to do:

- A card with no unfinished dependencies can already start, so it just has a **Begin build** button.
- A card still in Backlog, Sprint or Planning is not waiting on a dependency, it is waiting on its
  plan. Arming it there would either sit doing nothing for days or skip the planning you asked for.
- The plan cards inside a split already do this. Approve a split, press Begin build on the parent,
  and each child starts as soon as the siblings it depends on finish — no switch needed.

## What it does when it fires

Exactly what pressing **Begin build** would have done, and nothing more. The card moves to Building,
its workspace is created, and an agent picks it up. If every agent is busy, the card queues and says
**Queued** like any other — it does not jump the [build queue](board-build-queue.md).

Archiving a dependency counts as finishing it, because an archived card is work that is not
happening: a card waiting on one would otherwise wait forever.

## It fires once

The switch is spent when the card leaves Ready, however it leaves:

- It started itself. That is the point.
- You pressed **Begin build** first.
- You dragged the card backwards.

That last one is deliberate. A build that went wrong and got dragged back to Ready arrives with the
switch **off** and waits for you. A card must never relaunch itself under the person who just parked
it.

To arm it again, turn the switch back on.

## Together with a scheduled start

The two stack, and neither knows about the other. A card that is armed **and**
[scheduled](board-scheduled-starts.md) moves to Building the moment its dependency lands, then holds
there until its time. On the board it wears its scheduled time, which is the more specific of the
two things it is waiting for.

## Small print

- The board checks every thirty seconds as well as reacting to each card finishing, so a card starts
  within about half a minute of being unblocked at worst.
- A dependency that finishes while the server is off is picked up when it comes back. Nothing is
  stranded.
- An armed card that cannot move for another reason — a split waiting for your approval, plan cards
  still running — stays armed and starts when that clears. Those states already say what they want.
- An armed card wears a muted **Auto-start** chip on the board, unless it also has a scheduled time.

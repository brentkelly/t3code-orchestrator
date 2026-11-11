# Board threads and the inbox

A card runs its work in ordinary threads: one for planning, one for the build, one for every review
round. They pile up fast — a card that goes ten rounds through code review has thirty threads behind
it — so the board clears them out of your inbox as it goes. A thread drops to **Settled** as soon as
the card is finished with it.

The card keeps them all. Settling only clears the inbox; the card's thread tabs are untouched, and
every finished round is still there to read.

Settled card threads are also hidden from the **Settled** shelf in Threads view, so your one-off
threads are easy to find there. Open an old card thread from its card instead. To list them in
Settled again, turn off **Hide card threads** in the sidebar's filter menu, or choose **Show** in
the note under the **Settled** header. The setting is saved per device, and search still finds
hidden card threads.

## What stays in the inbox

Whatever the card is actually working in, and nothing else:

- The step running right now.
- A step waiting on you — an agent that asked a question, or one that stopped and needs a look.
- A step that gave up and needs rescuing.
- A finished step whose card has not moved on yet. Stages you run yourself do not advance on their
  own, so their finished run stays in the inbox until you move the card.

Everything else settles: earlier review rounds, the planning thread once building starts, the build
thread once the card graduates, and every thread on a card you archive.

## Settling is not final

A settled thread comes straight back the moment anything happens in it. Send a message and it
returns to your active list; so does a card re-entering a stage and picking up the thread it left
there. Nothing is hidden for good, so you never have to decide in advance which finished thread you
might want again.

Dragging a card backwards works the same way. The threads of the stage it left settle, because the
card is not in that stage any more — and if you send it forward again, whichever thread it resumes
comes back with it.

The conversation a card opens when you drag it back into a stage it already finished is yours to
steer. When its agent reports the stage finished, the card moves on exactly as it did the first
time, if that stage moves cards on by itself.

Moving a card on from Planning before its plan is written asks you to confirm first. If you go
ahead, the card keeps its planning thread and any agent reply still in progress finishes. That
thread stays in your inbox until the agent reports planning finished. Move the card back to Planning and the
interview picks up in that same thread rather than starting again.

## Timing

A thread settles once its agent has actually stopped. An agent reports its step finished from inside
its own turn, so there is usually a beat between a card moving on and its old thread leaving the
inbox — the board waits for the turn to end rather than pulling the thread out from under a running
agent. If anything is missed, the board re-checks every half minute and again whenever it restarts.

This is separate from the inactivity and merged-pull-request settling in **Settings** →
**General**, which applies to every thread on the machine. Those rules still run; the board just
does not wait for them.

## Settle scripts

A card's threads share the card's worktree, so a project action marked to run when a thread settles
(`runOnSettle`) does not run as each card thread settles: it would clean up under the stage still
working there. Closing that thread's own stop-on-settle terminals still happens. The action runs
once instead, when the card gives its worktree back, just before any remove scripts (see
[When a card gives its worktree back](board-worktree-cleanup.md)).

## The card's pull request on its threads

Once a card has a pull request, its threads from **Code review** onwards show it too: every review
round, CI fix and merge-stage thread gets the PR badge, turns up when you search by PR, and settles
when the PR merges. Planning and build threads, and threads you added to the card yourself, are
left alone. Replacing or unlinking the card's pull request does the same to those threads, and a
pull request you remove from one thread stays removed until the card's own pull request changes
again. A later round's pull request goes only on
that round's threads; earlier rounds keep theirs.

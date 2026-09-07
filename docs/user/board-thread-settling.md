# Board threads and the inbox

A card runs its work in ordinary threads: one for planning, one for the build, one for every review
round. They pile up fast — a card that goes ten rounds through code review has thirty threads behind
it — so the board clears them out of your inbox as it goes. A thread drops to **Settled** as soon as
the card is finished with it.

The card keeps them all. Settling only clears the inbox; the card's thread tabs are untouched, and
every finished round is still there to read.

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

## Timing

A thread settles once its agent has actually stopped. An agent reports its step finished from inside
its own turn, so there is usually a beat between a card moving on and its old thread leaving the
inbox — the board waits for the turn to end rather than pulling the thread out from under a running
agent. If anything is missed, the board re-checks every half minute and again whenever it restarts.

This is separate from the inactivity and merged-pull-request settling in **Settings** →
**General**, which applies to every thread on the machine. Those rules still run; the board just
does not wait for them.

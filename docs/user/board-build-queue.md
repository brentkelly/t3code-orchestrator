# The build queue

Only so many agents run at once. The limit lives in **Settings** → **Board**, and it counts every
agent on the machine — not per project. A card that reaches a stage needing an agent while the
limit is full does not stop and does not fail. It queues, and it starts by itself as soon as an
agent frees up.

A queued card carries a **Queued #2** pill on the board. Hovering it says how busy the agents are
and how much work is ahead. Opening the card says the same thing in full, above the dependencies:
where it sits in the queue, why it is waiting, and that nobody has to do anything about it.

## Starting one anyway

**Start now** runs the card immediately, deliberately over the agent limit. Use it when one task
matters more than keeping to the cap. The limit itself does not change: once the card finishes,
the count drops back under it on its own.

Starting a card still takes a moment — it needs a workspace before an agent can pick it up — so the
button holds at **Starting…** until the work is genuinely under way.

## Moving one up

**Move to front** reorders the queue without starting anything. It appears only when it would
actually help. Later stages are admitted before earlier ones, so a card queued behind work that is
already in review cannot overtake it by reordering, and the button stays out of the way rather than
doing nothing.

## What the numbers mean

The queue is one list across every project, so **Queued #2** can mean the card ahead of it is on a
different board. `3 of 3 agents busy` counts every agent working anywhere. After a **Start now**,
the count reads honestly as over the limit until the extra card finishes.

A card can be queued and blocked at the same time. Blocked means an unmet dependency and is shown
separately — clearing the queue will not start a card that is still waiting on another one.

## Scheduled cards

A card holding a [scheduled start](board-scheduled-starts.md) is not in the queue at all — it takes
no place in the numbering and no agent slot until its time arrives. It joins the queue then, like
any other card.

## Cards held by a usage limit

A card whose provider runs out of usage waits for the limit to reset, reading **Usage limit —
resuming by 2:50am**, and starts again by itself when it does, usually right at the reset. The wait spends none of its retries, and
you do not have to be awake for it. A limit the provider gives no reset time for, or a reset time already past, is treated like any
other stop.

When an agent stops without finishing, the board nudges it to carry on — after two minutes, then
four, eight, sixteen and thirty-two — and the card says when the next nudge is due.

Either way the card is not in the queue and holds no agent slot while it waits. It rejoins the queue
when its time comes round, ahead of work that has not started.

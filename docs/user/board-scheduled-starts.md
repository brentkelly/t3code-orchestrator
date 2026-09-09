# Scheduling when a card runs

Every card carries a small clock. Set a time on it and nothing moves that card until then; at that
time the board makes the move it would otherwise have made straight away, and the clock clears
itself.

The clock is on the **New card** dialog, in an open card's header beside its stage, and on the card
itself once a time is set. Until you set one it is a bare icon with no label.

## Before the build

On a new card, and on any card that has not reached Building, the clock reads **Start the build
at**. That is the honest reading: nothing has been handed to an agent yet, so the time gates the
build.

It has no effect unless the card has reached **Ready** or **Building** by then. Planning and
approval still need you — a scheduled time will not walk a card through them while you are asleep.

## After the build starts

From Building onwards the clock names the stage the card is in — **Start Code review at**,
**Resume Building at**. The time gates whatever that card needs next, and it clears once it fires,
so a time you set on Monday does not quietly hold up code review on Thursday.

## Pausing work that is already running

Setting a time on a card an agent is working on **stops that agent now** and picks the work up
again at that time. The popover says so before you click. The card's conversation and its workspace
are both kept, so it resumes where it left off rather than starting over.

There is no confirmation step, because clearing the time undoes it completely.

It is the same stop [pressing **Stop** performs](board-stopping-an-agent.md), with one difference:
a schedule picks the card up again by itself, so the card stays unattended rather than being handed
back to you.

## Clearing, which is also "start now"

**Clear** is the way back out of every state:

- A card waiting for its time starts as soon as an agent is free.
- A card paused by a schedule goes straight back to work.

There is no separate **Start now** button — clearing the clock is it.

If you go back to a paused card's thread and pick the work up by hand, the schedule clears itself.
A decision you have already overtaken will not re-pause your card hours later.

## Together with waiting on another card

A card can be both scheduled and set to
[start automatically when unblocked](board-auto-start.md). The two are independent: the card moves
to Building the moment its last dependency lands, then holds there until its time. It wears its
scheduled time on the board, not the **Auto-start** chip — a time is the more specific claim.

## What a scheduled card costs while it waits

Nothing. A card holding a future time takes no agent slot and no place in the
[build queue](board-build-queue.md), and its workspace is not created until the time arrives — so a
card scheduled for tomorrow morning is not holding a checkout overnight, and the branch it cuts is
cut from wherever your base branch is by then.

Because the workspace is created at the moment it fires, starting takes a few seconds rather than
being instant. A card scheduled for a moment when every agent is busy queues normally and says
**Queued** rather than pretending otherwise.

## Small print

- Times are read in your own device's timezone. A time set on a laptop reads correctly on a phone
  somewhere else.
- A time in the past means "now". Nothing refuses it.
- The board checks every thirty seconds, so a card can start up to half a minute after its time.
- The pill on a card shows the time itself — `9:00 PM`, `tomorrow 8:00 AM` — and hovering it says
  how long that is away.

## When a provider runs out of usage

A time you set is yours. If a provider hits a usage limit, the board parks the affected cards and
resumes them on its own schedule — see [usage limits](board-usage-limits.md) — but it never
overwrites a time you set, and clearing a usage-limit hold does not clear your own clock.

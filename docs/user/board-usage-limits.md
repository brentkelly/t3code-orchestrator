# When a provider runs out of usage

Every provider puts a ceiling on how much you can use it. Hit one and the agent stops answering
properly: instead of doing the work it replies with a sentence like

> You've hit your session limit · resets 2:50am (Pacific/Auckland)

The board reads that sentence, parks the cards it affects, and starts them again by itself when the
window reopens. You do not have to be awake for it.

## What a card says

A card held by a usage limit reads **Usage limit — resuming 2:50am**, in amber. Nothing is running
and nothing is lost: the card keeps its conversation and its workspace, holds no agent slot, and
picks up exactly where it left off.

Open the card and the same fact is at the top of it, in the same amber: **Building is waiting to
resume**, with the provider's own sentence underneath. A card the board is going to restart by
itself never wears the red "stopped" banner — that one is kept for a card that has stopped until you
do something about it.

Two other things a stopped card can now say:

- **Out of credits — needs a human.** The provider is not rate-limiting you, it is telling you the
  account has run out of money or its plan has ended. Waiting will not fix that, so the board does
  not wait — it hands the card straight to you with the provider's own words on it.
- **Stalled — waiting to retry 2:32pm.** Nothing to do with usage limits: the agent stopped without
  finishing and the board will nudge it again shortly. See "Retries take their time" below.

## The bar in the board header

While any provider is limited, an amber pill appears in the board's header — **Anthropic limit ·
1:00 AM**. It is there so you can see what the board is waiting on without opening a card, and it
disappears completely once nothing is limited.

Open it for the whole picture:

- which providers are limited, and what each one actually said;
- when each resumes, and how long that is from now;
- every card that provider is holding, each one a click away;
- **Resume now**, if you think the provider is back early.

An account that is out of credits shows no countdown and no **Resume now**, because there is nothing
to wait for. Top the account up and the row clears itself the next time anything on that account
gets an answer — you do not have to dismiss it.

### When the provider gives no time

Some providers say only "you hit your weekly limit" and leave it at that. The board then checks back
on its own — every half hour at first, then less often as the wait grows, giving up after seven days
and handing the cards to you.

If you know better than the board — the provider's own dashboard usually says — the popover offers
**Set resume time**, on any limited provider, whether the board has a time of its own or not. Your
time stands: nothing the board merely reads in passing will argue with it. It stops being the last
word only once the board has actually tried it — a card is sent at the moment you named, and
whatever the provider says then is the truth from there on — or if the provider names a reset time
of its own. When the board is holding a time, the same control offers **Check periodically** to hand
the schedule back to it.

## One card wakes first, not all of them

When the window reopens the board starts **one** card and watches what happens.

That is deliberate. Reset times are approximate, and a provider is at its least forgiving in the
first moments after one; sending every waiting card at once would burn them all against the same
wall. If the one card gets through, the rest follow immediately. If it is refused again, it goes
back to waiting and the others never knew.

Anything that proves the provider is answering lifts the hold — including a message you send
yourself in an ordinary thread on the same account.

## Waiting costs a card nothing

A card parked on a usage limit spends none of its retry budget. It is not failing; the provider is.
A card that hits a limit at midnight is still fresh when the window reopens at 2:50am.

## Retries take their time

Separately from usage limits: when an agent stops without finishing, the board nudges it to carry
on. Those nudges now wait — two minutes, then four, then eight, sixteen and thirty-two — instead of
going out one after another.

The card says which one it is waiting for, and hands its agent slot back while it waits, so other
work carries on. The trade is that a genuinely stuck card takes about an hour to reach you instead
of seconds; for that hour it says plainly what it is doing, and holds nothing up.

## Cards you have to answer are left alone

None of this touches a card that is waiting on **you** — one whose agent asked a question, or one
you stopped yourself. A provider coming back says nothing about those, and the board never pushes an
unanswered question back into work.

Planning is the same: a planning card that stops is waiting on a person whatever the provider is
doing, so it is never parked or woken by any of this.

## See also

- [Scheduling when a card runs](board-scheduled-starts.md) — your own timings, which the board never
  overwrites.
- [The build queue](board-build-queue.md) — where a resumed card lands when it goes back to work.

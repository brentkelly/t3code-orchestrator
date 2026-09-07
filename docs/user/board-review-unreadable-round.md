# When a review round comes back unreadable

Each round of code review ends with the reviewer recording its findings in a fixed, machine-readable
shape. The board reads that record to decide what happens next: whether anything blocks, whether the
author gets a triage pass, and whether the loop can close. A round whose findings do not arrive in
that shape is not a round that found nothing — it is a round the board cannot read at all, so it
never counts as a pass and the card never advances on it.

The card says so. It carries an **Unreadable** flag on the board, and the review pane opens on
**Round N recorded an unreadable result**, in the same amber the board uses for anything that is
held rather than working.

## Reopening the round

**Reopen round N** sends that round back and runs its review again from scratch. The broken record
is replaced, the reviewer starts over on the same branch, and the loop carries on from there. It is
the only button that state offers, because it is the only thing that helps: running the _next_ round
would leave an unreviewed one behind it, and advancing the card would ship code nothing signed off.

Reopening is refused on a round that recorded a result the board can read. It repairs a broken
record; it is not a way to discard review that landed.

## If the agent is still working

An agent that notices the problem itself can simply record the round again with its findings in the
right shape. The board accepts that repair and the loop picks up where it stopped — no reopen
needed, and nothing is lost. Only a round that recorded a _readable_ result is final.

# When a review round comes back unreadable

Every phase of code review ends by recording its result in a fixed, machine-readable shape — the
reviewer's findings, the author's dispositions, the adjudicator's verdicts, the sha a rebase landed
on. The board reads those records to decide what happens next: whether anything blocks, whether the
author gets a triage pass, and whether the loop can close. A result that does not arrive in the
right shape is not a phase that had nothing to say — it is one the board cannot read at all, so it
never counts as a pass and the card never advances on it.

The card says so. It carries an **Unreadable** flag on the board, and the review pane opens on
**Round N recorded an unreadable result**, naming the phase that wrote it, in the same amber the
board uses for anything that is held rather than working.

## Reopening it

**Reopen round N** sends the round back and runs its review again from scratch — that is what a
broken _review_ needs, because nothing after it ran. When a later phase is the broken one the button
names it instead (**Reopen triager**, and so on) and sends only that phase back; the round's findings
are still on record, so there is nothing to re-review.

Either way the broken record is replaced, the phase runs again on the same branch, and the loop
carries on from there. It is the only button that state offers, because it is the only thing that
helps: running the _next_ round would leave an unresolved one behind it, and advancing the card would
ship code nothing signed off.

Reopening is refused on a phase that recorded a result the board can read. It repairs a broken
record; it is not a way to discard work that landed.

## If the agent is still working

An agent that notices the problem itself can simply record the step again with its result in the
right shape. The board accepts that repair and the loop picks up where it stopped — no reopen
needed, and nothing is lost. Only a step that recorded a _readable_ result is final.

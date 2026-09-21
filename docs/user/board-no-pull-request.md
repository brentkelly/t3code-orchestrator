# A card at Ready for merge with no pull request

A card arrives at **Ready for merge** with a pull request. That is the normal shape: the build
pushed the branch and opened it, the review loop read it, and the card is waiting for you to press
**Merge**.

Sometimes there is no pull request. The card face wears an amber **No PR** chip, and opening the
card says which branch it looked for and could not find one on. The card is not stuck — **Move to
Done** is still there — but nothing is going to move it on by itself, which is what the chip is for.

## Why it happens

Most often somebody closed the pull request on the forge, or the branch was opened by hand under a
different name than the one the card holds.

Less often the forge could not be asked at all: a rate limit, a signed-out CLI, a network blip. T3
Code deliberately does not blank a card's existing link when that happens — a card that already
showed a pull request keeps showing it — but a card that never had one has nothing to fall back on
and reads the same as a card with genuinely no pull request.

## Check again

The **Check again** button beside the notice asks the forge now. It skips the answer T3 Code has
cached, so it is worth pressing the moment something changes on the forge rather than waiting for
the cache to expire.

It always says what came back:

- the pull request appears, with **Merge** and **View PR** beside it;
- **Still no pull request for `<branch>`** — the forge answered, and there is none;
- **Could not reach the forge**, followed by the forge's own words — a rate limit, an expired
  token, whatever it actually said. This is the one worth retrying.

The chip and the notice wait a few seconds after a card stops moving before appearing, so a card
that has only just arrived at Ready for merge does not flash a warning while its first lookup is
still in flight.

## If it is already merged

A card whose pull request was merged still links it. **View PR** is on the card at every stage,
Done included, and falls back to the most recent pull request the card had if a newer round has not
opened one yet — so finding the change that closed a card never depends on where the card is
sitting.

## Related

- [Auto-merge](board-auto-merge.md) — arming a card to merge itself once the forge accepts it.
- [Asking for another review round](board-another-review-round.md) — pulling a card back for one
  more pass.

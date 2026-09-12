# Merging a card without waiting for you

A card that has passed review parks at **Ready for merge** with a blue **Merge** button, and stays
there until someone presses it. That is fine when you are at your desk, and it is the reason an
[armed card](board-auto-start.md) can still be sitting in Ready in the morning: the card it was
waiting for never reached Done, because nobody clicked Merge.

**Auto-merge when ready** removes the click. An armed card merges its own pull request the moment
the forge accepts it, and the cards depending on it start themselves off the back of that.

## Arming a card

Open the card and turn on **Auto-merge when ready**. It is offered on any card that has not reached
Done — before you go to bed is the useful moment to set it, whatever column the card is in, so the
switch is not hidden away in one stage.

Turning it on for a card that is _already_ waiting at Ready for merge merges it straight away. That
is the same thing the Merge button does; the switch just also covers next time.

The plan cards inside a split are armed already. Approve a split and each child merges itself down
as it finishes, which is what lets the next sibling start.

## Arming the whole board

**Settings → Board → Pipeline → Ready for merge → Auto-merge when ready** arms every card that
arrives at that stage from then on. With it on, the per-card switch disappears — one control, so
nothing can disagree about a card — and each card's header says **Auto-merge · board** so you can
tell where the decision came from.

Switching it on does **not** merge the cards already sitting in Ready for merge. Those may be parked
precisely because you did not want them merged, and a merge cannot be undone. They keep their Merge
button. Switching it back off restores each card's own switch exactly as you left it, and any card
that was only being retried because of the board-wide setting drops its hold with it.

A card you dragged straight from Building onto Ready for merge, skipping review, does not
auto-merge under the board-wide setting. Its diff has never been reviewed. You can still arm that
card individually, or press Merge.

## When the forge says no

Merges get refused, and most of the time the reason is simply that CI has not finished. So a refused
auto-merge is looked at rather than given up on:

- **A check is still running.** The board waits and tries again — after 3 minutes, then 3, 5, 5, 10,
  20 and 40. Eight attempts over about an hour and a half. The card wears an amber **Merge held**
  pill with how long it has been waiting, and the Merge button shows a countdown to the next try.
- **A required check failed.** There is nothing to wait for: more CI will not happen without a new
  commit. The board stops on the first refusal, and the card reads **Merge needs you**.
- **Everything is green and the forge still says no** — a missing approval, a branch protection
  rule. That is a decision the board does not have, so it stops and says so.
- **Conflicts** take the path they always have: an agent resolves them, and the merge finishes
  itself if that works.

Whatever happens, the forge's own words are on the card. Open it and the banner says why, which
attempt it was, and how the checks stood.

The Merge button stays live the whole time. A held card is not a busy card — nothing is running, the
forge just said no — so clicking is always available, and clicking restarts the clock.

## Turning it off

Switch it off and the card parks as an ordinary card again; any hold is cleared with it. Switching
it off and back on is also how you give a card that gave up another full run of attempts.

A card that leaves Ready for merge — dragged back, or sent for another review round because its base
branch moved — drops its hold on the way out.

## Small print

- The board re-checks every thirty seconds, so a retry lands within about half a minute of its time.
- A card that is blocked by an unfinished dependency is skipped silently. It already says it is
  blocked; a second pill making a different claim would only be confusing. It merges on the next
  check after the dependency lands — unless the server restarted in between, in which case it waits
  for a click, because a merge nobody watched start is not one the board will guess at.
- Holds survive a restart. A card mid-ladder when the server stops picks up where it left off.
- Pushing a new commit resets the attempts, because new commits mean new CI.
- Reading the _reason_ a merge was refused needs GitHub or Forgejo. On other providers the board
  still retries on the same schedule; it just cannot tell a failing check from a passing one, so it
  uses all eight attempts before handing the card back to you.

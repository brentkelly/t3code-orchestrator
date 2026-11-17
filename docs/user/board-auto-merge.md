# Merging a card without waiting for you

A card that has passed review parks at **Ready for merge** with a blue **Merge** button, and stays
there until someone presses it. That is fine when you are at your desk, and it is the reason a card
with [Auto-build](board-auto-start.md) can still be sitting in Ready in the morning: the card it was
waiting for never reached Done, because nobody clicked Merge.

**Auto-merge** removes the click. An armed card merges its own pull request the moment the forge
accepts it, and the cards depending on it start themselves off the back of that.

## Arming a card

Open the card and turn on **Auto-merge** in its **Automation** section. You can set it in any column
— before you go to bed is the useful moment, whatever stage the card is in.

Turning it on for a card that is _already_ waiting at Ready for merge merges it straight away. That
is the same thing the Merge button does; the switch just also covers next time.

## Cards inside a group

A card inside a group takes its group's **Auto-merge children** setting, whether it merges into the
group's own branch or to trunk. An Own-branch group has it on by default, so each child merges
itself down as it finishes, which is what lets the next sibling start. A card's own switch, on or
off, overrides the group.

## Arming the whole board

**Settings → Board → Pipeline → Ready for merge → Auto-merge when ready** arms every card, group
children included. With it on, each card's Auto-merge switch shows on, locked and tagged **board**,
so you can tell where the decision came from.

Switching it on also merges the cards **already** sitting in Ready for merge, within about half a
minute. A merge cannot be undone, so turn off the Auto-merge switch of any card you want left
parked there first. Switching the setting back off restores each card's own switch exactly as
you left it, and any card that was only being retried because of the board-wide setting drops its
hold with it.

An armed card merges however it reached Ready for merge: through review, by "Submit for merge — no
review", or dragged there by hand.

## When the forge says no

Merges get refused, and most of the time the reason is simply that CI has not finished. So a refused
auto-merge is looked at rather than given up on:

- **A check is still running.** The board waits and tries again — after 3 minutes, then 3, 5, 5, 10,
  20 and 40. Eight attempts over about an hour and a half. The card wears an amber **Merge held**
  pill with how long it has been waiting, and the Merge button shows a countdown to the next try.
- **A required check failed.** There is nothing to wait for: more CI will not happen without a new
  commit, so an agent reads the failing checks, fixes the cause and pushes. The card wears a
  **Fixing CI** pill while it works, and the merge waits for the re-run checks. If they fail again,
  the board stops and the card reads **Merge needs you**; clicking Merge allows one more fix. This
  happens whether or not the card is armed.
- **The branch is behind its base** and your repository requires it to be up to date. The board
  brings it up to date once (an agent merges the base in and pushes), then merges. If the base
  moves again before the merge lands, the card holds rather than chasing it. Only GitHub says
  whether being behind is the whole refusal; elsewhere a branch behind its base holds.
- **Everything is green and the forge still says no** — a missing approval, a branch protection
  rule. That is a decision the board does not have, so it stops and says so.
- **Conflicts**: an agent resolves them once, and the merge finishes itself if that works. A
  second conflict while the card waits in Ready for merge is a hold, **Merge needs you**: the board
  does not resolve conflicts twice. Clicking Merge allows one more fix.
- **An agent fixing the branch fails**, or the card has no pull request or no checkout to merge
  from: the card holds and says why. Linking a pull request to a card that had none lets the merge
  go ahead by itself.

Whatever happens, the forge's own words are on the card. Open it and the banner says why, which
attempt it was, and how the checks stood.

The Merge button stays live the whole time. A held card is not a busy card — nothing is running, the
forge just said no — so clicking is always available, and clicking restarts the clock.

## Opening pull requests as drafts

**Settings → Board → Code review → Open pull requests as drafts.** Off by default.

When it is on, whichever agent opens a card's pull request (the build agent or the review agent)
opens it as a draft, and it stays a draft
through every review round, so the fix commits the loop pushes do not each start your repository's
full CI. When the card reaches Ready for merge, the board marks the pull request ready for review:
that is when full CI runs, once. The card's activity says "marked ready; CI started", and a draft
pull request carries a small **Draft** tag until then.

- Auto-merge waits for your repository's _required_ checks. A repository with no required checks
  merges as soon as the forge allows it. Right after a draft is marked ready, the merge always waits
  a few minutes first, whether it is automatic or you clicked Merge, so the checks it just started
  have time to appear.
- If your forge or plan does not offer draft pull requests, the agent opens a normal one instead.
  Forgejo and Gitea use a `WIP:` title prefix as the draft marker, and the board removes it.
- A pull request that is already ready — one you marked ready yourself, or one opened before the
  setting was on — is left alone.
- Merging a card whose pull request is still a draft marks it ready first, even if you have since
  turned the setting off, because a draft cannot be merged. The merge then waits for the CI that
  starts.

## Turning it off

Switch it off and the card parks as an ordinary card again; any hold is cleared with it. Switching
it off and back on is also how you give a card that gave up another full run of attempts.

A card that leaves Ready for merge — dragged back, or sent for another review round because its base
branch moved — drops its hold on the way out.

## Small print

- The board re-checks every thirty seconds, so a retry lands within about half a minute of its time.
- A card that is blocked by an unfinished dependency is skipped silently. It already says it is
  blocked; a second pill making a different claim would only be confusing. It merges on the next
  check after the dependency lands, restart or not.
- Holds survive a restart, and so does the count of fixes the board has made. A card mid-ladder when
  the server stops picks up where it left off; a card armed in Ready for merge when the server stops
  merges once it is back.
- Pushing a new commit resets the attempts, because new commits mean new CI. That includes a card
  whose attempts ran out: push a fix to its pull request and Auto-merge starts again by itself.
- A pull request merged outside the board (on GitHub, say) moves its card from Ready for merge to
  Done within a few minutes.
- Reading the _reason_ a merge was refused needs GitHub or Forgejo. On other providers the board
  still retries on the same schedule; it just cannot tell a failing check from a passing one, so it
  uses all eight attempts before handing the card back to you.

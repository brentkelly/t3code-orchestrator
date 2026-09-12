# Asking for another review round

A review loop stops on its own when a round closes clean. That is usually what you want, and the
card carries straight on to **Ready for merge**. Sometimes it is not: the round passed, you read the
diff yourself, and you want another pair of eyes on it — often sharper ones than the round that just
signed it off.

**Another review round** is that button. It sits in the card's action column, under the forward
action and above **View PR**.

## Where it appears

On a card sitting in **Code review** or **Ready for merge**. Those are the two places one more round
means something: the loop has settled and the card has a branch to look at.

It does not appear at **Done**. Leaving Done retires the card's pull request and starts the card's
next round of work, so pulling a merged card back is a bigger move than "review this once more" —
drag it back yourself if that is what you want.

## What it does

The card returns to **Code review** and the next round starts on the same branch: a fresh reviewer
reads the diff with no history of it, the author answers the findings, and an adjudicator rules on
the answers, exactly as any other round. Nothing about the branch or the pull request changes — the
card keeps the pull request it already had, and the new round posts on it.

It buys exactly one round. If that round finds nothing, the loop settles again and the card goes
back to Ready for merge; if it finds something blocking, the loop carries on to whatever budget the
card had left. There is no limit on how many times you can ask — each click is one round, which is
why there is no ceiling to run into.

The card's Activity rail records the request, so a card that jumped from Ready for merge back to
Code review says why it moved.

## Reviewing on a better model

The button runs the round on whatever the card is already set to. To escalate first, open the card's
kebab menu, choose the models popover, and set the **Review** row. That applies to the review phase
alone — the reviewer changes, the author and the adjudicator keep their own models — and it is
reachable at any stage, Ready for merge included. Set it, then ask for the round.

## Request review

A card that reached Ready for merge without a review — through **Submit for merge — no review** —
shows **Request review** instead. Same button, same click: the card moves to Code review and runs
its first round.

## When it is unavailable

The button greys out while anything is running on the card, including a merge-conflict fix. One step
runs on a card at a time, and a rebase somebody is halfway through is not worth interrupting. Wait
for it to finish and click again.

It stays available when the **Merge** button is dead from conflicts, deliberately. If the card's
base branch has moved underneath it, another review round is the fix: the round rebases the branch
onto the current base first, then reviews the diff that would actually merge.

## Running a round from the review pane

The Review pane offers the same thing under a different name. A loop that stopped without converging
— out of rounds, or held because you asked it to stop — shows **Run round N+1** beside **Advance
anyway**. It is the same action as the button in the action column; the pane just explains, with
counts, why the loop stopped where it did.

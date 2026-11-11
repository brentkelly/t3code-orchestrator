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

The round reviews the whole branch, even when the loop had moved on to settling rounds (below).

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

## When the review is stuck

When the adjudicator rules against the author on a blocking finding, the round does not just roll
on to the next one. The author gets one more pass in the same round, to fix the finding or argue
again with a better reason, and the adjudicator rules once more. If they still disagree, the loop
stops and the card shows **Stuck** in violet. The review pane lists each stuck finding with the
author's argument beside the adjudicator's ruling.

The author never stops to ask you anything: it fixes each finding or rejects it with its reasons,
including "outside this card's brief" or "needs a product decision". Only the adjudicator hands a
finding to you, and only when it genuinely cannot decide, such as a scope call the brief does not
settle. Such a finding is marked **adjudicator escalated**, and the loop stops **Stuck** straight
away.

You have three choices, and each one applies to every finding listed:

- **Fix it and run round N+1** orders the findings fixed. The next round must fix them, and the
  adjudicator checks the fix; the author can turn one down only by explaining why it cannot be
  done. Add a note to steer the fix.
- **Reviewer is wrong, run round N+1** settles the findings as not issues,
  and later rounds are told not to raise them again. It reads **Accept as is** when the stuck
  finding is one you already ordered fixed.
- **Advance anyway** moves the card on with the code as it stands. Nothing is ruled, and the card
  says how many fixes from the stuck round no review has read.

**Run round N+1** and the budget controls are hidden while the loop is stuck, because another plain
round would only raise the same dispute. Only a person can move a stuck card out of Code review.

The adjudicator can also end the loop early. When a round raises nothing new beyond points already
settled and no blocking fix landed, it can rule that no further round is needed, and the pane says
so.

Each review round now reads the code with fresh eyes: the reviewer does not see earlier rounds, only
your unresolved pull request comments and the findings you ruled not issues. A review prompt still
set to the old default switches to the new one by itself. One you edited is kept as it is, so edit it
again if it still asks the reviewer to read earlier rounds.

## Settling rounds

Late in a loop, rounds tend to find one small thing each, usually in the code the last fix touched,
and every fix then needs another round to read it. Settling rounds stop that treadmill.

After round 3, a round with fewer than 2 blocking findings makes the next round a settling round.
A settling round reviews only the changes made since the previous round's review, and only
**critical** findings start another round. Improvements are still fixed, and the adjudicator still
checks every fix, but those fixes do not need a round of their own. The review pane tags these
rounds **Settling**. When a loop ends this way, the pane says how many fixes the adjudicator verified
but no reviewer re-read.

The rule is checked again every round. In a full round every blocking finding counts toward the
threshold; in a settling round only critical findings and findings you sent back do, so a settling round with 2 or more
critical findings sends the next round back to a full review. Findings the adjudicator ruled not
issues never count.
**Another review round** always runs a full review.

To change when settling starts, or to turn it off, go to **Settings → Board → Pipeline → Code review**. In
a project's `t3o.json`, the review stage takes `settleAfterRound` (a round number, or `null` for
off) and `settleBelowFindings` (2 or more).

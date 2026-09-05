# Leaving the build stage

A card that has finished building has two ways forward, and both live on the button at the top of
the card's detail.

## Move to Code review

The ordinary exit. The card crosses into **Code review**, where the review loop reads the branch,
opens its pull request, posts findings as inline comments, and works through them until a round
passes clean. Most cards go this way, and a card the board is driving takes it by itself — the
button only appears when a build has stopped and is waiting on you.

## Submit for merge — no review

Some changes do not need a review. Click the caret beside the forward button and choose **Submit
for merge — no review**.

The card stays in **Building** while one short agent run pushes its branch and opens a pull
request against its base branch, writing the title and body from the work on the branch. Then the
card moves straight to **Ready for merge**, with a live pull request and a working **Merge**
button, skipping Code review entirely.

The pull request description matters more here than usual: no review is going to explain the change
later, so the agent writes it from what is actually on the branch rather than from a template.

A card that already has an open pull request — one that ran review, came back to Building, and is
being submitted again — keeps it. Nothing is duplicated.

### When the caret appears

Only when the choice means something: the card's build has stopped and is waiting on you, its next
stage is Code review, the board has a merge stage to send it to, the card has a branch to push, and
nothing is blocking it.

### If it cannot push

No remote, a forge it is not signed in to, a protected branch — the card stays in **Building** and
says what stopped it. Fix the cause and click again, or take the ordinary route to Code review.

### Configuring it

Settings → Board → the **Building** stage. The **Submit for merge — no review** block sets the
prompt, the model, the access level and the limits that run behind the button, the same way the
Code review stage configures each of its phases. It runs unattended whatever the card's
human-in-the-loop setting says: there is no conversation to have about pushing a branch.

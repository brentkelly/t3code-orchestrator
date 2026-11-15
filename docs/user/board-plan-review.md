# Plan review

Plan review has the planning agent attack its own plan before you sign it off. Once the agent posts
its plan, it runs rounds of adversarial review inside the planning thread. Each round uses two
reviewer subagents: one checks and strengthens the plan, the other tries to break it and looks for a
different way to reach the card's goal. The agent posts each reviewer's findings in the thread,
revises the plan, and summarises the final plan for you.

## On by default

New cards are created with plan review on, for 3 rounds, attended. The card's sidebar says so:
"On by default for _project_ · 3 rounds". Changing anything in the card's **Plan review** section
gives the card its own setting. Cards created before this default existed keep following the
Settings fallback they always did.

A card split into child cards hands its plan review setting to each child. A child that still needs
planning (one proposed as a brief, not a full plan) is planned and reviewed again, which costs
another review's worth of agent time; turn its review off if you don't want that.

## Rounds are a target

**Rounds** (1 to 20) is how many rounds the review aims for. It stops early once a round finds
nothing new. Before each round the agent asks the board for the current target, so you can change
the rounds while a review runs and nothing is sent to the agent: it picks the new target up at its
next round. Lower it below the round in progress and the review stops when that round ends.

The section shows the review as it goes: "Reviewing · up to N rounds", then "Round X of N" with one
bar segment per round, and "Reviewed · N rounds · M findings" once planning finishes.

## Starting a review on a posted plan

Turn plan review on after the plan is posted, even once planning has finished or while it is paused,
and the review is armed rather than started: the section reads **Ready to start** and nothing is
sent until you click **Start review**. That gives you time to set the rounds and Unattended first.
The review then runs in the same planning thread and the plan comes back to you for sign-off.

To stop a running review, switch it off: the agent summarises what it has found, re-posts the plan
if it changed, and finishes. If you switch off a review that started after planning had finished,
the re-posted plan still replaces the old one, but the card keeps the planning summary from before
the review.

## Unattended

With **Unattended** on, the review runs like Auto-plan: the agent asks you nothing, decides each
finding itself and flags the calls it is unsure of on the decision log. Turning it on mid-review
takes effect at the agent's next round; if the agent is already waiting on a question about a
finding, the board answers it once, telling it to decide for itself.

An unattended review counts as automated planning, so the card's **Auto sign-off** gate applies
(the Automation section shows `Plan · auto from review`). With Auto sign-off on, a reviewed single
plan is approved without you when the review ends; with it off, the plan waits for you. Turning
Auto sign-off on later approves a plan that is waiting. A proposed split always waits for you.

## Settings and per-project overrides

**Settings → Board → Pipeline → Planning → Plan review** holds:

- **Auto-review plans**: whether new cards start with plan review on.
- **Rounds**: the target new cards start with. You can change it on any card.
- **Run unattended**: whether new cards' reviews start unattended.
- **Prompt**: what the planning agent is told to do. Write `{rounds}` where the round target should
  go. **Reset** brings back the shipped prompt.

A project can override the first three for its own new cards on its **Pipeline** tab, under
Planning. The board adds its own instructions around your prompt, so the review always ends with
the plan re-posted and the step completed, however you word it.

The card's activity shows when a review started, when its target changed (and from what), when it
was turned off, and how many rounds it ran.

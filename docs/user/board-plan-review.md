# Plan review

Plan review has the planning agent attack its own plan before you sign it off. Once the agent posts
its plan, it runs rounds of adversarial review inside the planning thread. Each round uses two
reviewer subagents: one checks and strengthens the plan, the other tries to break it and looks for a
different way to reach the card's goal. The agent posts each reviewer's findings in the thread,
revises the plan, and summarises the final plan for you.

## Turning it on for a card

The **Plan review** section sits in the card's sidebar, under the action buttons, from Backlog up to
and including Planning. Switch on **Adversarial plan review** and set **Rounds** (1 to 20). The
number is a limit: the review stops early once a round finds nothing new.

A card you have not touched follows the Settings default. Changing the switch or the rounds gives the
card its own setting.

## The default and the prompt

**Settings → Board → Pipeline → Planning → Plan review** holds:

- **Review plans by default**: whether untouched cards are reviewed.
- **Default rounds**: the round limit those cards use.
- **Prompt**: what the planning agent is told to do. Write `{rounds}` where the card's round count
  should go. **Reset** brings back the shipped prompt.

The board adds its own instructions around your prompt, so the review always ends with the plan
re-posted and the step completed, however you word it.

## While a review runs

The section header shows **In progress** and the rounds are locked. To stop a review, switch it off:
the agent is told to summarise what it has found, re-post the plan if it changed, and finish.

On an auto-planned card the review still runs, but the agent decides everything itself and finishes
without waiting for your sign-off.

The card's activity shows when a review started, when it was turned off, and how many rounds it
ran.

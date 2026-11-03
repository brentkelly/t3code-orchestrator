# Auto-plan and the decision log

## The decision log

Every planning session records the decisions it made: what was asked, what was decided, a one-line
reason, and whether you or the agent made the call. Open the card's **Summary** tab to read them.
The tab appears from Ready onward once a card has a log, before any build has finished.

Decisions are listed with the ones that need a second look first:

- **Unclear** (violet): the agent was not sure. Read these.
- **Important**: the call shapes the work, such as splitting the card.

Child cards of a group see their parent's decisions when they are planned, so they build on what was
already settled instead of asking again.

## Auto-plan → Build

On a card in Planning, **Auto-plan → Build** ends the interview. The agent stops asking questions,
decides everything left itself, logs each decision, and proposes the plan. The board then approves
that plan without waiting for you and starts the build. Use it when you have answered what matters
and are happy for the agent to settle the rest.

- The plan is approved even when some decisions are marked unclear. The Summary tab opens with the
  log expanded, so you can check them while the build runs.
- If the agent splits the card, the split is approved with the agent's recommended group settings.
  With auto-build on, the group starts and its ready children build. With it off, nothing starts
  until you start the group.
- Dependencies still apply: a card waiting on another card stays in Ready until that card is done.
- The button is not offered on a group, or on a card whose proposed split is waiting for you.
- If the run stops before it proposes a plan (it asks you a question, you stop it, or it gives up),
  auto-plan is cancelled and the card goes back to ordinary planning. Click the button again to
  retry.

Once an auto-planned card is past Building, the log offers **Send back to build with changes**, which
moves the card back to Building for another pass, and **Create follow-up card**, which adds a Backlog
card for the first decision worth revisiting.

Agents can do the same with the `board_auto_plan` tool, but only after you confirm it.

## Group auto-plan

Turn on **Auto-plan** in a group's settings and each child entering Planning is planned by the agent
on its own, with a decision log, and its plan approved to Ready. It stops there: whether it builds
next is up to the group's auto-build setting.

# Automation and the decision log

## The decision log

Every planning session records the decisions it made: what was asked, what was decided, a one-line
reason, and whether you or the agent made the call. Open the card's **Summary** tab to read them.
The tab appears from Ready onward once a card has a log, before any build has finished.

Decisions are listed with the ones that need a second look first:

- **Unclear** (violet): the agent was not sure. Read these.
- **Important**: the call shapes the work, such as splitting the card.

Child cards of a group see their parent's decisions when they are planned, so they build on what was
already settled instead of asking again.

## The Automation section

Every card's sidebar has an **Automation** section, collapsed by default. Its header says which
automations are on. It has three switches:

- **Auto-plan**: the planning agent stops asking questions and decides everything left itself,
  logging each decision. On its own, the plan then waits for you to approve it.
- **Auto-build**: once the plan is approved, the card starts building by itself as soon as its
  dependencies are done. With Auto-plan on too, the plan is approved for you, so the card runs
  unattended all the way to Ready for merge. With Auto-build on and nothing blocking the start,
  Planning's forward button reads **Begin build** (it still moves to Ready, then starts), and
  **Human in the loop** is hidden because Auto-build runs the build unattended — turn Auto-build
  off if you want to drive the build in conversation.
- **Auto-merge**: the card merges itself once it reaches Ready for merge. See
  [auto-merge](board-auto-merge.md).

You can turn them on before the card gets there. A card in Backlog with Auto-plan on is planned
unattended as soon as it reaches Planning.

Turning Auto-plan on mid-interview hands the rest of the interview to the agent in the same thread:
it is told to stop asking and finish, and a question it is waiting on is answered with that
instruction. Turning it off mid-run tells the agent you are back.

- With Auto-build on, the plan is approved even when some decisions are marked unclear. The Summary
  tab opens with the log expanded, so you can check them while the build runs.
- If the agent splits the card and Auto-build is on, the split is approved with the card's
  automation settings and the new group starts.
- A switch locks once its stage has passed: Auto-plan once planning is finished, Auto-build once the
  card is building. A locked switch that is on can still be turned off.
- Dragging a card back out of Building turns its Auto-build off, and back into Planning its
  Auto-plan off, so a card you pulled back waits for you. Turn them on again to resume.
- Stopping the planning agent, or answering its question yourself, turns Auto-plan off. If the run
  fails on its own, Auto-plan stays on and the reason shows on the card's activity.

Once an auto-planned card is past Building, the log offers **Send back to build with changes**, which
moves the card back to Building for another pass, and **Create follow-up card**, which adds a Backlog
card for the first decision worth revisiting.

Agents can set these switches with the `board_set_automation` tool, but only after you confirm it,
and never from an unattended run.

## Inherited from the group

A card inside a group takes the group's automation settings unless it sets its own. The tag next to
a switch says **from T3O-12** when it is inherited and **overrides T3O-12** when the card has its own
value.

An inherited Auto-build only acts once you have started the group, so the tag reads
**from T3O-12 · when group starts** until then. A card's own Auto-build starts it by itself, even in
a group that has not started, without starting its siblings.

Changing a group's setting applies straight away to the children that inherit it, including ones
already being planned. When that would change work in progress, the board asks you to confirm and
lists what will happen.

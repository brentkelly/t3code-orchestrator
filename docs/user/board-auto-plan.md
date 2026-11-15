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

Every card's sidebar has an **Automation** section, collapsed by default. Each switch automates one
gate, and the header shows one tag per gate saying whether you pass it or the board does:
**Plan · you**, **Sign-off · auto**, and so on.

- **Auto-plan**: the planning agent stops asking questions and decides everything left itself,
  logging each decision.
- **Auto sign-off**: shown under Auto-plan while it is on. The agent's plan is approved without you
  and the card moves to Ready. Off, the plan waits for your approval.
- **Auto-build**: once the plan is signed off, the card starts building by itself as soon as its
  dependencies are done. It never approves a plan.
- **Auto-merge**: the card merges itself once code review passes. See
  [auto-merge](board-auto-merge.md).

**Make hands-off** turns on every switch that is still off and can be turned on. The header then
shows a **Hands-off** tag. A proposed split always waits for you, even hands-off: the agent's split
creates cards and sets where they merge, so it needs a person. Once you approve it, the new group
starts with the card's Auto-plan and Auto sign-off, so its unplanned cards are planned the same way.

You can turn the switches on before the card gets there. A card in Backlog with Auto-plan on is
planned unattended as soon as it reaches Planning.

Turning Auto-plan on mid-interview hands the rest of the interview to the agent in the same thread:
it is told to stop asking and decide the rest itself, still running any plan review to the end, and a question it is waiting on is answered with that
instruction. Turning it off mid-run tells the agent you are back. Auto sign-off stays as you set it,
but only acts while Auto-plan is on.

- With Auto sign-off on, the plan is approved even when some decisions are marked unclear. The
  Summary tab opens with the log expanded, so you can check them.
- Turning Auto sign-off on for a finished auto-planned card whose plan is waiting approves it.
- A switch locks once its stage has passed: Auto-plan and Auto sign-off once the card leaves
  Planning, Auto-build once the card is building. A locked switch that is on can still be turned
  off.
- Auto-plan can still be turned on after the agent marked planning finished, for example while it
  runs a plan review you asked for. If its thread is still working, the agent is handed over when
  its current turn ends, and when it finishes again the plan is approved if Auto sign-off is on. If
  the thread has already finished, nothing is sent and the plan waits for your approval.
- Dragging a card back out of Building turns its Auto-build off, and back into Planning its
  Auto-plan and Auto sign-off off, so a card you pulled back waits for you. Turn them on again to
  resume.
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
**from T3O-12 · when group starts** until then. An inherited Auto sign-off does not wait: the plan
is approved into Ready, and builds once the group starts. A card's own Auto-build starts it by itself, even in
a group that has not started, without starting its siblings.

Changing a group's setting applies straight away to the children that inherit it, including ones
already being planned. When that would change work in progress, the board asks you to confirm and
lists what will happen.

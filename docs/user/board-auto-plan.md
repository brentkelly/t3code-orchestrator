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
- **Auto sign-off**: when planning finishes, the plan is approved without you and the card moves
  to Ready, whoever planned it: the agent, or you in an attended planning session. A proposed split
  is approved too. Off, the plan waits for your approval.
- **Auto-build**: once the plan is signed off, the card starts building by itself as soon as its
  dependencies are done. It never approves a plan.
- **Auto-merge**: the card merges itself once code review passes. See
  [auto-merge](board-auto-merge.md).

**Make hands-off** turns on every switch that is still off and can be turned on. The header then
shows a **Hands-off** tag.

With Auto sign-off on, a proposed split is approved for you too: the new group takes the card's own
Auto-plan, Auto sign-off, Auto-build and Auto-merge, and merges where the planner recommended. The
card waits in Ready as the group; fully planned children land in Ready (and build, with Auto-build
on), and children that still need planning go straight to Planning when Auto-plan is on, Backlog
otherwise. With Auto sign-off off, a split waits for you at the gate. The planning agent is told
which applies, so it splits only when the work warrants it.

Each switch is checked again every 30 seconds and when the server starts, so a card whose moment
was missed (a restart, a toggle turned on late, a dependency that cleared) catches up within half a
minute. When an automatic step is due but cannot act, for example a refused move, the card shows
**Automation held** in amber with the reason, and the board keeps retrying.

You can turn the switches on before the card gets there. A card in Backlog with Auto-plan on is
planned unattended as soon as it reaches Planning.

Turning Auto-plan on mid-interview hands the rest of the interview to the agent in the same thread:
it is told to stop asking and decide the rest itself, still running any plan review to the end, and a question it is waiting on is answered with that
instruction. Turning it off mid-run tells the agent you are back. Auto sign-off stays as you set it,
and acts when planning finishes whether or not Auto-plan is on.

An unattended planning agent that asks a question anyway is told to decide for itself and log the
call as unclear. The board answers at most 3 questions on one planning step; the next one waits for
you. Unattended planning runs with the stage's configured permissions, or without approval prompts
when the stage sets none, and it never edits files in the project root.

- With Auto sign-off on, the plan is approved even when some decisions are marked unclear. The
  Summary tab opens with the log expanded, so you can check them.
- Turning Auto sign-off on for a finished card whose plan is waiting approves it.
- A switch locks once its stage has passed: Auto-plan and Auto sign-off once the card leaves
  Planning, Auto-build once the card is building. A locked switch that is on can still be turned
  off.
- Auto-plan can still be turned on after the agent marked planning finished, for example while it
  runs a plan review you asked for. If its thread is still working, the agent is handed over when
  its current turn ends, and when it finishes again the plan is approved if Auto sign-off is on. If
  the thread has already finished, nothing is sent and the plan waits for your approval.
- Dragging a card back out of Building turns its Auto-build off, and back into Planning its
  Auto-plan and Auto sign-off off, so a card you pulled back waits for you. Turn them on again to
  resume. An agent moving a card back for you does the same; the board's own moves turn nothing
  off.
- Stopping the planning agent, or answering its question yourself, turns Auto-plan off. If the run
  fails on its own and has no retry left, it stops and waits for you with Auto-plan still on; the
  reason shows on the card's activity. Click **Continue** to run it again.
- Setting a start time on a card that is planning pauses it but leaves Auto-plan on.

Once an auto-planned card is past Building, the log offers **Send back to build with changes**, which
moves the card back to Building for another pass, and **Create follow-up card**, which adds a Backlog
card for the first decision worth revisiting.

Agents can set these switches with the `board_set_automation` tool, but only after you confirm it,
and never from an unattended run.

## Inherited from the group

A card inside a group takes the group's automation settings unless it sets its own. The tag next to
a switch says **from T3O-12** when it is inherited and **overrides T3O-12** when the card has its own
value.

An inherited Auto-build acts as soon as a child is in Ready with its dependencies done; it does not
wait for you to start the group. To stage a group's children as a batch, leave the group's
Auto-build off until you are ready, then turn it on.

After upgrading to this behaviour, a group with Auto-build on that was never started builds its
Ready children on the first pass after the server starts.

Changing a group's setting applies straight away to the children that inherit it, including ones
already being planned. When that would change work in progress, the board asks you to confirm and
lists what will happen.

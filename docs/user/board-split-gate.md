# Approving a split

When planning decides a card is too big for one branch, the agent proposes a split: one child card
per part. Nothing is created until you approve it. While the proposal waits, the card shows
**Input needed** and **Split proposed · N cards**.

## Reviewing the proposal

Open the card. The proposal docks just above the planning thread's composer, so the conversation
stays readable. **Review split** in the card's actions opens and closes it. Collapsed, it is one row
(**Proposed split · 7 cards · 2 revised · Needs approval**); expanded, its card list scrolls inside
it, and you can drag its top edge to make it taller or shorter. Each card remembers whether you
collapsed it and how tall you made it, in this browser.

While a plan review is running the dock starts collapsed, so you can follow the review. It opens again
by itself when the review finishes or the split changes, unless you collapsed it since.

Each child shows its dependencies, **Revised r2** when a review round changed its plan, and one of
two badges:

- **Planned**: the agent wrote a full implementation plan. The child lands in Ready, ready to build.
- **Needs planning**: the agent wrote a brief only. The child lands in Backlog and gets its own
  planning later.

## Group settings

The agent recommends two settings, and the proposal opens with them set. Change either before you
approve, or press **Use recommended** to go back.

- **Auto-build**: once you start the group, ready children with their dependencies met start on
  their own. Off means you start each child yourself.
- **Merge target**: **Own branch** gives the group an integration branch, so its children merge
  there and the group gets one final review before it merges onward. **Inherit** merges each child
  wherever the card itself would merge.

The agent usually recommends auto-build with an own branch when every child is planned, and auto-build
off with inherit for a rough breakdown of an epic. A card that is already inside a group with its own
branch usually inherits.

## Approving

**Approve split** creates the children and makes the card a group. It starts nothing: the group
stays in Planning until you start it. **Ask for changes** puts a reply in the planning thread's
composer, so you can tell the agent what to change and it can propose again.

A split always waits for a person, even when every automation gate is on. See
[Automation](board-auto-plan.md).

## Approving during a plan review

Approving creates the cards from the plans as they are, which would end a running review. So while
one runs, **Approve split…** offers **Approve after review** instead: you approve now, with the
settings you chose, and the cards are created from the final plans when the review finishes. The
dock turns into a bar, **Split approved · N cards created after review**, and the planning
agent is told it can finish without waiting for you.

**Undo** on the bar takes the approval back at any time before the cards are created; the split then
waits for you as usual. If a later review round adds, removes, merges, renames or reorders a card,
or changes which cards depend on which, the approval is dropped and the dock asks you to approve
again. Edits to a plan's text keep it.

When planning is paused or waiting on a question, you can choose either: approve after review, or
**Approve now**, which ends the review and creates the cards straight away. If planning fails, an
approval stays waiting and fires when planning completes.

# Approving a split

When planning decides a card is too big for one branch, the agent proposes a split: one child card
per part. Nothing is created until you approve it. While the proposal waits, the card shows
**Input needed** and **Split proposed · N cards**.

## Reviewing the proposal

Open the card. The proposal sits at the end of its planning thread, and **Review split** in the
card's actions takes you there. Each child shows its dependencies and one of two badges:

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

A card with **Auto-plan** and **Auto-build** both on skips this gate: its split is approved with the
card's own automation settings rather than the agent's recommendation, and the new group starts. With
Auto-plan alone the split waits here for you. See [Automation](board-auto-plan.md).

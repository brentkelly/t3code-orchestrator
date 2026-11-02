# Choosing how one card merges

The board merges every card's pull request the same way: the strategy set in **Settings → Board →
Pipeline → Ready for merge**, which is squash unless you changed it. One card can use a different
strategy without changing that setting for the rest.

## Setting it

Open the card, open the **⋮** menu beside its tabs, and choose **Merge strategy**. The row shows the
strategy the card will use now and where it comes from, for example `squash · default`.

- **Squash** lands one commit and drops the branch's history.
- **Merge commit** keeps the branch's ancestry. Use it for an upstream sync, or the next sync loses
  track of what was already merged.
- **Rebase** replays the branch's commits onto the base one by one.

The choice applies straight away, to the Merge button and to auto-merge alike. While a card has its
own strategy, its header shows a pill naming it. Click the pill to change the strategy again.

**Use board default** clears the card's own setting, and the card follows the board setting again,
including any later change to it. A card set to the same strategy as the board keeps its own
setting and does not follow later changes.

## Sub-board children

A child card with no strategy of its own uses its parent's. In that case the first option reads
**Use parent** and names the parent card. A child can still set its own strategy. Changing the parent's strategy also retries any held
child that uses it.

## Agents

An agent can set the strategy with `board_create_card` or `board_update_card` (`mergeStrategy`:
`squash`, `merge` or `rebase`, or `null` to clear it). `board_get_card` reports both the card's
own setting and the strategy it will actually merge with.

## Small print

- Your repository has to allow the strategy. If it does not, the forge refuses the merge and the
  card shows the forge's reason. Choosing another strategy on a card held for auto-merge tries the
  merge again straight away.

# What a card cost

The board adds up what every agent thread on a card spent — planning, the build, each CI fix and
every review, triage and adjudicate round — and prices it. Work a thread hands to a
`delegate_task` child, or that child's own delegates, counts toward the same card and step.

## Where to see it

- **The card's Summary pane** shows the total in its **Cost** tile at every stage, with a bar by
  stage. Click the tile to open the **Usage** section: a table you can switch between **By stage**
  (open a stage for each round on its own row) and **By model**. Input there is the uncached part;
  hover it for the cached tokens. Like every Summary section, Usage starts closed on each card.
  Opening a card from a group's cost breakdown lands straight on it.
- **A card in Done** shows its total at the right of its footer. Before Done the face stays as it
  was; the figure leaves the face if the card is moved back out of Done.
- **A group** in Done shows the total of everything under it, nested groups included. Click the
  figure for each child's share. Inside a group's board the header shows the same total at any
  stage.
- **The board header** shows what the cards in view cost. It follows the filter and the project
  scope; click it for a split by column and by provider.
- **The List view** has sortable **Tokens** and **Cost** columns, a cost filter (over the
  threshold, or cards with partial data) and a total for what is listed.

Agents can read the same figures: `board_get_card` returns a card's usage by step, and
`board_get_card_context` returns its total.

## Reading the figure

| Figure   | Means                                                                                         |
| -------- | --------------------------------------------------------------------------------------------- |
| `$1.84`  | Exact: every priced turn used a price you set.                                                |
| `≈$1.84` | At least part of it is priced from the public model price table.                              |
| `$1.84+` | A lower bound: some turns had no price, or the provider reported no usage or only part of it. |
| `—`      | Nothing is known yet. It is never shown as `$0`.                                              |
| `so far` | A step is still running. The figure moves once each time a turn finishes.                     |

Providers that do not report token usage (Cursor and Pi, and Grok and other ACP agents for now)
count as _no usage_, which makes the figure partial. So does work a card did on a worker before
the board started recording usage, or on a worker running an older T3o that does not report it.

Each turn is priced when it finishes, so changing a price later does not change what past cards
cost.

## Setting prices

The board prices turns with the prices on the **Usage** page of the server that hosts the board,
including any custom prices under **Model prices** there; see [Usage](./usage.md). A price you set
counts as exact. The Usage section's note on a partial total links to that page.

## The highlight threshold

A Done card that cost at least **Settings → Board → Highlight cards costing over** ($5 unless you
change it) shows its figure in full ink, and the List's **Over** filter uses the same amount. It
applies to everyone using the board.

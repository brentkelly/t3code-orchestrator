# Starting a card the moment it is unblocked

The **Start automatically when unblocked** switch is now **Auto-build**, in the card's
**Automation** section. See [Automation](board-auto-plan.md#the-automation-section).

With Auto-build on, a card at **Ready** moves itself into Building as soon as its last dependency is
done. It does exactly what pressing **Begin build** would: the card's workspace is created and an
agent picks it up, or it queues like any other card if every agent is busy.

- Archiving a dependency counts as finishing it.
- Unlike the old switch, Auto-build stays on after the card starts. Dragging the card back out of
  Building turns it off, so a build you pulled back waits for you.
- The board checks every thirty seconds as well as reacting to each card finishing, and picks up a
  dependency that finished while the server was off.
- To resolve a chain overnight, turn on [Auto-merge](board-auto-merge.md) for the dependency too: it
  merges itself, lands in Done, and the waiting card starts.
- A card that is also [scheduled](board-scheduled-starts.md) moves to Building, then holds there
  until its time.

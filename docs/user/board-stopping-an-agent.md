# Stopping or steering a card's agent

A card the board is running is working on its own. Two things you can do to it — pressing **Stop**,
and simply typing into its thread — mean quite different things, and the board treats them
differently.

## Stop hands the card back to you

Pressing **Stop** in the composer of a card's thread stops the agent, parks the card as **Paused**
and gives its agent slot back to the queue. The conversation and the workspace are both kept, so
nothing is thrown away.

It also switches the card to **human-in-the-loop**. That is the part worth knowing: stopping an
agent is you taking the wheel, so the board stops driving. Nothing is auto-started on that card
until you say so, and the agent may end a turn waiting on your answer instead of being nudged back
to work.

Nothing is posted into the thread. The last thing in the conversation is whatever the agent was
doing when you stopped it.

### Getting back out

Two ways, and you can use either:

- **Resume** on the card puts the work back in the queue.
- Type into the thread and the card picks the work up from what you said.

The **human-in-the-loop** toggle in the card's header is how you hand it back to the board. Stopping
a card is never a one-way door.

Stopping a card that is already human-in-the-loop just pauses it — there is nothing to hand over.

## A message steers, it does not stop

Typing into a card's thread while the agent is working is a correction, not an interruption. The
agent folds it into what it is doing and the card stays unattended: the board goes on supervising
it, and it will still be picked up and moved on when the work is done.

What changed is that the board no longer talks over you. It used to see the agent's turn end, read
that as the agent stopping, and post "carry on with the work" straight underneath your message — so
the agent got your instruction and a contradictory one in the same breath. Now your message is
recognised for what it is, and the next thing in the thread is the agent's answer to it.

Your message also clears whatever stall the card had accumulated, so a card you have just corrected
starts from a clean slate rather than being one stop away from asking for help.

If you want the card to stop rather than take a correction, press **Stop**.

## The board still notices a wedged agent

Steering buys the agent one turn, not immunity. If it goes quiet for its whole timeout after you
have spoken to it, the board nudges it exactly as it would have before, and an agent that keeps
stalling still ends up asking you for help. A supervisor that never speaks up is not a supervisor.

## Related

- [Scheduling when a card runs](board-scheduled-starts.md) — setting a time on a working card also
  stops it now, and picks it up again at that time.
- [The build queue](board-build-queue.md) — where a stopped card's agent slot goes.

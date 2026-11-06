# Stopping or steering a card's agent

A card the board is running is working on its own. Two things you can do to it — pressing **Stop**,
and simply typing into its thread — mean quite different things, and the board treats them
differently.

## Stop pauses the card

Pressing **Stop** in the composer of a card's thread stops the agent, parks the card as **Paused**
and gives its agent slot back to the queue. The conversation and the workspace are both kept, so
nothing is thrown away.

Stopping changes nothing else about the card. Its **human-in-the-loop** setting stays as you left
it, and only the toggle in the card's header changes it.

Nothing is posted into the thread. The last thing in the conversation is whatever the agent was
doing when you stopped it.

### Getting back out

Two ways, and you can use either:

- **Resume** on the card puts the work back in the queue.
- Type into the thread and the card picks the work up from what you said.

Either way the work carries on with the same human-in-the-loop setting it had before you stopped
it.

## A message steers, it does not stop

Typing into a card's thread while the agent is working is a correction, not an interruption. The
agent folds it into what it is doing and the card is otherwise left alone: its human-in-the-loop
setting does not change, the board goes on supervising it, and it will still be moved on when the
work is done.

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

## When a card's agent stopped on its own

Sometimes a card's step stops without anyone pressing Stop: the agent's thread died, or the board
could not start it at all (a full disk, a provider that would not launch). The card says it
**stopped**, and its action column offers one button with three choices:

- **Continue** picks the step up where it stopped. If its thread is still there the agent is told
  to carry on; if there is no thread, a new one starts on the same step. In Code review this is
  the phase the loop is owed, so the loop carries on from there.
- **Restart**, under the arrow, drops the stopped step and starts it again in a fresh thread.
- **Move to** the next stage, also under the arrow, leaves the step behind and moves the card on.

The same button is there when a card is **waiting to resume** after hitting a usage limit or
while it backs off before a retry. The board will start it again by itself, but **Continue** starts it now.

Talking to an earlier thread of the card does not restart a stopped step. That thread's work is
already recorded, so pick one of the three instead.

## Related

- [Scheduling when a card runs](board-scheduled-starts.md) — setting a time on a working card also
  stops it now, and picks it up again at that time.
- [The build queue](board-build-queue.md) — where a stopped card's agent slot goes.

# Notifications when a card needs you

With auto-plan and auto-build running, cards can stop and wait for you while you are looking at
something else. T3 Code can alert you when a card on your board starts waiting on you, with a sound,
an in-app toast or a system notification. Clicking the alert opens the card.

## Turning it on

Card alerts follow **Settings → Notifications**. Pick a **Thread notifications** mode, or turn on
**In-app notifications**. Nothing alerts while both are off. Below them, **Board card notifications**
is on by default, with a switch for each kind of wait:

- **Input needed**: a question, a permission prompt, a plan or split to approve, a review that is
  stuck, or CI that stopped and waits for your decision.
- **Needs a human**: a stage stopped and only you can move the card on, recovery gave up, the
  review loop stopped, auto-merge gave up (**Merge needs you**), or a card reached Ready for merge
  with no pull request.
- **Ready for merge**: a pull request waits at the merge stage and auto-merge is off.
- **Blocked**: a card's dependencies stop it. Off by default, because it usually clears by itself.

An alert fires once when a card starts waiting, and it closes when the card stops waiting. Waits
the board ends by itself never alert: a usage limit, a retry, a held merge, conflicts being fixed,
or a worker that is offline. Neither does a card you paused, a finished card, or a card in a project
hidden from the board. A group or split parent stays quiet; the child that waits alerts under its
own key.

## Card threads

When a card's own thread already alerted for the same wait, such as its question or a permission
prompt, the card does not alert again. A question the board parked after the agent's turn ended
always alerts from the card.

**Mute routine card-thread alerts**, on by default, drops "Thread completed" and usage-limit alerts
for card threads. Board agents finish turns all the time, and those alerts would bury the ones that
need you. Questions, approvals and failures from card threads still alert.

## Limits

Alerts come from an open T3 Code window or browser tab on this device. A background tab works.
Nothing alerts while no client is open. Each open client alerts on its own, and the settings are
per device.

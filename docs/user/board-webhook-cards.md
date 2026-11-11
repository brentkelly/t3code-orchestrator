# Creating cards from GitHub issues

A webhook task can drive the board instead of running a prompt. Each request creates, starts or
archives the card it names, with no agent turn. The first use is GitHub issues: an issue labelled
`t3o` becomes a card, and closing it archives the card again while its work has not started.

Set the rule up on the server that hosts your board, not on a [worker](board-workers.md). Nothing
stops you saving one on a worker, but its cards land on that worker's own board.

## Setting it up

1. In **Settings → Scheduled tasks**, add a task in the project the cards belong to and choose
   **On webhook**. See [Webhook automations](project-settings.md#webhook-automations) for the URL.
2. Under **Action**, choose **Board rule**, edit the label name if you use another one, and press
   **Use GitHub issue preset**. It fills in the task's `issues` event filter, the duplicate key
   from GitHub's delivery id, the signature check, and three rules.
3. Enter a signing secret. A board rule always needs one, because issue text comes from anyone who
   can open an issue. Save.
4. In the repository's webhook settings, add the task's URL with content type `application/json`,
   the same secret, and the **Issues** event.

The model and thread fields stay on the form but are not used by a board rule.

## What each event does

Rules run in order and the first one whose filters all match wins:

- **Closed, deleted or transferred**, or **unlabelled** `t3o`: archives the card, but only while it
  is before Planning. A card whose work has started is left alone.
- **Opened, labelled or reopened** with `t3o` and still open: creates a card in the project's first
  stage, titled after the issue and linked to it. Its brief opens with a line saying it came from
  an outside party, so an agent planning it treats the text as data rather than instructions.

If a card for the issue already exists, nothing new is made. Reopening an issue brings back a card
only if this rule archived it; a card you archived yourself stays archived.

A rule can also **Move the card**, which is how a webhook starts work: it can move a card forward
as far as Planning. Webhooks never create or move cards into Building or later, so they can't
start a build or skip a review.

## Seeing what happened

- **Deliveries** in the task's menu shows one line per request, such as `Created T3O-80` or
  `Skipped: T3O-80 is in Planning`.
- The card's activity names the task, as `Webhook: <task title>`.
- An open card shows the issue as a link beside its labels.

A task holds at most 20 queued deliveries; beyond that GitHub gets an error and can redeliver
later. Editing an issue's title or text later does not change its card.

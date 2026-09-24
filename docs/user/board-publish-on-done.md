# Publishing the site when a card is done

A card that reaches **Done** with its pull request merged can run a project script that updates the
site visitors see. The board does not guess the command: each project names one in `t3.json` or
Project Actions, flagged **Run when a card is done and its pull request is merged**.

## Turning it on

**Settings → Board → Pipeline → Done → Publish when done**, off by default. When the switch is on, a
checklist of this environment's projects appears under it. A card publishes only if:

- the switch is on,
- its project is checked,
- that project has a `runOnCardDone` script,
- this is the first time this card-round is observed as Done with a merged pull request.

Turning the switch on does not publish cards already sitting in Done. Those may be parked from
before the script existed. They stay silent until a later card of that project finishes, or until
you press **Retry publish** on a card whose last attempt failed.

Turning the switch off keeps the checklist, so turning it back on restores the same projects.

## What it runs

The script runs in the project's default checkout, after a fast-forward pull of the card's base
branch. If that checkout is dirty, on another branch, or cannot fast-forward, the card stays in Done
and says so on its activity rail. Several cards finishing together collapse into one publish of the
project.

A SHA that is already live is skipped. A failed attempt wears **Publish needs you** on the card, and
the card detail offers **Retry publish**.

## The script

In the project's Actions, or in `t3.json`:

```json
{
  "scripts": [
    {
      "name": "Publish",
      "command": "npm run build && rsync -a --delete dist/ ../site/",
      "icon": "build",
      "runOnCardDone": true
    }
  ]
}
```

Import that action in Settings → Project, then check the project on the Done stage.

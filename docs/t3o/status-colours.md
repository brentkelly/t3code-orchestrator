# Status colours

Three colours carry work state, everywhere a user can see one: the board, sub-boards, the card
modal, the thread sidebar, the chat composer and the mobile thread list. They mean the same thing on
every surface, which is the whole point — a colour that means "running" on the board and "done" in
the sidebar teaches the user nothing.

| Colour     | Token                                    | Means                                              |
| ---------- | ---------------------------------------- | -------------------------------------------------- |
| **Green**  | `--success` / `--success-foreground`     | Done. Complete. Settled. **Nothing else.**         |
| **Blue**   | `--info` / `--info-foreground`           | In progress — building, running, a live turn.      |
| **Violet** | `--attention` / `--attention-foreground` | Waiting on a human. A question, a plan to approve. |

Amber (`--warning-foreground`) is the fourth, and it is not a work state: it marks something
**blocked or held** — an unmet dependency gate, a review loop that stopped without converging, a
stale merge base. It predates this convention and keeps its own meaning.

The Tailwind utilities are `bg-*`, `text-*-foreground`, `border-*`, and they take opacity modifiers
(`bg-info/12`, `border-attention/55`). All three are defined in `apps/web/src/index.css`; `--attention`
is violet-500 light / violet-700 foreground, lifting to violet-400 in dark, exactly mirroring how
`--info` and `--success` are built.

## The rules

- **Green is reserved.** Only a finished thing is green: a done progress segment, a completed plan
  dot, a satisfied dependency edge, a review round that closed clean. A working state in green was
  the single biggest source of misreading on the board, because a card mid-build looked finished.
- **Every running indicator is blue.** Spinners take a blue track and head —
  `border-[color-mix(in_srgb,var(--info)_25%,transparent)] border-t-info-foreground` — rather than
  the neutral grey they used to wear. Running pills are `bg-info/12 text-info-foreground`, not the
  neutral `bg-accent`.
- **Every "waiting on you" state is violet.** Input-needed chips, the awaiting card's border, tint
  and ring, waiting nodes in the dependency chart, a review phase waiting to run, the composer
  drawer that holds an agent's question, the sidebar's Input row, mobile's Awaiting Input pill.
  These were blue before, which read as "still working" — the opposite of what they mean.
- **Blocked is amber, never blue.** It matches the card modal's blocked callout, which already used
  it.
- **No colour without a claim.** A colour asserts something about work happening right now, so an
  indicator that cannot make that assertion stays neutral (`bg-muted text-muted-foreground`) and
  says why in words. The review pane is the case that forced the rule: its loop and round state are
  derived from the step ledger, which still reads "round 1, review due" for a card that has never
  reached the review stage — so off the stage the pill, the round pill and the phase markers all go
  neutral and read "Not started" / "Not running" rather than spinning at a card sitting in Building.

## Deliberately outside the convention

These are blue or green for reasons that have nothing to do with work state, and changing them
would be a regression:

- Hyperlink blue in chat markdown.
- Diff `+`/`-` green and red.
- Review **issue** outcome tones in the review pane (`open` / `fixed` / `rejected` / `disputed`) —
  a per-finding vocabulary, not a per-card status. Round-level pills do follow the convention.
- Pull-request state colours (open green, merged violet, closed red) — GitHub's own convention,
  which users read faster than ours.
- The blue "open" chip that marks a selected pull request. That is UI state, not work state.
- The teal terminal-process indicator, which deliberately reads as "not agent work".

## Where the seams are

`--attention` is a new token in an upstream-owned stylesheet, and the sidebar, composer and mobile
thread presentation are upstream-owned files. Each edit carries a `T3o:` marker pointing back here;
see [the seam inventory](./seams.md#seam-inventory).

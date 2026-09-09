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
review phase whose result the board could not read, and a stale merge base. It predates this
convention and keeps its own meaning.

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
- **A held merge is amber, and the pill does not spin.** A card whose merge hit conflicts is blocked
  and running at once — an agent is rewriting the branch — so the indicator has to pick a
  vocabulary, and it picks the held one: the `Conflicts` pill's claim is that the MERGE is held,
  which is the same fact that disables the Merge button. The running half is not lost; the card's
  blue working dot stays lit beside it, each fact in its own colour. The board pill carries no
  spinner, because a board shows thirty cards at once and one more continuously animating element
  per card is a cost the fact does not justify; the card modal's banner, being one element in an
  open modal, keeps its spinner.
- **A card waiting on a provider is amber, and so is the header pill (T3O-22).** A usage limit is
  the same fact as blocked, one level up: nobody is working, the board cannot make it work, and it
  is waiting on something outside itself. All four readings of `stalled` — waiting to resume on a
  usage limit, out of credits, waiting for a retry rung, and recovery having given up — are amber
  and are the same chip; only the words differ, because the colour is answering "is work happening"
  and the answer is no in every one of them. Green would be a lie in all four, and blue in all four.
  The card modal's stalled banner splits where the chip does not: the two readings the board will
  end by itself (a usage-limit park, a retry rung) are amber and read "waiting to resume", while the
  two that stay put until a human acts keep the red failure treatment they have had since t3o-30 —
  the banner asserts "this needs you", which is exactly the half of `stalled` it is still true of.
  `boardStallIsWaiting` is that split, so the banner cannot drift from the chip beside it.
  The provider-usage pill in the board header takes the same amber for the same reason. It carries
  no spinner and no ticking countdown: its numbers are coarse (`in 1h 38m`) and repaint only when
  the board does, because a header is on screen all the time and a per-second repaint there is the
  GPU cost this document exists to refuse.
- **No colour without a claim.** A colour asserts something about work happening right now, so an
  indicator that cannot make that assertion stays neutral (`bg-muted text-muted-foreground`) and
  says why in words. The review pane is the case that forced the rule: its loop and round state are
  derived from the step ledger, which still reads "round 1, review due" for a card that has never
  reached the review stage — so off the stage the pill, the round pill and the phase markers all go
  neutral and read "Not started" / "Not running" rather than spinning at a card sitting in Building.
- **A stopped agent is never blue.** A step whose turn ended without completing is not working, so
  it never wears the running dot. If it left a question behind it is violet ("Input needed"); if it
  did not, it is amber ("Needs a human"). And if a HUMAN stopped it, it is neutral
  (`bg-muted text-muted-foreground`) and reads "Paused" — the human already knows why it stopped and
  the board has nothing to ask them, so there is no claim to colour. That is the "no colour without
  a claim" rule applied to a work state rather than to a derived one: amber would say the card is
  blocked and violet would say something is waiting on an answer, and neither is true of a card its
  own user parked. All three are the same fact — nobody is working on this card — told at the volume
  the human's next move deserves, and the volume for "you did this on purpose" is zero.
- **And the reverse: a working card never says it needs a human.** The dot and those two chips are
  opposite claims, so a card can only ever wear one of them. They come from different sources — the
  dot from thread liveness, the chips from the step row — and the step row can go stale, which is
  how the board once shipped a card pulsing blue beside "Needs a human". Where they disagree the
  evidence wins and the chip goes, the same ranking that darkens the dot when a step claims to be
  running on threads that are provably dead. This covers "Needs a human" in both its spellings: the
  stopped step's, and the settled step's that only a human moves on. A live thread's own pending
  question is exempt: it is answerable in one click, and hiding it behind the dot would strand the
  answer.
- **…and it waits five seconds before it says it.** The dot going dark is not the end of the story:
  the turn ends, the step row parks and the supervisor decides whether to resume, over several round
  trips that do not land together. Through that beat the card is neither working nor genuinely
  parked on anybody, and flashing amber through it trains people to ignore the one chip that means
  "this one is yours now". So both "Needs a human" chips wait `BOARD_ATTENTION_SETTLE_MS` after the
  card's thread last finished a turn. Only those two: a pending question is answerable the moment it
  is asked, a stall has already exhausted recovery, and a pause is the human's own instruction —
  none of them is guessing about a beat that has not finished.

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
- The primary tint on the board card's **Start automatically when unblocked** switch when it is on.
  Same argument: a checked control is UI state. The status surface for that feature — the card
  face's **Auto-start** chip — is neutral, because the card is not running.
- The teal terminal-process indicator, which deliberately reads as "not agent work".

## Where the seams are

`--attention` is a new token in an upstream-owned stylesheet, and the sidebar, composer and mobile
thread presentation are upstream-owned files. Each edit carries a `T3o:` marker pointing back here;
see [the seam inventory](./seams.md#seam-inventory).

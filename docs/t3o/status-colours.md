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
  `border-board-spinner-track border-t-info-foreground` — rather than
  the neutral grey they used to wear. Running pills are `bg-info/12 text-info-foreground`, not the
  neutral `bg-accent`.
- **Every "waiting on you" state is violet.** Input-needed and Needs-permission chips (a thread
  blocked on a permission prompt is waiting on you exactly as much as one that asked), the awaiting
  card's border, tint and ring, waiting nodes in the dependency chart, a review phase waiting to
  run, the composer drawer that holds an agent's question, the sidebar's Input row, mobile's
  Awaiting Input pill.
  These were blue before, which read as "still working" — the opposite of what they mean.
  A subagent's permission prompt counts too (T3O-73): a card thread whose `delegate_task` child
  waits on an approval reads "Needs permission", by upstream's own subagent-request rule, because
  the parent agent cannot answer it. A child's question does not: the parent agent answers those.
  Two limits: a card on a worker does not turn violet (only its supervisor hold sees the child), and
  the client also flags side chats and cross-environment delegations, which that hold does not.
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
- **One notice per card, and it is ranked.** The card face has room for a single status word, and it
  shipped with two slots — `boardCardAttention`'s chip on the left, the merge pills and the
  dependency gate on the right — with nothing stopping both from filling. A card whose auto-merge
  ladder ran out wore `Needs a human` beside `Merge needs you`: the same claim twice, in the same
  amber, and together wider than the 268px column, so the second chip hung off the card's right edge.
  `boardCardNotice` ranks them into one slot, most specific first — a pending question or permission
  prompt (answerable in one click, the same carve-out it gets everywhere else), then `Conflicts`,
  then the auto-merge hold, then `No PR`, then the rest of the attention chip, then the dependency
  gate. `No PR` (T3O-48) is a card parked at the merge-role stage with no pull request — amber, making exactly the claim
  `Needs a human` makes and naming the cause, which is why it sits above it and below the two pills
  that describe a card which does have a pull request. It waits out the same
  `BOARD_ATTENTION_SETTLE_MS` grace the other two ambers do, because a card arriving at Ready for
  merge is briefly PR-less while the stage-move lookup is still in flight. The gate is last because it is the
  one notice whose fact survives elsewhere on the card: the meta row's chain icon carries the count at
  every stage. Below the gate, `Stage removed` (T3O-43) is amber: the card's project switched its
  stage off (T3O-49), so it is held there until a human moves it on. This is deliberately not a comparison of tones — amber-versus-violet says how loud a
  notice is, not which fact the human needs, and `Merge needs you` beating `Needs a human` is a
  ranking between two ambers. The winner truncates rather than pushing, so a long label clips inside
  its card instead of overflowing the column. The neutral informational pills — a queue position, a
  scheduled start, the auto-start arm, the grey `Auto` glyph — keep their own right-hand slot, because
  they assert that nothing is needed from the human, which is the opposite claim.
- **A card waiting on a provider is amber (T3O-22).** A usage limit is the same fact as blocked,
  one level up: nobody is working, the board cannot make it work, and it is waiting on something
  outside itself. Every reading of `stalled` — waiting to resume on a usage limit, waiting for a
  retry rung, recovery having given up, a branch the board could not prepare (T3O-15) — is amber
  and is the same chip; only the words differ, because the colour is answering "is work happening"
  and the answer is no in every one of them. Green would be a lie in all of them, and blue too.
  The card modal's stalled banner splits where the chip does not: the two readings the board will
  end by itself (a usage-limit park, a retry rung) are amber and read "waiting to resume", while the
  ones that stay put until a human acts keep the red failure treatment they have had since t3o-30 —
  the banner asserts "this needs you", which is exactly the half of `stalled` it is still true of.
  `boardStallIsWaiting` is that split, so the banner cannot drift from the chip beside it.
- **A worker the board can't use is amber, and online stays grey (T3O-60).** Worker offline, Worker
  removed, Access revoked and Incompatible all say the same thing: the cards on that worker are
  held, and only a human (or the worker coming back) frees them. A failed Move is amber for the same
  reason — the card is held mid-move until someone retries or picks another worker. Connecting and
  cloning are running, so they are blue; a finished checkout is green; a worker that is simply
  online is the steady state and makes no claim, so it is neutral.
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
  question or permission prompt is exempt: it is answerable in one click, and hiding it behind the
  dot would strand the answer. It goes the other way instead — a thread blocked on the human darkens
  the dot, because its step is still running but nothing moves until they answer.
- **…and it waits five seconds before it says it.** The dot going dark is not the end of the story:
  the turn ends, the step row parks and the supervisor decides whether to resume, over several round
  trips that do not land together. Through that beat the card is neither working nor genuinely
  parked on anybody, and flashing amber through it trains people to ignore the one chip that means
  "this one is yours now". So both "Needs a human" chips wait `BOARD_ATTENTION_SETTLE_MS` after the
  card's thread last finished a turn. Only those two: a pending question is answerable the moment it
  is asked, a stall has already exhausted recovery, and a pause is the human's own instruction —
  none of them is guessing about a beat that has not finished.
- **CI reads the same way (T3O-44).** On the card face's step segments, the card view's CI tab
  and the step badge Code review shares with it: a running step and a step a fix agent is working
  on are blue, a passed step is green, a step that failed and will not be fixed in place is amber,
  and a cancelled step is a grey dash. The Queued chip is neutral, like the build queue's. A card
  CI sent back to review wears an amber note and banner — it is held until a fresh review round
  clears it — and "CI skipped by …" is neutral: a human chose it, so there is nothing to claim.
  Nothing on the card face animates; the running step's name shimmers only in the open card view.
  The working dot is lit while a CI script runs or a live fix agent works on it (T3O-68), and no
  "Needs a human" chip shows while a CI script is queued or running.
  T3O-49 adds two CI chips. `Can't run` is amber: the pass is blocked on something outside it (no
  worktree, a worker out of reach, no pull request for a forge step). `Needs you` is violet: CI
  stopped at the round-trip limit and a human decides — retry, send back, or skip. In Settings, a
  `t3o.json` waiting to import is violet (a human decides whether to take it), and the override
  and parallel-step markers are neutral: they describe a setting, not work.
- **A stuck review loop is violet; an advanced one is neutral (T3O-51).** `Stuck` means triage and
  the adjudicator still disagree after a second pass and the loop waits for a human's ruling, so it
  is violet, and only while the card is in Code review. Once a human advances the card past it, the
  loop reads `Advanced past stuck round N`: not green, because nothing was signed off, and not
  violet or amber, because nobody is waited on. An escalated finding is violet too.
- **A group's sub-board chips split blue into solid and hatched (T3O-91).** Solid blue claims an
  agent is on the child; a child at or past Building that is only queued for a slot wears blue
  stripes over a faint blue tint instead, so a busy board doesn't read as four builds when two are
  waiting. A card held by an offline worker is neither: no slot will start it, so its chip is
  amber, matching the worker's own notice, but it is not counted or named as blocked, because the
  card itself isn't. Violet, amber, green and grey keep their meanings, and no chip moves.
- **The Summary pane's Heads-up tags and check tiles follow it too.** Plan change is violet (it
  waits on a human's read), Not done is amber, and Shortcut is neutral, never blue, because blue
  means running. A failing check tile is amber, not red.

- **The tab title is a status surface too (T3O-82), and it has no colour to spend.** A tab showing
  a card, a card's thread or a sub-board names the card's status in brackets after its title; a
  plain thread names its sidebar status. A leading `*` stands in for violet and amber alike: it
  marks anything that needs a human or is blocked, and a blue `Working` goes unmarked. The status
  comes from the card face's own ranking (`tabStatus.logic.ts`), so the tab cannot disagree with
  the card, with one addition: Ready for merge is starred, by the card notifier's rule, although
  the face leaves it uncoloured. Done, Paused and idle cards carry no status, and the words never
  carry a clock, because a ticking title churns the tab.

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
- A card's project colour — the key pill, legend and picker dots. It is the project's icon colour
  (T3O-4), chosen by the user from the full icon palette, so it can be green, blue or violet. It says
  which project a card belongs to, never how its work is going, and the status indicators beside it
  keep their own vocabulary.

## Where the seams are

`--attention` is a new token in an upstream-owned stylesheet, and the sidebar, composer and mobile
thread presentation are upstream-owned files. Each edit carries a `T3o:` marker pointing back here;
see [the seam inventory](./seams.md#seam-inventory).

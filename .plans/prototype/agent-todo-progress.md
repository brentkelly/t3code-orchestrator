# Agent todo progress on cards

Surface an agent thread's todo/progress list on the task card and in the card modal. Prototype: `t3o.dc.html` (board cards + card modal thread pane). Exploration of the alternatives considered: `Card Progress Options.dc.html`.

## Model

A todo list belongs to an **agent thread**, not to a card. A card may have several threads, so a card may have several lists.

```
Thread { id, cardId, label, state: working | waiting | stopped, todos: TodoItem[] }
TodoItem { id, text, status: done | doing | todo, startedAt? }
```

`label` is the thread name already shown in the modal tab bar. Only one item should be `doing` at a time; `startedAt` drives the elapsed time next to the current item.

## Rules

1. **Subcard progress wins.** If a card has plan subcards, the card shows the existing plans strip only. Todo lists live on the subcards, not aggregated up.
2. **A card shows one list** — the active thread's. Priority: awaiting input, then running, then most recently updated; ties go to the thread the user last opened on that card.
3. **Done items are never listed on the card.** The card shows the count and the current item only.
4. **Multiple threads cost one affordance and no extra height** until opened.
5. A review block on the card also takes precedence over the todo strip (one progress block per card).

## Card strip

Placed below the title, above the meta row, separated by a 1px top rule — same construction as the existing plans strip.

- Pip row, one pip per todo item: done `--success`, doing `--info` at 70%, pending `--fg` at 12%. `height:3px; border-radius:2px; flex:1`.
- Row below: mono count `2/5`, then the current item's text (11px muted, single line, ellipsis).
- If the card has more than one thread, a small chip on the right of that row: message icon + thread count. Click (stopPropagation — must not open the card) toggles one compact row per thread: state dot, thread label, count, and a note (`running`, `idle 2h`). Collapsed by default; state is per card, client-side only.
- No list, or list finished and thread stopped: show nothing new; the card falls back to its current meta row.

## Card modal — thread pane

- **Tab bar**: each tab appends its own mono count (`Reducer cleanup 2/5`). This is the whole multi-thread affordance in the modal; no extra chrome.
- **Todos strip**: sticky, directly under the tab bar and above the transcript, on `--card` with a bottom border. One strip per tab, showing that tab's list.
  - Collapsed (default while the thread is running): chevron-right, count, current item, pip row.
  - Expanded: chevron-down, `TODOS` label, count, pip row, `updated Xs ago`; then the full list — done items struck through and muted with a check, the current item in 12.5px `--fg` with a spinner and elapsed time right-aligned, pending items muted with an empty ring.
  - Auto-expanded when the thread is awaiting input; otherwise collapse state is remembered per thread.
  - When the list is settled, the strip stays collapsed and reads the final count.
- **Transcript**: every revision of the list emits a quiet centred divider event, `Todo list updated`. The strip only ever shows current state; history lives in the transcript.

## Notes for implementation

- The strip must never change card height when a second thread appears — the chip replaces nothing and adds no row until clicked.
- Truncate item text to one line everywhere on the card; do not wrap.
- Stopped or idle threads: no spinner, muted text, so a dead list does not read as active work.

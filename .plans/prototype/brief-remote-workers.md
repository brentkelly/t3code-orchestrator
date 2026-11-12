# Brief: Remote workers and load-balanced placement (UI)

Prototype: **Remote Workers** page (`Remote Workers.dc.html`). Artboard numbers below (1.1, 2.1 …) refer to that page.

This brief covers only the UI added for remote workers: what each surface shows, its states, its wording, and how the pieces connect. It says nothing about how any of it is implemented.

---

## 1. Concepts the UI relies on

| Term | Meaning in the UI |
|---|---|
| **Worker** | A headless machine that has joined this board and takes its cards. |
| **This server** | The board server itself. It's always present as a worker, can't be removed, and is where planning runs. On card chips it's labelled “this server”. |
| **Headroom offered** | Free CPU, RAM and disk the worker currently offers, shown against the capacity it declares. The UI never explains a gap between what's free and what's offered. |
| **Readiness script** | A script the project keeps in its repo (e.g. `.t3/ready.sh`). It's run in the project checkout on a machine; exit 0 means that machine is ready to take the project's cards. |
| **Readiness** | Per worker and per project: Ready, Not ready (the script failed), Cloning, Checking, or Not set up. |
| **Placed / Not placed yet** | A card is placed on a worker when its build starts. Before that it shows “Not placed yet”. |
| **Pinned** | The user has fixed which worker a card's builds go to. |
| **Size** | A per-card S / M / L / XL for each of CPU, RAM and disk: ½×, 1×, 2× and 4× of the project baseline. |
| **Abbreviation** | A 1–3 character uppercase code per worker (`SRV`, `B01`, `B02`, `MAC`, `B03`), like a project key. `SRV` is reserved for the board server. |
| **Signed-in account** | For each provider on each worker, the account and plan that worker's provider CLI is signed in as. |

The board shows only what each worker reports: status, headroom, provider quota, signed-in account and readiness. It never shows or implies whether a worker does anything else.

## 2. Visual rules

- **Status colours are fixed:**
  - Blue: running, preparing, queued, cloning, checking, or waiting for a join.
  - Violet: waiting on a person (input needed, provider signed out).
  - Amber: blocked until something changes (offline, needs update, not ready, not set up on the board server, too big, near quota).
  - Green: Done cards only.
  - Grey: steady or neutral states (connected, ready, joined, not placed yet).
- Completed stages, ready checkouts and a successful join use a **grey tick**, never green.
- **No continuously repainting animation:** no spinners, no pulsing dots.
  - Running is a still blue dot.
  - Progress is a stepped bar (5 segments) or a count, and changes only when new data arrives.
  - Times update at most once a minute (for example “in 9 min”).
- The worker chip on a card never takes a status colour, and abbreviations get no colour of their own.
- **Abbreviation vs full name:** use the abbreviation where space is tight (card chips, thread rows, the Measured step column, the filter button label), always with the full name in a tooltip. Use the full name everywhere else (Workers page, dialogs, pin menu, waiting popover, sentences); where both fit, show the abbreviation as a small outlined mono badge beside the name.
- Follow the existing design language: DM Sans, mono for keys, IDs and commands, existing radii, panels and buttons. Every surface works in light and dark.

## 3. Settings → Board → Workers

### 3.1 Page layout (2.1)
- “Workers” is a new item in the Settings sidebar under Board. It gets an amber dot when any worker needs attention.
- The header holds the title, a one-line description and the primary **Add worker** button.
- Below it, a read-only capacity hint (lock icon): “Capacity is set on each worker with `t3 worker config` and is read-only here.” The command is copyable.
- If any join codes are still open, a grey line sits above the list: “1 join code open · expires 22:58” with Cancel.
- The list is a single panel. Its columns are Worker | Status | Headroom offered | Provider quota · weekly · account | menu.

### 3.2 Worker row
| Column | Content |
|---|---|
| Worker | Icon, name with abbreviation badge, then a mono sub-line: version · joined date. This server also gets a “Board” tag and “runs planning”. |
| Status | One of: Connected (grey); Offline (amber, “Last seen 17:52 · 50 min ago”); Needs update (amber, “Connected · taking no new cards”). Optional sub-line such as “4 cards · 3 agents running”. |
| Headroom offered | Three rows: CPU, RAM, Disk. Each has a bar (in use against declared) and a bold free figure: “**4** / 32 cores”. |
| Provider quota | One block per provider: name, bar, %. A quota near its limit has an amber bar, an amber % and the line “Codex near limit · no new Codex steps”. Under each bar, in mono: the signed-in account and plan, e.g. `ana.k@studio.example · Max`. |
| Menu | “…” with: Re-check all projects, Rename…, Show cards on {worker}, then a divider and Remove worker… (destructive). This server shows “Built-in” instead of a menu. |

- **Bar tooltip:** “Declared 32 cores · offered 4 · this board's cards hold 24”.
- **Offline workers** show their last reported headroom, quota and account at reduced opacity, labelled “as of 17:52”.
- **Needs update** (2.3) hides headroom and quota and explains the minimum version, with a copyable update command. Its project sub-rows stay.
- **Signed out:** the provider's line turns violet, “Signed out · run `claude login` on build-02”.

### 3.3 Project readiness sub-rows
These are nested under each worker row and separated by dashed dividers. Each has project | state | detail | actions.

| State | Colour | Detail | Actions |
|---|---|---|---|
| Ready | Grey tick | “Readiness script passed · 07:40” | Re-check |
| Checking | Blue | “Checking…” until the script exits | none |
| Cloning | Blue + 5-step bar | “Cloning · 62%” · started time · size | Cancel |
| Not ready | Amber | “Readiness script `.t3/ready.sh` exited 1 · time”, then the script's output tail (log block) | Re-check, Set up on worker |
| Not set up | Grey hollow circle | Disk needed (“Needs about 12 GB”) | Set up on worker |

- While a worker is offline, its actions are disabled with the tooltip “Available when {worker} reconnects”.
- Clicking a failed row expands its full output.

### 3.4 “Set up this project on the board server” prompt
- An amber callout inside This server's row, shown whenever a project isn't set up there. It's ordered above any worker problem.
- Text explains that planning runs here, how many cards are waiting (by key), and the approximate size needed.
- Primary action: **Set up {project} here**. The row then shows blue Cloning or Checking until it's Ready.

### 3.5 Add worker dialog (1.1 to 1.4)
This is one dialog that moves through these states:

1. **Code created (waiting).**
   - The join code is large and mono: `K7Q-4MZ`.
   - Expiry: “Expires at 22:58 · in 10 min · works once”.
   - A command field with Copy: `npx t3 worker join https://board.example --code K7Q-4MZ`. Copy flips to “Copied” for 2 seconds.
   - An info box: the worker needs only outbound HTTPS to the board address (no inbound ports or VPN).
   - A blue waiting box: “Waiting for a worker to join”. Closing the dialog doesn't cancel the code.
   - Footer: Cancel code (destructive link), Close.
2. **Checking in.** “Code K7Q-4MZ was used by build-03 from {ip}”, then a step list that ticks as each step is reported: code accepted, connected (version), reading capacity and providers, checking project checkouts.
3. **Joined.**
   - “build-03 joined” with a grey tick.
   - A summary: capacity, providers with signed-in account and plan, projects (“None set up yet”).
   - An editable Label (defaults to the hostname) and an editable **Abbreviation** beside it, plus a hint pointing to `t3 worker config`.
   - The abbreviation is suggested from the label: a trailing number becomes first letter + number (`build-03` → `B03`); otherwise the first three letters (`mac-mini` → `MAC`). Input is forced to uppercase, 1–3 letters or digits, unique on the board. A duplicate shows inline (“B03 is already used by build-03”) and disables Done.
   - Footer: Done, Set up projects… (opens a checklist of projects with disk needs).
4. **Errors**, which replace the waiting box:
   - Code expired, with Create new code.
   - The worker's version is too old; the code stays valid.
   - Code already used, linking to that worker's row.

The command's board address comes from the server's public URL setting. If none is set, show this browser's URL with the hint “Make sure workers can reach this address”.

### 3.6 Rename worker (2.4)
- Opened from the row menu's Rename…. Label and Abbreviation fields side by side, the same validation as at join, and a chip preview.
- This server can be renamed but keeps `SRV`.
- Saving updates every chip, thread row and filter at once. Saved filter URLs keep working.

### 3.7 Remove worker confirm (2.2)
- Title: “Remove {worker}?”, plus the number of cards on it.
- The affected cards are listed in groups, each row with key, title and status:
  - **Re-placed when their next step starts:** pushed, nothing running.
  - **Stopped, then re-placed:** a step is running. This group has an amber border and shows unpushed commits, plus a line explaining that a push is attempted first.
- Info box: nothing on the worker is deleted, and transcripts stay readable. To use it again, add it with a new join code.
- Footer: Cancel, then **Remove {worker}** (destructive).
- With no cards: “No cards are on {worker}.” Offline workers can be removed; their unpushed work is listed as “may be lost”.

## 4. Board header: Worker filter (3.1)

- A **Worker** button in the board header, next to Filter tasks.
  - Unset: grey label “Worker”.
  - Set: ink label with a ×, naming up to two selections by abbreviation (“Worker: B01, Not placed yet”), then “B01 + 2”.
- Popover “Show cards on”:
  - A checkbox row per worker: full name with abbreviation badge, a status sub-line (amber when offline or needing an update), card count.
  - A divider, then a **Not placed yet** row.
  - Footer: the note “Planning always runs on This server” and Clear.
- Multi-select: a card shows if it matches any selected worker. Counts respect other active filters.
- When applied, a strip under the header: “Showing 8 of 16 cards · Worker is build-01 or Not placed yet · Clear filter”.
- Shortcuts: click a card's worker chip to filter to that worker; shift-click adds it. Unplaced cards have no chip, so “Not placed yet” is reached from the menu only.
- The filter is remembered per user per board and mirrored in the URL (`?worker=build-01,unplaced`).
- If a card is placed on an unselected worker while you're viewing, it stays visible at 50% opacity with “Placed on {worker}” until the filter next changes.
- Existing header indicator: “1 worker offline” (amber) and “2 workers need attention” when mixed.

## 5. Card face (4.1, copy in 4.2)

The anatomy adds three things to the existing card:
- **Top-right slot**, for short states only: “Preparing · 3/5” (blue tag), “Input needed” (violet), “Done” (green), and amber “Setup failed · 3/5”.
- **Preparing bar:** a 5-segment stepped bar under the title while the worktree is being set up.
- **Reason line**, a new row under the title. It's a clickable button that opens the waiting popover (section 7).
  - Blue with a clock icon when queued.
  - Amber with a warning icon when blocked.
  - Wraps to 2 lines, then truncates, with the full text in a tooltip.
- **Worker chip** at the right end of the meta row:
  - Server icon: placed. Shows the abbreviation (`B01`, `SRV`); the tooltip gives the full name.
  - Pin icon: pinned.
  - No chip at all while the card isn't placed yet. “Not placed yet” appears only in the card detail Worker row and the board filter.
  - Max width about 124px, truncated, with the full name in a tooltip.

Reason lines:

| Line | Colour |
|---|---|
| Waiting for CPU on {worker} (or RAM) | Blue |
| Waiting for a worker with {n} GB free disk | Blue |
| Provider near quota | Blue |
| Worker busy | Blue |
| No ready worker for this project | Amber |
| Too big for any worker | Amber |
| Set up this project on the board server | Amber |

- If several apply, blocked beats queued. Among queued reasons, show the one that rules out the most workers.
- The full tooltip and “clears when” wording for each line is in artboard 4.2.

## 6. Card detail (5.1 to 5.5)

### 6.1 Summary pane (right column)
- **Status box:** for example blue “Preparing worktree on build-01”, with the current stage.
- **Worker row:**
  - Placed: worker name in mono, “· placed at 18:31”, then a short reason (“Chosen because it offered the most RAM among ready workers”).
  - Unplaced: “Not placed yet — chosen when the build starts”.
- **Pin row:** a **Pin builds to…** dropdown with a hint (“Not pinned. If this card is ever re-placed, the planner chooses again.”). When pinned it reads “Pinned to {worker}”.
  - **Pin menu (5.3):**
    - “Any ready worker” (default, ticked).
    - Under a “Pin to” header, one row per worker with a sub-line, e.g. “Ready · offers 4 of 32 cores · would wait for CPU”.
    - Workers that aren't ready are disabled with their reason; This server has a Set up button.
    - Unpin at the top when pinned.
- **Resource profile panel:**
  - The project baseline (“12 cores · 40 GiB · 45 GB”), a source note (learned or declared per dimension) and an “Edit in project” link.
  - Three rows (CPU, RAM, Disk), each with an S / M / L / XL segmented control and the resulting reservation on the right.
  - Once edited: “Edited by you · planner suggested M · M · M” with Reset to planner.
  - A value that no worker could fit turns amber immediately, with an amber note naming the largest worker.
  - The planner's reason sits in a dashed box.
- **Threads list:** each row shows the abbreviation of the worker it ran on (`SRV`, `B02`), with the full name in the tooltip. The Measured table's step column does the same.

### 6.2 Setup progress (main column)
- A panel header: “Setup progress”, worker, start time, elapsed time, and **Cancel setup**.
- Left: the stage list, e.g. Clone repo → Install toolchain → Seed nightly cache → Warm Gradle daemon → Readiness script.
  - Done stages: grey tick and duration.
  - Current stage: blue, still dot, and duration or percentage.
  - Pending stages: hollow circle.
- Right: a log tail of the last 6 lines with “Open full log”. It refreshes in place and doesn't auto-scroll.
- **Error state (5.2):**
  - The failed stage is amber with its exit code; later stages read “skipped”.
  - An amber explanation box.
  - Actions: **Retry from stage N** (primary) and Cancel.
  - Links: Open full log, Skip and continue (only for stages marked optional), Pick another worker….
- After success it collapses to one line, “Setup · build-01 · 6m 12s ✓”, which can be expanded.

### 6.3 Measured, beside Usage (main column, two panels side by side)
- **Measured**: a table with one row per step. Step (with worker) | CPU core·s | p90 | Peak RAM | I/O r / w | Disk | Data.
  - Data states:
    - complete (grey);
    - Partial (grey tag; totals marked ≥; tooltip explains the gap);
    - Not measured (grey tag; tooltip gives the reason);
    - so far (blue, running row tinted);
    - not started (dashes).
  - Footer: the card's reservation, and its peak as a share of the hold.
- **Usage** is the existing tokens and cost section, row-aligned with Measured. Hovering a row in one highlights the matching row in the other.

### 6.4 Thread opened in place (5.5)
- Threads open inside the card modal through the board. There's no separate connection step.
- The header carries a worker chip: “Running on build-01” (live) or “Ran on build-01” (finished). Command blocks have a footer “ran on build-01 · {path}”.
- If the worker is offline:
  - the chip turns amber, “build-01 offline · transcript up to 18:05”;
  - the composer is replaced by “Messages resume when build-01 reconnects”.

### 6.5 Narrow (390 px) (5.4)
- Single column: header bar, title, status box with “Why is this card waiting? ›”, then a summary card (Worker, Pin, Branch).
- Resource profile with full-width 4-way segments (30px targets).
- A setup placeholder until the card is placed.
- Measured and Usage merge into one card per step (cost on the right, resources underneath).
- Thread rows open full-screen.
- The waiting popover opens as a bottom sheet.

## 7. “Why is this card waiting?” popover (6.1 to 6.3, live in 3.1)

- Opens from the card's reason line, from the card detail status box, or as a bottom sheet on narrow screens. On the board it docks beside the columns. Esc or × closes it.
- Header: “Why is {key} waiting?” (or “Why can't {key} start?” when blocked), plus the step and its needs: “Build step · needs 12 cores · 40 GiB · 45 GB (M · M · M)”.
- One row per worker: name (mono), a verdict, the detail, an optional “Also: …” line and an optional action button.
  - Verdict colours:
    - blue: clears by itself (Not enough disk, Busy, Provider near quota);
    - amber: needs a change (Offline, Not ready for {project}, Too big);
    - grey: wasn't a candidate (Pinned elsewhere, Not used for planning).
  - Rows are ordered by how close each worker is to fitting. For a pinned card, the pinned worker comes first.
- Footer: when it was last checked, what will unblock it, an optional size or model suggestion that would place it now, and action buttons (Edit size, Pin builds to…, Change model, Move…, Unpin, Set up {project} here).
- Updates in place when worker reports change, keeping its scroll position.

## 8. Settings → Projects → {project} → Resources (7.1)

- A new **Resources** tab next to General, Pipeline and CI.
- **Baseline** table: Dimension | Declared (editable number with unit) | Learned (value plus source, e.g. “p90 11.6, rounded up · 23 builds, last 30 days”) | Planner uses (“12 · learned”, “45 · declared”) | Pin declared (switch).
  - While pinned, Learned is greyed and marked “ignored while pinned”.
  - Footer note: learned values need at least 5 builds, and changes don't affect cards already placed.
  - Hovering Learned shows a static sparkline.
- **Readiness script** panel:
  - Script path input (default `.t3/ready.sh`), a found/not-found status (“Found on main · 14 lines”), an Open in repo link, and a timeout input.
  - A read-only preview of the script from the default branch, labelled with branch and commit.
  - A results table, one row per machine (abbreviation + name): Last result (Ready / Not ready · exit code / Not run), Output (last line printed, full output on click), Took, and Re-check or Set up on worker.
  - Header action: **Run on all workers**.
  - The script is edited in the repo, not here. When it changes on the default branch, every machine's project row shows “Not checked with this version yet” until it's run again.
  - With no script: “No .t3/ready.sh in {project}”, a Copy a starter script link, and machines count as ready once setup finishes.

## 9. Components to build or extend

| Component | Used in |
|---|---|
| Worker row with nested readiness sub-rows | Workers page |
| Headroom bar triplet (CPU / RAM / Disk), read-only, with tooltip | Workers page |
| Quota bar with near-limit and signed-out states, plus account line | Workers page |
| Readiness state cell (Ready, Checking, Cloning, Not ready, Not set up) and the log-tail block | Workers page, setup progress |
| Add worker dialog (code, copy command, expiry, waiting, checking in, joined, errors) | Workers page |
| Remove worker confirm with grouped affected cards | Workers page |
| Board-server setup callout | Workers page |
| Worker filter button and multi-select popover, applied-filter strip | Board header |
| Card reason line (blue or amber, clickable) | Card face |
| Worker chip (placed, pinned; shows abbreviation; clickable; hidden until placed) | Card face |
| Abbreviation badge, plus abbreviation input with suggestion and uniqueness error | Workers page, Add worker, Rename |
| Rename worker dialog | Workers page |
| 5-segment stepped progress bar | Card face, readiness, setup |
| Summary pane Worker row and Pin builds to… menu | Card detail |
| S / M / L / XL segmented control per dimension, with reserved value and too-big state | Card detail |
| Setup progress panel (stages, log tail, error, Retry, Cancel, collapsed line) | Card detail |
| Measured table with Partial, Not measured and so-far states, row-linked to Usage | Card detail |
| Thread header worker chip (running, ran, offline) | Thread view |
| Waiting popover, docked panel and bottom sheet | Board, card detail, narrow |
| Baseline declared / learned table with Pin declared | Project resources |
| Readiness script panel (path, timeout, preview, per-machine results) | Project resources |

## 10. Open UI questions

- Should a Re-check or Set up on worker that's in progress also show on the board-header indicator?
- In the worker filter, should offline workers sort to the bottom or keep their list order?
- Where should a user discover `t3 worker config` options, beyond the hint? A help popover, or a docs link?
- Should a provider signed in with a personal account on a worker be called out in any way, or only shown?

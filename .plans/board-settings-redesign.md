# Board settings redesign

## Goal

Rebuild `/settings/board` (web) to match `.plans/prototype/T3 Settings.dc.html` and the mockup: an accordion pipeline list with drag-drop reorder, inline rename, system preamble/postamble display, and a simplified per-stage config — and carry the same look & feel through the page's other sections (Card keys & colour, Concurrency, Lifecycle). Alongside the UI, split system-owned prompt protocol out of the user-editable prompts so editing a prompt can no longer break the board.

## Scope

**In:**
- `apps/web` Board settings page redesign (all four sections).
- Contracts: envelope composition moved/shared, `plan` role, default prompt rewrites.
- Server: role-keyed forced postambles, planning role resolution, mode forcing.

**Out:**
- Mobile/desktop settings surfaces; board kanban UI; review-loop phase structure; concurrency/lifecycle behavior changes (restyle only); no new stage-ordering invariants beyond the existing spine rule.

## Key decisions (from the grill)

1. **Full envelope split** (user-confirmed). Move the pure prompt-envelope composition (`composeStepPrompt` in `apps/server/src/board/supervisor.ts`, `composePhasePrompt` in `reviewLoopExecutor.ts`, incl. `providerQuestionMechanism`) into `@t3tools/contracts` so server and web share one source of truth. Add **role-keyed forced postamble segments**:
   - `plan` role: "When the plan is agreed, record it with `board_propose_plans`." (the contract formerly living in the editable prompt).
   - All auto-executed steps: "Do not move the card between stages yourself." (generic guard; `board_move_card` is agent-reachable).
   Strip the now-forced sentences from the editable defaults:
   - Building default → "Implement the card's brief on its branch. Run the project's checks until they pass."
   - Planning default → interview text minus the final `board_propose_plans` paragraph.
   - Review phase defaults → slimmed to intent only (fresh-eyes reviewer / smallest-correct-fix triager / scoped adjudicator); the protocol block already forces payload mechanics.
   Migration: at settings load (or compose time), a stored prompt that exactly matches an old default is treated as the new default; otherwise stored text is used verbatim (harmless duplication accepted).

2. **`plan` role** (mechanism mine to choose). Widen `BoardStageRole` to `["plan", "build", "review", "done"]`. New boards seed Planning with `role: "plan"`. Existing boards resolve via a shared `effectiveBoardStageRole(stage)` helper (`role ?? (stageId === seeded planning id ? "plan" : null)`) used by UI, decider guards, executor registry and envelope — no event rewriting. Role uniqueness and the delete guard extend to `plan`, making Planning non-deletable. Rename stays allowed for every stage (already keyed by stage id).

3. **Mode dropped from UI; capability kept via a clearer toggle** (user-confirmed). Planning forced `plan` mode, Building forced `build`, Review forced `build` (already invariant-enforced) — no control shown on any of them. Roleless stages get one toggle, **"Agent can edit the card's worktree"**, writing `mode: "build" | "plan"` under the hood. Multiple build-mode stages remain supported (single shared worktree, one-writer invariant, slots).

4. **Planning forced human-in-the-loop** (user-confirmed). No pause toggle on Planning; `humanInLoop` forced true at resolution. Planning card shows only: Auto execute, Prompt (+system pre/post), Model.

5. **"Pause for a human when a plan exists" removed** (user-directed). Schema field stays (decode compat) but UI is gone and resolution forces it false. Building keeps: "Pause for a human when no plan exists", Auto advance, Timeout, Attempts.

6. **Model control: ProviderModelPicker + explicit "Default" entry** (user-confirmed). No "Use a specific model" toggle. Compact trigger styled per mockup; first entry "Default (follows global model)" ⇒ stores `model: null`; trigger shows the resolved global default when null.

## UI spec (pipeline accordion)

One bordered card container listing all stages in board order; single-expanded accordion (click header toggles; opening one closes others).

Header row per stage: drag handle (grip) · order-number badge · inline-rename input (borderless until hover/focus) · role key chip (`plan` / `build` / `review`, mono, muted; none for `done`/roleless) · spacer · collapsed-state chips (Auto (primary tint) / Manual (quiet); review adds "N rounds"; unattended adds "Nmin") · caret.

Expanded body (indented under the header, per prototype):
- Optional stage note (review keeps its "a loop, not a single step" note).
- **Auto execute** toggle; when off show hint "Cards rest here until a human moves them on." and no further rows.
- **Prompt row**: label + Edit button; read view clamps to ~3 lines with fade + "See more"/"See less"; word count; edit swaps to textarea (primary border) with "Done".
  - **Preamble** and **Postamble** collapsible rows (lock icon + "system" tag, mono muted text, left border) rendering the *real* composed envelope from contracts, with placeholders for interpolated values — e.g. `{{CARD-KEY}}`, `{{card title}}`, `{{stage}}`, `attempt {{n}} of {{max}}` — and the variant matching the stage's effective stance (Planning → HITL postamble; Building/unattended → unattended postamble incl. role segment; question-mechanism wording resolved from the stage's selected provider instance, neutral when default).
- **Model** row (compact picker per decision 6).
- Roleless stages: worktree-access toggle, "Pause for a human", and (when unattended) Auto advance + Timeout (min stepper) + Attempts (stepper).
- Building: as decision 5. Review: Rounds stepper + one block per compiled-in phase (numbered section header; Prompt row with its own pre/post from `composePhasePrompt`'s protocol; Model row). Per-phase timeout/attempts stay schema-only.
- **Remove stage** (destructive ghost) shown only for deletable stages (roleless).

Footer: **Add stage** row inserts before Done (order key between last non-done and Done), opens it expanded.

**Drag-drop**: @dnd-kit vertical sortable on the handle; persists via existing `reorderStage` (`pinOrderKeyBetween`). Client mirrors the spine invariant (build before review, done last — and the decider's build-boundary refusal) by constraining drops; a server refusal snaps back with the decider's message.

## Other sections (restyle only)

- **Card keys and colour**: prototype style — one bordered row per project: accent dot · project name · prefix input (mono, uppercase) · colour select. Keep existing copy/behavior.
- **Concurrency** and **Lifecycle**: same card/list aesthetic (bordered containers, prototype control styling — steppers for numbers where natural), behavior unchanged.
- Keep `SettingsPageContainer`/section anchors/search integration; the prototype's sidebar/header chrome is not rebuilt.

## Acceptance criteria

1. Planning cannot be deleted; Building/Review/Done remain non-deletable; any stage (incl. role holders) renames inline without losing its config or role behavior.
2. No Mode select anywhere; Planning runs plan-mode/HITL and Building build-mode regardless of stored settings; a roleless stage's worktree toggle round-trips `mode`.
3. "Pause for a human when a plan exists" gone from UI; building runs unattended when a plan exists.
4. Model pickers have a working "Default" (null) state and per-stage/per-phase overrides; no enable toggle.
5. Editing any editable prompt cannot remove the completion/question/propose-plans/move-card contract — verified by composing envelopes for edited prompts in tests.
6. Preamble/postamble shown in settings match what the server actually composes (same shared function), with placeholder values.
7. Drag-drop reorder persists and respects the spine invariant; invalid drops are prevented or gracefully refused.
8. Old-default stored prompts are upgraded exact-match to new defaults; edited prompts untouched.
9. Existing tests updated; new contracts-level tests for envelope split, `effectiveBoardStageRole`, and default migration.

---
id: t3o-21
title: Pipeline access & reasoning controls — stop forcing full-access on board agents
phase: 3
prerequisites: [t3o-15, t3o-16]
---

# Pipeline access & reasoning controls

The board decides an agent's filesystem and command authority **for** the user, in code, with no
way to see or change it:

```ts
// supervisorReactor.ts:504
const runtimeMode = step.mode === "build" ? "full-access" : "approval-required";
```

Every build-mode stage — Building, Code review, and any custom stage with worktree access — is
therefore spawned at `full-access`, which each adapter maps to a fully unrestricted posture:

- **Claude** → `permissionMode: "bypassPermissions"`, and the permission callback returns
  `behavior: "allow"` unconditionally before any other check (`ClaudeAdapter.ts:3941-4084`).
- **Codex** → `approvalPolicy: "never"` + `sandbox: "danger-full-access"`
  (`CodexSessionRuntime.ts:290-334`).

No allow/deny list narrows it — nothing in the board path constrains which commands a turn may
run. So a board agent reading a hostile diff has unrestricted shell on the user's machine, and the
user never chose that and cannot see it. **That is a security defect, not an unattended-mode
trade-off.** Running unattended is a reason to need a *policy*, not a reason to assume the most
dangerous one.

Reasoning effort has the same shape of problem, less severely: `BoardModelSelection` is
`{ instanceId, model }` (`board.ts:489`) with no options field, so a pipeline stage cannot say
"run the reviewer at high effort, the triager at low" even though that per-phase economics is the
entire point of the review loop's split models (t3o-16).

## Goal

Wherever the pipeline lets the user pick a **model**, it also lets them pick the **reasoning
level** and the **access level** — rendered as one control row, mirroring the chat composer:

```
[✳ Claude Opus 5 ▾] │ [High · 1M ▾] │ [🔒 Full access ▾]
```

The user owns the authority decision. The board honours it. No stage forces an access level.

## Scope

**In**

1. `runtimeMode` and model **options** (reasoning/effort) as configurable fields on every pipeline
   config that carries a model — the simple stage member, the review stage member, and each of the
   three review phases.
2. A settings control row that reuses the composer's components (D3).
3. The reactor reading the configured access level instead of deriving it from `mode`.
4. Sane defaults, including **`auto` for build mode** (D2) — not `full-access`.
5. Migration of existing configs (absent field → the new default, not the old forced value).

**Out**

- Changing what each `RuntimeMode` *means* at the adapter level. The four modes and their
  adapter mappings are existing behaviour; this plan only stops hardcoding which one is used.
- Per-command allow/deny lists for board agents. A finer-grained policy than `RuntimeMode` is a
  separate concern.
- The `plan`-mode posture. Planning stays `approval-required` by default (it runs in the SHARED
  project root — see D2).

## Design decisions

### D1 — Where the fields live

`RuntimeMode` is already a contract literal (`orchestration.ts:135`) with four values. Add to each
config that carries a model:

- `runtimeMode: RuntimeMode` — decoding-defaulted per D2.
- Reasoning/effort: carried as model **options**. `BoardModelSelection` (`board.ts:489`) gains an
  optional `options` field mirroring the app's `ModelSelection` options shape, so
  `createModelSelection(instanceId, model, options)` round-trips. This keeps effort attached to
  the model it belongs to (effort vocabulary is per-model — see D3).

Applied to: `BoardStageExecutionSimple`, `BoardStageExecutionReview`, and
`BoardReviewPhaseExecution` (each phase already has its own `model`, so each gets its own effort
and access level too — a cheap triager at low effort next to a thorough reviewer at high is the
point).

All additive and `withDecodingDefault`, so existing sparse `settings.json` decodes unchanged.

### D2 — Defaults

| Stage / mode | Default access | Why |
|---|---|---|
| `build` mode (Building, custom worktree stages) | **`auto`** | The user's call. Writes in its own isolated worktree without prompting for every edit, without handing over unrestricted shell. |
| Code review phases | **`auto`** | Same posture as build; the review loop runs in the card's worktree. See the caveat below. |
| `plan` mode (Planning) | `approval-required` | Unchanged. Planning runs in the **shared project root** with no worktree, so the least-privileged posture is what keeps a planning agent from dirtying the real checkout — this is an existing invariant worth preserving. |

`resolveBoardStageExecution` (`board.ts:3728`) is the single resolution point; it currently FORCES
`mode`/`humanInLoop` invariants. It gains the access-level default in the same place, so the
reactor keeps reading one resolved value.

> **Pending approvals are a supported state, not a failure.** Below `full-access` a tool call that
> needs approval opens a real approval request (`ClaudeAdapter.ts:3948+`), and the board already
> models exactly this: `deriveBoardCardThreadState` (`board.ts:2438-2441`) maps a thread with
> `hasPendingApprovals` / `hasPendingUserInput` to the `waiting` state, which the card renders as
> the blue **"Input needed"** treatment — deliberately distinct from the loud `stalled` badge
> (`BoardCardItem.test.tsx:100-114`). The human approves, the agent continues.
>
> So the settings UI **must not block** a low access level, and needs no special stall handling.
> If a stage wants a permission it doesn't have, it interrupts and asks — that is the design.
> At most, flag it: a purely informational note that an unattended stage at `approval-required`
> will pause for approvals. Never a blocker, never a validation error.
>
> The same reasoning disposes of the sandbox question: if `auto` denies something an agent needs
> (network for `gh`, a command outside the workspace), the agent asks and the card says "Input
> needed". No pre-flight capability matrix required.

### D3 — Reuse the composer's controls; one row

The chat composer already solves every hard part of this, and settings already reuse it — the
Text-generation row in `SettingsPanels.tsx:2149-2204` renders `ProviderModelPicker` beside
`TraitsPicker` with `triggerVariant="outline"` and a controlled `onModelOptionsChange`. That is
the exact pattern to copy.

- **Model** — the board's existing `ModelRow` picker (`BoardPipelineSection.tsx:527`), unchanged.
- **Reasoning** — `TraitsPicker` (`chat/TraitsPicker.tsx`). It derives its options from the
  selected model's capability descriptors, so the menu differs per model automatically (exactly
  the behaviour asked for). It has a thread-free controlled mode:
  `{ onModelOptionsChange: (nextOptions) => void }` — no thread, no draft store. Pass
  `allowPromptInjectedEffort={false}` as the settings usage does (there is no prompt to inject an
  `Ultrathink:` prefix into).
- **Access** — the composer's existing picker, **already built and exactly the mockup**:
  `ComposerFooterModeControls` in `ChatComposer.tsx:297-386`, driven by the `runtimeModeConfig`
  map at `ChatComposer.tsx:230-254`. It renders a `ComposerSelectControl` with the mode's icon +
  label, and a `SelectPopup` where each option shows an icon, a label and a one-line description:

  | value | label | icon | description |
  |---|---|---|---|
  | `approval-required` | Supervised | `LockIcon` | Ask before commands and file changes. |
  | `auto-accept-edits` | Auto-accept edits | `PenLineIcon` | Auto-approve edits, ask before other actions. |
  | `auto` | Auto | `SparklesIcon` | Supported providers approve routine actions; others still ask. |
  | `full-access` | Full access | `LockOpenIcon` | Allow commands and edits without prompts. |

  **Extract, don't rebuild.** `runtimeModeConfig` and the select are currently private to
  `ChatComposer.tsx`. Lift them into a shared `chat/AccessLevelPicker.tsx` exporting both the
  config map and a standalone picker; `ComposerFooterModeControls` then renders it, and the board
  settings row renders the same component. One source of truth for the vocabulary, the icons and
  the descriptions — and the settings row inherits the composer's look for free.

  (`CompactComposerControlsMenu.tsx` holds a second, plainer copy of the same four labels and is
  currently unreferenced — fold it into the extracted module or delete it.)

Layout: replace the board's current single-control `ModelRow` with a row rendering the three
controls inline, separated as in the mockup. The row appears **everywhere a model is set** — the
simple-stage body and each of the three review phases.

Warn inline when the selected access level cannot work unattended (D2 caveat): a stage with
`autoExecute` on and `approval-required` selected should say it will stall waiting for approval.

### D4 — Reactor reads the config

`spawnStepThread` (`supervisorReactor.ts:504`) stops deriving `runtimeMode` from `step.mode` and
instead takes it from the frozen run-row fields, like `model` and `mode` already are (D12's
freeze-at-entry rule). `BoardCardStepState` gains `runtimeMode` so a running card keeps the
posture it entered with, and a settings edit mid-flight cannot change a live agent's authority.

`interactionMode` stays `"default"` — orthogonal axis, unchanged.

## Layer-by-layer change list

| Layer | File | Change |
|---|---|---|
| Contracts | `packages/contracts/src/board.ts` | `options` on `BoardModelSelection`; `runtimeMode` on `BoardStageExecutionSimple`, `BoardStageExecutionReview`, `BoardReviewPhaseExecution`; `runtimeMode` on `BoardCardStepState`; defaults per D2 applied in `resolveBoardStageExecution`. |
| Web (extract) | `apps/web/src/components/chat/AccessLevelPicker.tsx` | Lift `runtimeModeConfig` + the access select out of `ChatComposer.tsx:230-386` into a shared component; `ComposerFooterModeControls` consumes it. Retire the duplicate labels in `CompactComposerControlsMenu.tsx`. |
| Web | `apps/web/src/components/settings/BoardPipelineSection.tsx` | `ModelRow` → a three-control row (model · reasoning · access) used by `SimpleStageBody` and each review phase; unattended-stall warning. |
| Web | `apps/web/src/components/settings/BoardSettingsPanel.logic.ts` | `setBoardStageExecution` already field-merges a `Partial`; confirm the new fields thread through. |
| Server | `apps/server/src/board/supervisorReactor.ts` | Read `runtimeMode` from the run row instead of deriving from `mode` (D4). |
| Server | `apps/server/src/board/reviewLoopExecutor.ts` | Carry each phase's `runtimeMode` + model options onto the plan, as it already carries `model`/`timeoutMs`. |
| Tests | board contracts + reactor tests | Default-resolution tests; a test asserting no code path forces `full-access`. |

## Open questions

- ~~**Q1:** Does `auto` on Codex block network, and therefore `gh`?~~ **Closed — not a blocker.**
  If a permission is missing the agent interrupts and asks, surfacing as "Input needed" (D2). No
  capability pre-flight, and t3o-20's agent-side posting is unaffected.
- **Q2:** Should the effort/options field reuse the app's `ModelSelection` options schema directly
  rather than a board-local mirror? Prefer direct reuse if the shape allows.
- **Q3:** Existing users are silently on `full-access` today. On upgrade, do build stages move to
  `auto` (safer, may change behaviour of a working pipeline) or stay `full-access` with a
  one-time notice? Recommendation: default to `auto` and surface it in the pipeline UI — the
  security posture should fail safe.

## Acceptance

1. No code path derives or forces `runtimeMode`; every board spawn reads a user-visible setting.
2. Every place the pipeline sets a model also sets reasoning level and access level, on one row,
   using the composer's components.
3. The reasoning menu's options change with the selected model.
4. Build-mode stages default to `auto`; Planning stays `approval-required`.
5. A running card keeps the access level it entered the stage with.
6. A low access level is never blocked or validated against — at most an informational note. A
   stage that needs a permission interrupts and surfaces as "Input needed".

---
id: t3o-07
title: Settings — Board tab and the pipeline recipe model
phase: 1
prerequisites: [t3o-03]
---

# Settings → Board

A native settings tab, and the typed recipe that D10 promised would be data rather than code.

## Locked decisions

- **D10** — stages fixed, steps configurable; recipe lives in `ServerSettings.board`; defaults are
  compiled in so zero configuration works; **the resolved recipe is snapshotted onto the card on
  stage entry.**

## Seam inventory

Six one-line appends plus new files.

**Server** (`packages/contracts/src/settings.ts`):

1. `ServerSettings` — `board: BoardSettings.pipe(Schema.withDecodingDefault(…))`.
2. `ServerSettingsPatch` — `board: Schema.optionalKey(BoardSettingsPatch)`.

`DEFAULT_SERVER_SETTINGS` and `UnifiedSettings` derive automatically. `BoardSettings` itself lives in
`packages/contracts/src/board.ts`.

**Web:**

3. `SettingsPath` union (`settingsSearch.ts`).
4. `SETTINGS_SECTION_LABELS`.
5. `SETTINGS_SECTION_ICONS` (`SettingsSidebarNav.tsx`).
6. `SETTINGS_NAV_ITEMS`.

Plus a new `apps/web/src/routes/settings.board.tsx` and searchable-setting index entries.

## Settings content

**Projects** — per-project card key prefix and accent colour, keyed by `ProjectId`. The prefix
cannot be derived from the project name and must be explicit.

**Pipeline recipe** — per stage, an ordered list of steps:

```
BoardStep
  id
  label
  promptTemplate        (or a reference to a user skill, wrapped by the envelope — post-MVP)
  providerInstanceId
  model
  timeoutMs
  maxAttempts
```

Follow the `providerInstances` precedent in `ServerSettings`: patch the recipe as a **whole-map
replacement**, not per-step patches. The comment on that field spells out why — partial patches
leave config half-merged.

For the MVP only the Building stage's recipe is executed (`t3o-12`); the rest are stored and
displayed, and become live as later stages automate.

**Concurrency** — per-`providerInstanceId` `maxConcurrent`, plus a global ceiling (`t3o-11`).

**Lifecycle** — archive window (default 7 days in Done), worktree retention policy (`t3o-09`).

## Recipe snapshotting

On stage entry the resolved recipe is copied onto the card (`recipeSnapshot`, `t3o-03`). Editing
settings affects the **next** stage entry, never a stage already in flight. Without this, editing
which model reviews while round 2 is running leaves the reactor executing a pipeline that no longer
exists.

Surface this in the UI: a card whose snapshot differs from current settings shows that it is running
an older recipe. Otherwise the settings screen lies about what is actually happening.

## Out of scope

- Custom-skill wrapping (post-MVP; the envelope mechanism in `t3o-10` is what will serve it).
- Per-repo recipe overrides. If they are wanted later, a checked-in `t3board.json` following the
  `t3.json` precedent is the natural home — deliberately not built now.

## Verification

- Settings round-trip through `server.updateSettings` and survive restart.
- A settings edit mid-stage does not alter a running card's behaviour, and the divergence is visible.
- Defaults produce a working pipeline with an empty settings file.

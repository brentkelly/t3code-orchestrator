---
id: t3o-32
title: Brief attachments — paste screenshots or attach files to a card, pulled by its threads
phase: 3
prerequisites: [t3o-26, t3o-31]
---

# Brief attachments

A card's brief can carry screenshots and files. They live in board-owned storage, every thread
linked to the card can discover and read them, and the two threads that act on the brief
(build, planning) see the images natively on their first turn. Nothing else is pushed.

## Goal

Creating a card or editing its brief accepts pasted screenshots and attached files. The files
are durable, owned by t3o, listed on the card, and reachable by any linked thread by path.

## Scope

### In

- Card-scoped attachment storage under T3 home, one copy, board-owned.
- Upload via upstream's file-upload pipeline (t3o-31); board claims the pending upload.
- Two entry points: `BoardCardCreateDialog` and the detail view's brief editor. Paste (⌘V),
  drag/drop, and a paperclip "Attach files" button on both.
- Attachment list on the card: images as thumbnails above the brief text, other files as
  chips (icon, name, size, ×) below it, matching the reference screenshots.
- Column-card `attachmentCount` wired for real (it is a stale "always 0" placeholder today).
- `board_get_card_context` returns an attachment manifest (pull).
- Images ride natively on the first turn of build-mode and plan-mode spawns (the one push).
- Remove an attachment; card delete removes its folder.
- Preview and download from the UI through a signed asset URL.

### Out

- Mobile (D17; the board has no mobile UI).
- Any worktree mirror or copy of attachments into a repo (see K1).
- Attachments on review, sync, recovery-respawn or human follow-up turns (they pull).
- Agents adding attachments over MCP.
- Sub-board children inheriting a parent's attachments (follow-up).
- Inline `![]()` references inside the brief markdown; `boardBriefHasImage` stays as is.

## Key decisions

**K1 — Board-owned storage, single copy.** Files live at
`<stateDir>/board/attachments/<cardId>/<fileName>`, beside `boards.sqlite`. Never in a
worktree: worktrees are reclaimed at Done and a deleted/recloned project would orphan every
reference. One copy means one truth; the manifest hands threads the absolute path.
Rejected: git-ignored mirror in the card worktree (dual copy, breaks on reclaim/reclone);
upstream's flat `attachmentsDir` with card-scoped ids (opaque uuid filenames, mingles with
chat-turn files, no per-card lifecycle).

**K2 — Reuse upstream's upload half, own the claim.** The client mints a signed upload URL
(`attachments.createUploadUrl`, thread-agnostic `pending-<uuid>[-<ext>]`) and POSTs the bytes
exactly as the chat composer does. A board command then claims it: copy `pending-…` into the
card folder under the original (sanitised, de-duplicated) filename and record it on the card.
The pending file is left for upstream's 24h sweep, as `Normalizer` does. Rejected: a second
upload route.

**K3 — Pull, not push (D3, D5).** The spawn envelope already says "call
`board_get_card_context` for the brief"; the brief itself is never inlined. The manifest rides
that same tool: `attachments: [{ name, type, mimeType, sizeBytes, path }]` with the absolute
path, so any linked thread — build, planning, every review round — can `cat`/read it with
bash. Attachments added after a thread spawned appear on its next call with no extra work.

**K4 — One deliberate push: images on the first turn of build and planning spawns.** A card
that is "a screenshot plus 'fix this'" needs the model to *see* the image on turn one, and
most providers cannot pull an image into vision. So `spawnStepThread` for a build-mode or
plan-mode step passes the card's image attachments (first 8, upstream's per-turn cap) on
`thread.turn.start`. Mechanism: stage a fresh `pending-` copy of each image and pass it as an
ordinary `ChatAttachment`, so upstream's `Normalizer` claims it into thread scope untouched —
the thread gets its own copy as if a human had pasted it; the board copy stays the truth. No
`Normalizer` change. Review, sync and recovery spawns get nothing pushed (K3 covers them).
Rejected: pushing to every spawn (repeats bytes per review round); pushing files too (only
OpenCode ingests them natively; the rest would get a path line they already have from K3).

**K5 — Event-sourced list on the aggregate (D2, D8, D9).** New events
`board.card.attachment-added` `{ cardId, attachment: { id, name, type, mimeType, sizeBytes,
addedAt } }` and `board.card.attachment-removed` `{ cardId, attachmentId }`; the aggregate gains
`attachments: BoardCardAttachment[]`. The decider needs the list to reject a duplicate name and
an unknown remove. Projected to `board_card_attachments` (migration `032`, board ledger). The
shell carries `attachmentCount`; the detail carries the list. The attachment `id` is the
claimed pending id's uuid, so the on-disk name and the record stay decoupled from renames.

**K6 — Create dialog is two-phase.** A card has no id, hence no folder, until
`board.card.create` returns. The dialog stages uploads as pending files while the user types,
then dispatches one `board.card.attach` per file after create. If create succeeds and a claim
fails, the card exists without that file and the dialog shows the failed chip with a retry;
pending files are swept by upstream. Brief editor is single-phase: attach as soon as the upload
lands, independent of the brief text save.

**K7 — Limits inherit upstream.** Images ≤ 10 MiB, files ≤ 50 MiB, environment capability
`attachmentUploads` / `fileAttachments.maxUploadBytes` gates the controls exactly as the
composer does. Per-card cap 20 so the manifest stays readable.

**K8 — Serving.** One new `AssetResource` member, `board-attachment { cardId, fileName }`, with
a `T3o:` marker; `issueAssetUrl` / `resolveAsset` resolve it under the card folder with the
same traversal guard, download disposition and mime vetting upstream applies to `attachment`.

**K9 — UI contract is the updated prototype (`.plans/prototype/t3o.dc.html`).** The reference
markup is the create dialog brief block (~L1525–1556) and the card modal brief block
(~L1005–1050, mirrored for the second layout at ~L1226–1260); the handlers are
`onBriefPaste` / `onDraftDrop` / `onCardBriefPaste` / `onCardDrop` (~L4449–4665) and
`ingestFiles` / `fileThumbs` / `fileChips` / `dropZoneStyle` (~L4815–4925). Ignore the older
`insertPastedImage`: pasting an image never inserts it inline, it becomes an attachment.
Where the real app must deviate: the prototype holds images as data URLs; here staged files
show a `blob:` preview while uploading and persisted ones load through the K8 signed URL.
Thumbnails set the image on the element, not via a style string, as the prototype does.

## Implementation map

Server (`apps/server/src/board/`, new files where possible):

- `attachments.ts` — folder path, filename sanitise + de-dupe, claim (copy pending → card
  folder), delete, manifest builder, stage-pending-copy for K4.
- `decider.ts` / `projection.ts` — the two events, aggregate field, `board_card_attachments`
  upsert/delete, shell `attachmentCount`, detail `attachments`.
- `migrations/032_BoardCardAttachments.ts`, appended to `BOARD_MIGRATIONS`.
- `rpc.ts` — `board.card.attach { cardId, pendingAttachmentId, name, mimeType, sizeBytes,
  type }` and `board.card.detach { cardId, attachmentId }`.
- `supervisorReactor.ts` `spawnStepThread` — replace the hardcoded `attachments: []` at the
  build/plan admit sites with the K4 staged images; `sendTurn` stays `[]`.
- `mcp/toolkits/board/handlers.ts` — `board_get_card_context` gains `attachments`.
- `assets/AssetAccess.ts`, `packages/contracts/src/assets.ts` — K8 seam, marked.
- Card delete path removes the folder.

Contracts (`packages/contracts/src/board.ts`): `BoardCardAttachment`, the two events and
commands, `BoardCard.attachments`, `BoardCardDetail.attachments`, shell `attachmentCount`
comment fixed.

Web (`apps/web/src/board/`):

- `BoardBriefAttachments.tsx` — one component used by both entry points. Upload through the
  platform-neutral `runAttachmentUploadCycle` in `packages/client-runtime` with the web
  `uploadBytes` transport; do not couple to the composer draft store. Behaviour, per the
  UI brief and K9:
  - The brief field is a bordered container: a thumbnail strip on top, the text editor below.
  - Image thumbnails are 56×56, rounded, `background:center/cover`; in edit mode each has an
    18px ✕ badge at its top-right corner; view mode shows no badge.
  - Paste (⌘V) handles images only: `clipboardData.items` filtered to `image/*`, never
    inserted inline. Non-image files arrive by drop or the button.
  - "Attach files" sits directly under the brief: dashed outline, paperclip, 26px tall, no
    section label. Non-image files are chips beside it: file icon, ellipsised name, size in
    B / KB / MB in mono, ✕ to remove.
  - Drop targets are the brief editor and the attach row. While dragging over either, that
    target shows a dashed primary-colour border and a tinted background (`dropZoneStyle`).
  - Staged uploads show progress and a retry on failure; the capability/size gating and
    messages come from `composerAttachmentFiles.ts` and `attachments.ts` in client-runtime.
- `BoardCardCreateDialog.tsx` — K6 staging while the user types; attachments save with the
  task on Create. Placeholder: "What's the context? Paste screenshots (⌘V) or drop files in
  here." The Brief label stays as-is.
- `BoardCardDetailView.tsx` `BriefBody` — same behaviour in both layouts (brief pane and plain
  brief column) and both modes. Placeholder while editing: "Describe the task. Paste
  screenshots (⌘V) or drop files in here." Changes persist immediately; there is no separate
  save step and no Attachments section in the details column.
- `BoardCardItem` / summary row — real `attachmentCount` indicator.
- `packages/client-runtime/src/state/board.ts` — detail/shell state for the new fields.

Docs: `docs/user/` (attach files to a card; threads can read them), `docs/t3o/seams.md`
(K8 seam, the `spawnStepThread` attachments row), glossary entry "brief attachment".

## Acceptance criteria

1. Pasting a screenshot or dropping/picking a file in the create dialog or the brief editor
   uploads it, and the card shows it as a thumbnail (image) or chip (file) after reload.
2. The file exists at `<stateDir>/board/attachments/<cardId>/<fileName>`; nothing is written
   into any worktree or workspace root.
3. Two files with the same name attach as `name.ext` and `name-2.ext`; a traversal-shaped name
   is rejected.
4. `board_get_card_context` from a linked thread lists every attachment with an absolute path
   that `cat` can read; an attachment added after the thread spawned appears on the next call.
5. A build-mode or plan-mode spawn's first `thread.turn.start` carries the card's images (max
   8) as `ChatAttachment`s and the thread's message shows them; a review-round spawn carries
   none. Decider/reactor tests cover both.
6. Removing an attachment deletes the file, drops it from the manifest, and decrements
   `attachmentCount`; deleting the card removes the folder.
7. Preview/download works through a signed URL; a `.html` upload downloads as octet-stream.
8. Controls are disabled with the composer's message when the environment lacks
   `attachmentUploads`; an oversize file is refused client-side with the size message.
9. Migration `032` runs on the board ledger only; `t3o_sql_migrations` advances, upstream's
   ledger is untouched.
10. UI matches the K9 prototype: thumbnails above / chips below on both entry points and both
    modal layouts, ✕ badge only in edit mode, drag-over highlight on the brief and the attach
    row, sizes formatted B / KB / MB, no Attachments section in the details column.
11. Hit-every-surface: create dialog, brief editor, column card, MCP tool, `docs/user`.

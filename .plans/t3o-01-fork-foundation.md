---
id: t3o-01
title: Fork foundation — branch topology, upstream sync, seam conventions
phase: 0
prerequisites: []
---

# Fork foundation

Establish the repository shape T3o lives in for its whole life. No product code. Everything here
exists to make the next twelve months of upstream merges cheap.

## Locked decisions (from `t3o-00`, D16)

- `upstream` remote → `https://github.com/pingdotgg/t3code.git`.
- `main` is a **fast-forward-only mirror** of `upstream/main`. Never committed to directly.
- `t3o` is the trunk and the **repo default branch**.
- Weekly `main → t3o` **merge** (not rebase) via PR.
- Seam marker is exactly **`T3o:`** — lowercase `o`.
- Workspace package names are **not** renamed.
- Migrations are numbered from **`900_`**.
- Inherited irrelevant workflows are disabled from the Actions UI, not by editing YAML.

## Scope

### Git topology

1. Add the `upstream` remote.
2. Create `t3o` from current `main`. *(done)*
3. Set `t3o` as the GitHub default branch. *(manual — the repo PAT lacks `administration` scope)*
4. Optional: branch protection on `main`, fast-forward only. Convention plus `t3o` being the default
   branch already covers this; add it if a stray commit ever lands.

### Upstream sync — manual, documented as a runbook

**No automation during MVP.** A scheduled workflow automates something that happens three or four
times before the MVP is proved, and it is machinery built to defend a bet that has not been placed
yet. The value we actually want from upstream merges during MVP is *information* — how bad are the
conflicts — and that comes from doing it by hand and writing down the answer (`t3o-02`).

Record the runbook in `docs/t3o/seams.md` instead:

```bash
git fetch upstream
git checkout main && git merge --ff-only upstream/main   # never force; a failure means
                                                          # someone committed to the mirror
git checkout t3o && git merge main
```

Run it when there is a reason to — a bug fix you want, or before starting a spec that touches a
file upstream has been churning. Not on a calendar.

Automating this returns as a post-MVP item, at which point the scheduled-cards feature may be the
better home for it than a GitHub workflow. Either way the manual runbook stays, permanently: an
orchestrator that is broken cannot merge the fix that unbreaks it.

### Seam convention

Document and adopt in `docs/t3o/seams.md` (new directory, ours):

- Every insertion into an upstream-owned file is preceded by a `// T3o:` comment naming the reason
  (`<!-- T3o: -->` in markdown).
- The doc carries a seam inventory table, maintained by hand, so `rg "T3o:"` can be eyeballed
  against it after a merge.
- Anything larger than a few lines does **not** go inline — it goes in a T3o-owned module and the
  seam becomes a single delegating call.

No CI check on the seam count during MVP: seams are being added on nearly every commit, so a count
gate would be friction rather than protection. It becomes worth adding once the inventory stabilises.

### Branding

`apps/web/src/branding.ts` (`APP_BASE_NAME`, `APP_DISPLAY_NAME`, `APP_STAGE_LABEL`) is the naming
seam. Small, contained, low churn. Set the product name here; do not scatter naming elsewhere.

### CI hygiene

Disable in the GitHub Actions UI: `deploy-relay.yml`, `mobile-eas-preview.yml`,
`mobile-eas-production.yml`, `mobile-showcase-screenshots.yml`, `release.yml`,
`thread-transfer-report.yml`. Record the list and the reasoning in `docs/t3o/seams.md` so a future
reader knows they were disabled deliberately, not broken.

## Out of scope

- Any board code.
- Renaming `@t3tools/*` packages or the published `t3` CLI.
- **Any upstream-sync automation.** Deferred to post-MVP — see the runbook above.
- **Any seam-count CI gate.** Deferred until the seam inventory stops moving.

## Verification

- `git fetch upstream` succeeds and `git log upstream/main..main` is empty.
- `docs/t3o/seams.md` exists with the marker convention, the manual sync runbook, an empty seam
  inventory table, and the disabled-workflow list with reasons.
- A dry run of the runbook fast-forwards `main` cleanly.

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
2. Create `t3o` from current `main`.
3. Set `t3o` as the GitHub default branch.
4. Add branch protection on `main` allowing only fast-forward pushes from the sync workflow.

### Upstream sync workflow

New file `.github/workflows/upstream-sync.yml` — new files never conflict.

Behaviour:

- Runs on a weekly schedule and on `workflow_dispatch`.
- Fetches `upstream`, fast-forwards `main`. If the fast-forward fails, that means someone committed
  to the mirror — fail loudly, do not force.
- Opens or updates a PR `main → t3o` titled `chore: sync upstream <short-sha>`.
- Body lists upstream commits touching any file containing a `T3o:` marker, so the reviewer sees
  immediately whether a seam moved.
- Enables auto-merge when the PR is mergeable and CI is green; leaves it open and conflicted
  otherwise.

This stays permanently, even after the scheduled-cards feature (post-MVP) could take it over. An
orchestrator that is broken cannot merge the fix that unbreaks it.

### Seam convention

Document and adopt in `docs/t3o/seams.md` (new directory, ours):

- Every insertion into an upstream-owned file is preceded by a `// T3o:` comment naming the reason.
- The seam inventory table is maintained in that doc and must match `rg "T3o:"` output. A CI check
  that greps and compares counts is cheap and worth it.
- Anything larger than a few lines does **not** go inline — it goes in a T3o-owned module and the
  seam becomes a single delegating call.

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
- Automating conflict *resolution* — the workflow only mechanises fetch, fast-forward, and PR.

## Verification

- `git log upstream/main..main` is empty after a sync run.
- A deliberate test conflict (touch a marked line on both branches) produces a conflicted PR rather
  than a silent overwrite.
- `rg "T3o:"` returns the documented count.

# Releasing T3o

A T3o release is an annotated git tag on `t3o` plus a GitHub Release on
`brentkelly/t3code-orchestrator`. The tagged source is the release: there are no build artifacts, no
npm package, no desktop or mobile builds, and no GitHub Actions. Users install a tag and move between
tags with `pnpm run t3o-update` ([install.md](./install.md#update-to-a-new-release)).

Upstream's release machinery (`release.yml`, the CLI archives, `install.sh`, `t3 update`, the desktop
update feed) is not used. Fork Actions stay disabled; see
[Inherited workflows](./seams.md#inherited-workflows).

## Tag scheme

`t3o<base>.<n>`, for example `t3o0.1.8.1`, `t3o0.1.8.2`, then `t3o0.1.9.1` after the next upstream sync.

- `<base>` is the T3 Code version: the newest stable upstream `vX.Y.Z` tag contained in HEAD. Nightly and
  preview tags never count.
- `<n>` counts T3o releases on that base, starting at 1.

Only the release script works `<base>` out from upstream tags. Everything else (the About page, the
update script) reads it back from the T3o tag name, because users' clones carry only the fork's stale
copies of upstream tags.

`package.json` versions and `APP_VERSION` stay at upstream's committed value. Stamping the real version
there would make upstream's UI flag board workers on different releases as out of date and offer
`npm install -g t3@…`, which installs upstream.

## The build stamp

`install-t3o-service` writes `{ tag, version, base, commit, describe, dirty, builtAt }` to
`apps/web/.t3o-release.json` (gitignored) for the length of the build, which the web build reads into
`import.meta.env.T3O_RELEASE`, and to `dist/t3o-release.json` after it. The second is how `t3o-update`
and the release gate know what a service is running; a `--no-build` sync of a dist built some other way
has none, and reads as unknown. A build after a tag shows as `0.1.8.1+3.gabc1234` with no T3 Code
version, since an upstream sync may have landed since the tag; a build with no T3o tag behind it shows
as `dev (abc1234)`.

## Cutting a release

You need an `upstream` remote (`git remote add upstream https://github.com/pingdotgg/t3code.git`) and a
signed-in `gh`.

```bash
git switch t3o && git pull
pnpm run install-t3o-service       # run what you are about to tag
pnpm run t3o-release -- --dry-run  # checks, then prints the tag and release commands
pnpm run t3o-release
pnpm run install-t3o-service       # so your own service shows the new tag
```

The script refuses unless the tree is clean (a churned `pnpm-lock.yaml` is ignored), you are on `t3o`, and
HEAD equals `origin/t3o`. It then checks the **dogfood gate**: your installed service (`--unit`, default
`t3o`) must be running a clean build of exactly HEAD and answering HTTP 200. That is the release's only
test beyond the PR checks the merged work already passed. `--skip-gate` overrides it.

It tags, pushes **only that tag**, and runs `gh release create --latest` with notes generated since the
previous T3o tag, headed "Based on T3 Code v<base>."

Never `git push --tags`. The clone holds hundreds of upstream tags that would land on origin.

### Resuming

If the tag was created or pushed but `gh release create` failed, re-run the script. A HEAD that already
carries a T3o tag with no GitHub Release resumes from the push; one that already has a release stops with
nothing to do.

## When to release

After each upstream sync, and after notable features land. Release from a HEAD that existing users already
run or are behind, so `t3o-update` is a fast-forward for them.

## Checklist

- If `BOARD_WORKER_PROTOCOL_FLOOR` changed since the previous tag, say in the release notes that board
  workers must update too: a central board refuses workers below the floor. The refusal names
  `BOARD_WORKER_PROTOCOL_FLOOR_T3O_VERSION`, which is compared with nothing; it is upstream's
  `serviceVersion` that the message shows for the worker.
- After a sync, check that the notes header names the new T3 Code version.

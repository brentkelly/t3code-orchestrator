# Releasing T3o

How to cut a release of the T3o desktop app. The workflow is
[`.github/workflows/t3o-release.yml`](../../.github/workflows/t3o-release.yml). It builds every installer on
GitHub-hosted runners and leaves a **draft** GitHub Release. Nothing reaches users until a human publishes
that draft.

## What a release contains

| Platform | Files                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| macOS    | `T3o-<v>-arm64.dmg`, `T3o-<v>-x64.dmg`, and a `.zip` of each (the updater reads the zips)      |
| Windows  | `T3o-<v>-x64.exe`, `T3o-<v>-arm64.exe` (NSIS)                                                  |
| Linux    | AppImage, `.deb` and `.rpm`, each for x64 and arm64                                            |
| Runtime  | `t3-<v>-<platform>` CLI archives for every `CLI_ARCHIVE_PLATFORM_KEYS` entry, and `SHA256SUMS` |
| Updater  | `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`, and blockmaps    |

The CLI archives are not optional. SSH remotes, `t3 update` and the boot service download the server from
this repository's releases (`CLI_RELEASE_REPOSITORY` in `packages/shared/src/cliRelease.ts`), so a release
without them breaks every remote environment that runs its version.

## Versions

A T3o version is the upstream version it is built on plus a fork counter: **`<upstream>-t3o.<n>`**, for
example `0.0.42-t3o.1`. Bump `n` for each release on the same upstream base, and go back to `.1` after an
upstream sync (`0.0.43-t3o.1`). The tag is the version with a `v`: `v0.0.42-t3o.1`. The `v` is required,
because the runtime installers build their download URLs from `v<version>`.

`scripts/t3o-release-version.ts` refuses anything else. deb and rpm show the version as `0.0.42~t3o.1`,
which is the same version in those formats' spelling, and it sorts correctly.

## Cutting a release

1. **Start the build.** Either push the tag from the commit you want to ship:

   ```bash
   git tag v0.0.42-t3o.1 <commit> && git push origin v0.0.42-t3o.1
   ```

   or run the workflow from the Actions tab (**T3o release → Run workflow**) with a branch and a version.
   GitHub only offers **Run workflow** for workflows on the default branch (`t3o`). Until
   `t3o-release.yml` has merged there, the only way to run it is to push a tag.

2. **Wait for the draft.** The workflow boots each packaged app's backend on its own OS before creating the
   release: the extracted AppImage, the installed deb, the unzipped macOS app and the silently installed
   Windows app. It also installs the rpm on Fedora. A failed smoke job stops the release.

3. **Test the draft by hand** on a Mac and a Windows machine: install, get past the unsigned warning (see
   [install.md](./install.md#opening-an-unsigned-build)), open the Board, and check the app is named T3o.

4. **Publish** the draft from the Releases page. Leave **Set as a pre-release** unticked and **Set as the
   latest release** ticked. The updater follows the latest non-prerelease release, so a release published
   as a pre-release is never offered to anyone.

A published release is never rebuilt: the workflow's preflight refuses a tag that already has one. To fix a
bad release, cut the next `-t3o.<n>`. To throw away a draft, delete it (and its tag, if you pushed one).

## Upstream's release workflow stays off

Upstream's `release.yml` must stay **disabled** on the fork
([Inherited workflows](./seams.md#inherited-workflows)). Its tag trigger, `v*.*.*`, also matches
`v*-t3o.*`, so pushing a T3o tag with it enabled would start upstream's pipeline: npm publishing, the hosted
web deploy and the rest. Check before pushing a tag:

```bash
gh workflow list --all -R brentkelly/t3code-orchestrator | grep -E '^Release\s'
```

## Adding code signing

The builds are unsigned because the fork holds no certificates. `release-desktop.yml` already signs when its
secrets are present, so adding signing is a matter of adding repository secrets:

- **macOS:** `CSC_LINK`, `CSC_KEY_PASSWORD` (a Developer ID Application certificate), `APPLE_API_KEY`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` (notarisation), `MACOS_PROVISIONING_PROFILE`, and the
  `APPLE_TEAM_ID` variable. A signed build stamps `t3oCodeSigned: true` into the app, and macOS installs
  then update themselves instead of opening the release page.
- **Windows:** the seven `AZURE_*` Trusted Signing secrets `release-desktop.yml` lists.

A signed macOS build also enables passkey entitlements, which read a Clerk publishable key. T3 Connect is off
in T3o builds, so set `T3CODE_CLERK_PASSKEY_RP_DOMAINS` (repository variable `CLERK_PASSKEY_RP_DOMAINS`) or
expect the signed mac build to fail until that is resolved.

## When upstream changes the release pipeline

`t3o-release.yml` calls upstream's `release-desktop.yml` once per target and mirrors the shape of upstream's
`release.yml` (`build_bundle`, the per-target inputs, manifest merging). After an upstream sync, diff those two
files and `scripts/build-desktop-artifact.ts`: a new required input, a renamed artifact or a new target
needs the fork workflow adjusted to match. The sync runbook in [seams.md](./seams.md) carries the reminder.

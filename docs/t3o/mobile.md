# T3o mobile

T3o ships an Android APK from **this** repository's GitHub Releases. It is a
separate app from upstream T3 Code on the Play Store and App Store: those
builds do not include the Board.

Package id: `com.brentkelly.t3o`. Desktop's id is `io.github.brentkelly.t3o`.
They differ on purpose (Android reverse-DNS vs Electron app id) and are not
interchangeable.

## Install

1. Open [Releases](https://github.com/brentkelly/t3code-orchestrator/releases)
   and download the latest `t3o-*-debug.apk` (prerelease) or `t3o-*.apk` (signed).
2. Sideload on the phone (`adb install -r` or the system installer). Debug
   builds are signed with the Android debug key; a later signed release will
   not upgrade over a debug install — uninstall first.
3. Pair the app with a T3o **worktree** server (`vp run dev` / `t3o.service`),
   never `~/.t3` live userdata. Scan the pairing QR or paste the pairing URL.

The Home screen toggles **Threads | Board**. Board is hidden on servers that
do not advertise `capabilities.board` (upstream T3 Code).

## Debug vs signed release

| Mode | How | Upgradeable | Where it lands |
| ---- | --- | ----------- | -------------- |
| `debug-release` | `assembleDebug`, no keystore | Only onto other debug installs | GitHub prerelease `mobile-v<run_number>`, asset `t3o-<version>-debug.apk` |
| `signed-release` | `assembleRelease` with keystore secrets | Yes, across later signed runs | GitHub release, asset `t3o-<version>.apk` |
| `dev-client` | debug APK as a workflow artifact | Metro loop | Actions artifact only |

`versionCode` is `github.run_number`. `versionName` is
`${apps/mobile package version}-t3o.${run_number}`. Never reuse an older
run_number over a newer install.

Run from Actions: **Mobile T3o Android** → `workflow_dispatch` → pick the mode.

OTA, Clerk, relay, FCM, and Expo project id are **off** in the `t3o` variant.
Push notifications are out of scope; the app is pull-only until a later card.

iOS: `APP_VARIANT=t3o npx expo prebuild --clean --platform ios` should succeed
without an Apple team, Clerk Apple, or push entitlements. There is no IPA in
this card.

## Keystore (signed path)

The human owns the keystore. Agents never handle passwords.

Create (once, on a trusted machine):

```bash
keytool -genkeypair -v \
  -keystore t3o-upload.jks \
  -alias t3o \
  -keyalg RSA -keysize 2048 -validity 10000
```

Backup the `.jks` and the passwords offline. Losing them means a new package
id.

GitHub Actions secrets (fail-closed if any is missing on `signed-release`):

- `T3O_ANDROID_KEYSTORE_BASE64` — `base64 -w0 t3o-upload.jks`
- `T3O_ANDROID_KEYSTORE_PASSWORD`
- `T3O_ANDROID_KEY_ALIAS`
- `T3O_ANDROID_KEY_PASSWORD`

The workflow decodes the keystore to a temp file and runs
`apps/mobile/plugins/withT3oReleaseSigning.cjs` so Gradle's `signingConfigs.release`
is written only when those env vars are set.

Recovery: if the upload key is lost, publish a new signed app under a new
package id. Debug prereleases are unaffected.

## Local flavour

```bash
cd apps/mobile
APP_VARIANT=t3o pnpm android:t3o
# or: APP_VARIANT=t3o expo prebuild --clean --platform android
```

`android/app/build.gradle` must then contain `applicationId "com.brentkelly.t3o"`.

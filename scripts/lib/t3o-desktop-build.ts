/**
 * T3o: extra electron-builder overlays for downloadable installers (card T3O-1).
 *
 * Identity itself lives in `t3o-desktop-identity.ts`. This module only adds
 * what that file does not cover: derived icons, a `-t3o.N` version detector,
 * rpm beside the AppImage on a fork release, and `detectUpdateChannel: false`
 * so electron-builder does not treat `-t3o` as a channel named `t3o`.
 */
import { T3O_DESKTOP_IDENTITY } from "./t3o-desktop-identity.ts";

const T3O_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+-t3o\.\d+$/;

export function isT3oReleaseVersion(version: string): boolean {
  return T3O_RELEASE_VERSION_PATTERN.test(version.trim());
}

/** The derived T3o icon set; regenerate with `node scripts/t3o-icons.ts`. */
export const T3O_ICON_PATHS = {
  macIconPng: "assets/t3o/t3o-macos-1024.png",
  linuxIconPng: "assets/t3o/t3o-universal-1024.png",
  windowsIconIco: "assets/t3o/t3o-windows.ico",
} as const;

/**
 * A T3o release build of the Linux AppImage also produces deb and rpm
 * packages from the same unpacked app, so one job per arch ships all three.
 * Other versions keep tip's AppImage+deb pair, so a local build needs no
 * `rpmbuild`.
 */
export function t3oLinuxTargets(target: string, version: string): string[] {
  if (target === "AppImage" && isT3oReleaseVersion(version)) {
    return ["AppImage", "deb", "rpm"];
  }
  return target === "AppImage" ? ["AppImage", "deb"] : [target];
}

/**
 * Signing stamp stamped onto the staged app's package.json. `t3oCodeSigned`
 * tells the running app whether macOS can install its own updates
 * (Squirrel.Mac refuses an unsigned app). Name, description and homepage stay
 * on `T3O_DESKTOP_IDENTITY` in the stage package.
 */
export function t3oStagePackageMetadata(signed: boolean) {
  return {
    name: T3O_DESKTOP_IDENTITY.packageName,
    description: T3O_DESKTOP_IDENTITY.description,
    homepage: T3O_DESKTOP_IDENTITY.homepage,
    t3oCodeSigned: signed,
  };
}

type BuildConfig = Record<string, unknown>;

function mergeInto(config: BuildConfig, key: string, overrides: BuildConfig): void {
  const existing = config[key];
  if (existing !== undefined && typeof existing === "object" && existing !== null) {
    config[key] = { ...(existing as BuildConfig), ...overrides };
  }
}

/** Overlays T3O-1 packaging extras on tip's electron-builder config, in place. */
export function applyT3oBuildConfig(config: BuildConfig, target: string, version: string): void {
  // electron-builder would otherwise read the `-t3o.N` suffix as a channel
  // named `t3o` and write `t3o*.yml`; the app follows `latest*.yml`.
  config.detectUpdateChannel = false;

  mergeInto(config, "linux", {
    target: t3oLinuxTargets(target, version),
    packageName: T3O_DESKTOP_IDENTITY.packageName,
  });

  const mac = config.mac as BuildConfig | undefined;
  if (mac !== undefined) {
    const extendInfo = {
      ...((mac.extendInfo as BuildConfig | undefined) ?? {}),
      NSScreenCaptureUsageDescription:
        "T3o captures the active window when you use the window capture shortcut.",
    };
    mergeInto(config, "mac", { extendInfo });
  }
}

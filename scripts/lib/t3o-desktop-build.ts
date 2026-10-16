/**
 * T3o: the fork's electron-builder configuration (card T3O-1).
 *
 * `scripts/build-desktop-artifact.ts` builds upstream's config and then hands
 * it to `applyT3oBuildConfig` through one seam, so every place the packaged
 * app is named, identified or targeted differently from T3 Code is here.
 */
import {
  isT3oReleaseVersion,
  T3O_ARTIFACT_NAME,
  T3O_DESKTOP_SCHEMES,
  T3O_EXECUTABLE_NAME,
  T3O_PRODUCT_NAME,
  T3O_RELEASE_REPOSITORY,
} from "@t3tools/shared/t3oIdentity";

const T3O_HOMEPAGE = `https://github.com/${T3O_RELEASE_REPOSITORY}`;

/** The derived T3o icon set; regenerate with `node scripts/t3o-icons.ts`. */
export const T3O_ICON_PATHS = {
  macIconPng: "assets/t3o/t3o-macos-1024.png",
  linuxIconPng: "assets/t3o/t3o-universal-1024.png",
  windowsIconIco: "assets/t3o/t3o-windows.ico",
} as const;

const T3O_PROTOCOLS = [{ name: T3O_PRODUCT_NAME, schemes: [...T3O_DESKTOP_SCHEMES] }];

/**
 * A T3o release build of the Linux AppImage also produces deb and rpm
 * packages from the same unpacked app, so one job per arch ships all three.
 * Other versions keep upstream's single target, so a local build needs no
 * `rpmbuild`.
 */
export function t3oLinuxTargets(target: string, version: string): string[] {
  return target === "AppImage" && isT3oReleaseVersion(version)
    ? ["AppImage", "deb", "rpm"]
    : [target];
}

/** The staged app's package name and description, which the deb/rpm packages carry. */
export const T3O_STAGE_PACKAGE = {
  name: T3O_EXECUTABLE_NAME,
  description: "T3o desktop build",
} as const;

/**
 * Fields spread into the staged app's package.json. electron-builder refuses
 * to build a deb or rpm without a homepage. `t3oCodeSigned` tells the running
 * app whether macOS can install its own updates (Squirrel.Mac refuses an
 * unsigned app).
 */
export function t3oStagePackageMetadata(signed: boolean) {
  return {
    homepage: T3O_HOMEPAGE,
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

/** Overlays the T3o identity on upstream's electron-builder config, in place. */
export function applyT3oBuildConfig(config: BuildConfig, target: string, version: string): void {
  config.artifactName = T3O_ARTIFACT_NAME;
  // electron-builder would otherwise read the `-t3o.N` suffix as a channel
  // named `t3o` and write `t3o*.yml`; the app follows `latest*.yml`.
  config.detectUpdateChannel = false;

  const mac = config.mac as BuildConfig | undefined;
  mergeInto(config, "mac", {
    protocols: T3O_PROTOCOLS,
    extendInfo: {
      ...(mac?.extendInfo as BuildConfig | undefined),
      NSScreenCaptureUsageDescription:
        "T3o captures the active window when you use the window capture shortcut.",
    },
  });

  mergeInto(config, "linux", {
    target: t3oLinuxTargets(target, version),
    executableName: T3O_EXECUTABLE_NAME,
    maintainer: `T3o <${T3O_HOMEPAGE}>`,
    vendor: "T3o",
    synopsis: "A board that supervises coding agents",
    protocols: T3O_PROTOCOLS,
    desktop: { entry: { StartupWMClass: T3O_EXECUTABLE_NAME } },
  });
}

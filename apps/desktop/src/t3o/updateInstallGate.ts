/**
 * T3o: which T3o installs may replace themselves, and what the rest do instead
 * (card T3O-1).
 *
 * T3o ships unsigned. electron-updater can still replace a Windows NSIS
 * install and an AppImage, but Squirrel.Mac refuses an unsigned app and a
 * deb/rpm install needs a root package manager. Those installs still check
 * the fork's feed; when an update is available, "download" opens its release
 * page instead, so the user installs it the way they installed T3o.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { T3O_RELEASES_URL } from "@t3tools/shared/t3oIdentity";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";

export type T3oUpdateInstallMode = "self-install" | "release-page";

/**
 * Windows NSIS and AppImage replace themselves. macOS does only when the build
 * was code-signed; a build without the stamp (a local or upstream-shaped
 * build) keeps upstream's behaviour. Every other Linux install is a package
 * the system package manager owns.
 */
export function resolveT3oUpdateInstallMode(input: {
  readonly platform: NodeJS.Platform;
  readonly appImagePath: string | undefined;
  readonly codeSigned: boolean | undefined;
}): T3oUpdateInstallMode {
  switch (input.platform) {
    case "linux":
      return input.appImagePath ? "self-install" : "release-page";
    case "darwin":
      return input.codeSigned === false ? "release-page" : "self-install";
    default:
      return "self-install";
  }
}

/** The release page for a version, or the release list when it is unknown. */
export function t3oReleasePageUrl(version: string | null): string {
  const trimmed = version?.trim();
  return trimmed ? `${T3O_RELEASES_URL}/tag/v${encodeURIComponent(trimmed)}` : T3O_RELEASES_URL;
}

/** Shown when Download on a release-page install fails to open the browser. */
export function t3oReleasePageOpenFailureMessage(version: string | null): string {
  return `Couldn't open the release page. Open ${t3oReleasePageUrl(version)} to install the update.`;
}

const StagedPackageJson = Schema.fromJsonString(
  Schema.Struct({ t3oCodeSigned: Schema.optional(Schema.Boolean) }),
);
const decodeStagedPackageJson = Schema.decodeUnknownEffect(StagedPackageJson);

const LINUX_PACKAGE_TYPES = new Set(["deb", "rpm", "pacman"]);

export interface T3oUpdateInstallGate {
  /**
   * The `resources/package-type` file electron-builder writes into a deb/rpm
   * install, when this is one. Its presence is what makes a non-AppImage Linux
   * install able to check for updates.
   */
  readonly linuxPackageSource: string | undefined;
  readonly mode: T3oUpdateInstallMode;
  /**
   * Opens the release page instead of downloading when this install cannot
   * replace itself. Returns whether the page actually opened.
   */
  readonly redirectDownload: (version: string | null) => Effect.Effect<boolean>;
}

export const makeInstallGate = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const config = yield* DesktopConfig.DesktopConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const shell = yield* Effect.serviceOption(ElectronShell.ElectronShell);

  const readOptional = (path: string) =>
    fileSystem.readFileString(path).pipe(
      Effect.map(Option.some),
      Effect.catchCause(() => Effect.succeed(Option.none<string>())),
    );

  const packageTypePath = environment.path.join(environment.resourcesPath, "package-type");
  const linuxPackageType =
    environment.platform === "linux" && environment.isPackaged
      ? Option.filter(yield* readOptional(packageTypePath), (raw) =>
          LINUX_PACKAGE_TYPES.has(raw.trim()),
        )
      : Option.none();
  const linuxPackageSource = Option.isSome(linuxPackageType) ? packageTypePath : undefined;

  const codeSigned =
    environment.platform === "darwin"
      ? yield* readOptional(environment.path.join(environment.appRoot, "package.json")).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(undefined),
              onSome: (raw) =>
                decodeStagedPackageJson(raw).pipe(
                  Effect.map((parsed) => parsed.t3oCodeSigned),
                  Effect.orElseSucceed(() => undefined),
                ),
            }),
          ),
        )
      : undefined;

  const mode = resolveT3oUpdateInstallMode({
    platform: environment.platform,
    appImagePath: Option.getOrUndefined(config.appImagePath),
    codeSigned,
  });

  return {
    linuxPackageSource,
    mode,
    redirectDownload: (version) =>
      mode === "self-install"
        ? Effect.succeed(false)
        : Option.match(shell, {
            onNone: () => Effect.succeed(false),
            onSome: (electronShell) => electronShell.openExternal(t3oReleasePageUrl(version)),
          }),
  } satisfies T3oUpdateInstallGate;
});

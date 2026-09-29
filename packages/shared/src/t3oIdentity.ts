/**
 * T3o: the fork's own identity as a downloadable app (card T3O-1).
 *
 * One source for every name the desktop app, its build script, the server and
 * the runtime installers use to tell T3o apart from upstream T3 Code. Each
 * upstream file that used to hardcode one of these reads it from here through
 * a one-line `T3o:` seam, so the fork's identity lives in this file and not in
 * a dozen places upstream keeps editing.
 *
 * The identity is chosen so T3o coexists with an installed T3 Code: a
 * different app id, URL scheme, Electron user-data directory (which is also
 * Electron's single-instance lock) and default data directory.
 */

/** The GitHub repository the fork's releases, installers and runtimes come from. */
export const T3O_RELEASE_REPOSITORY = "brentkelly/t3code-orchestrator";

/** The fork's GitHub Releases page, where installers are downloaded by hand. */
export const T3O_RELEASES_URL = `https://github.com/${T3O_RELEASE_REPOSITORY}/releases`;

/** The display name of the app, before any stage label. */
export const T3O_PRODUCT_NAME = "T3o";

/** macOS bundle id, Windows AUMID and electron-builder `appId` of a packaged build. */
export const T3O_APP_ID = "io.github.brentkelly.t3o";

/**
 * Directory under the user's home that holds the desktop app's data
 * (`userdata/`, `dev/`) when `T3CODE_HOME` is unset. The server CLI keeps
 * upstream's `~/.t3`, which `t3o.service` and existing installs rely on.
 */
export const T3O_DESKTOP_HOME_DIR_NAME = ".t3o";

/** electron-builder artifact file name template. */
export const T3O_ARTIFACT_NAME = "T3o-${version}-${arch}.${ext}";

/** Linux executable name, and the `StartupWMClass` of a packaged build. */
export const T3O_EXECUTABLE_NAME = "t3o";

interface T3oStageIdentity {
  /** URL scheme the renderer is served from and OAuth callbacks come back on. */
  readonly scheme: string;
  /** Electron `userData` directory name under the OS app-data directory. */
  readonly userDataDirName: string;
  /** Windows AppUserModelID; also the macOS bundle id of the dev launcher. */
  readonly appUserModelId: string;
  readonly linuxWmClass: string;
  readonly linuxDesktopEntryName: string;
}

const PRODUCTION: T3oStageIdentity = {
  scheme: "t3o",
  userDataDirName: "t3o",
  appUserModelId: T3O_APP_ID,
  linuxWmClass: T3O_EXECUTABLE_NAME,
  linuxDesktopEntryName: "io.github.brentkelly.T3o.desktop",
};

const DEVELOPMENT: T3oStageIdentity = {
  scheme: "t3o-dev",
  userDataDirName: "t3o-dev",
  appUserModelId: `${T3O_APP_ID}.dev`,
  linuxWmClass: "t3o-dev",
  linuxDesktopEntryName: "io.github.brentkelly.T3o.Development.desktop",
};

/** The identity of a packaged build, or of a dev run (`VITE_DEV_SERVER_URL` set). */
export function t3oDesktopIdentity(isDevelopment: boolean): T3oStageIdentity {
  return isDevelopment ? DEVELOPMENT : PRODUCTION;
}

/** Every scheme a packaged or dev build registers, production first. */
export const T3O_DESKTOP_SCHEMES = [PRODUCTION.scheme, DEVELOPMENT.scheme] as const;

/** The origins a T3o desktop renderer loads from, which the server must accept. */
export const T3O_DESKTOP_RENDERER_ORIGINS = T3O_DESKTOP_SCHEMES.map((scheme) => `${scheme}://app`);

/**
 * A T3o release version: the upstream version it is built on plus a fork
 * counter, e.g. `0.0.42-t3o.1`. Tags are `v<version>`.
 */
const T3O_RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+-t3o\.\d+$/;

export function isT3oReleaseVersion(version: string): boolean {
  return T3O_RELEASE_VERSION_PATTERN.test(version.trim());
}

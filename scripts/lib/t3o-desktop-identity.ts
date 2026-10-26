/**
 * T3o desktop identity. The fork's desktop app installs alongside upstream T3 Code, so every
 * name the OS, Electron or the data directory keys on differs from upstream's. Upstream files
 * read these through one-line `T3o:` seams; the build script imports the same constants so the
 * packaged artifact and the running app agree.
 */
export const T3O_DESKTOP_IDENTITY = {
  productName: "T3o",
  /** Debian package, executable and Linux WM class. */
  packageName: "t3o",
  description: "T3o — T3 Code with a supervised engineering board.",
  homepage: "https://github.com/brentkelly/t3code-orchestrator",
  maintainer: "brentkelly <brentkelly@users.noreply.github.com>",
  appId: "com.brentkelly.t3o",
  devAppId: "com.brentkelly.t3o.dev",
  linuxWmClass: "t3o",
  devLinuxWmClass: "t3o-dev",
  /**
   * The runtime-written portal identity entry. Deliberately not `t3o.desktop`: the .deb installs
   * that one, and a hidden per-user entry of the same id would shadow it out of the app menu.
   */
  linuxDesktopEntryName: "com.brentkelly.t3o.desktop",
  devLinuxDesktopEntryName: "com.brentkelly.t3o.Development.desktop",
  userDataDirName: "t3o",
  devUserDataDirName: "t3o-dev",
  homeDirName: ".t3o",
  /**
   * The text the `t3` launcher carries so Install/Remove recognise their own links. Upstream's
   * marker differs, so T3o never repoints or deletes upstream T3 Code's `t3` and vice versa.
   */
  cliShimMarker: "Written by T3o: runs the desktop app's bundled t3 CLI.",
  /** Upstream T3 Code owns `t3code://`; T3o never claims it, at build time or at runtime. */
  registersUrlScheme: false,
} as const;

export const resolveT3oAppId = (isDevelopment: boolean): string =>
  isDevelopment ? T3O_DESKTOP_IDENTITY.devAppId : T3O_DESKTOP_IDENTITY.appId;

export const resolveT3oLinuxWmClass = (isDevelopment: boolean): string =>
  isDevelopment ? T3O_DESKTOP_IDENTITY.devLinuxWmClass : T3O_DESKTOP_IDENTITY.linuxWmClass;

export const resolveT3oLinuxDesktopEntryName = (isDevelopment: boolean): string =>
  isDevelopment
    ? T3O_DESKTOP_IDENTITY.devLinuxDesktopEntryName
    : T3O_DESKTOP_IDENTITY.linuxDesktopEntryName;

/**
 * Electron profile directory names. `legacy` equals `current` so upstream's legacy-profile
 * migration (which would otherwise pick up upstream T3 Code's profile) is a no-op for T3o.
 */
export const resolveT3oUserDataNames = (
  isDevelopment: boolean,
): { readonly current: string; readonly legacy: string } => {
  const name = isDevelopment
    ? T3O_DESKTOP_IDENTITY.devUserDataDirName
    : T3O_DESKTOP_IDENTITY.userDataDirName;
  return { current: name, legacy: name };
};

/**
 * T3o: electron-updater's `autoUpdater`, except that an AppImage always
 * updates as an AppImage (card T3O-1).
 *
 * T3o release builds package the AppImage, deb and rpm from one unpacked app
 * in one electron-builder run. The deb/rpm targets write
 * `resources/package-type` into that shared directory while the AppImage is
 * still being packed, so the AppImage can ship with `package-type: deb`.
 * electron-updater picks its updater class from that file alone, and would
 * then try to install a .deb over an AppImage. `APPIMAGE` is set by the
 * AppImage runtime itself, so it is the reliable signal.
 *
 * The updater is created on first use, as upstream's is.
 */
import { AppImageUpdater, autoUpdater } from "electron-updater";

type AutoUpdater = typeof autoUpdater;

export function isAppImageProcess(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return platform === "linux" && (env.APPIMAGE?.trim() ?? "") !== "";
}

let instance: AutoUpdater | undefined;

function resolveAutoUpdater(): AutoUpdater {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Chosen once, before any Effect runtime reads the updater.
  instance ??= isAppImageProcess(process.platform, process.env)
    ? new AppImageUpdater()
    : autoUpdater;
  return instance;
}

export const t3oAutoUpdater: AutoUpdater = new Proxy({} as AutoUpdater, {
  get: (_target, property) => {
    const updater = resolveAutoUpdater();
    const value: unknown = Reflect.get(updater, property, updater);
    return typeof value === "function" ? value.bind(updater) : value;
  },
  set: (_target, property, value) => Reflect.set(resolveAutoUpdater(), property, value),
});

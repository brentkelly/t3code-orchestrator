/** Settings → Board pages are board-server-wide with their own project tabs, so
    upstream's project/environment scope bar does not apply to them. */
export function isBoardSettingsPath(pathname: string): boolean {
  return pathname === "/settings/board" || pathname.startsWith("/settings/board/");
}

/** Whether a settings nav entry is the active one: the longest entry the path falls
    under wins, so Settings → Workers does not also light Board. */
export function isSettingsNavPathActive(
  activePath: string,
  to: string,
  navPaths: ReadonlyArray<string>,
): boolean {
  const matches = (path: string) => activePath === path || activePath.startsWith(`${path}/`);
  return matches(to) && !navPaths.some((other) => other.length > to.length && matches(other));
}

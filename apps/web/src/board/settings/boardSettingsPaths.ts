/** Settings → Board pages are board-server-wide with their own project tabs, so
    upstream's project/environment scope bar does not apply to them. */
export function isBoardSettingsPath(pathname: string): boolean {
  return pathname === "/settings/board" || pathname.startsWith("/settings/board/");
}

/** The sidebar's own label where it differs from the page's breadcrumb label: under the
    Board heading, the board's main page reads General. */
export function boardSettingsNavLabel(to: string): string | null {
  return to === "/settings/board" ? "General" : null;
}

/** A project's board settings are its pipeline, CI and resources: they light Pipeline. */
function boardSettingsNavPath(activePath: string): string {
  return activePath.startsWith("/settings/board/projects/")
    ? "/settings/board/pipeline"
    : activePath;
}

/** Whether a settings nav entry is the active one: the longest entry the path falls
    under wins, so Settings → Workers does not also light Board. */
export function isSettingsNavPathActive(
  activePath: string,
  to: string,
  navPaths: ReadonlyArray<string>,
): boolean {
  const path = boardSettingsNavPath(activePath);
  const matches = (candidate: string) => path === candidate || path.startsWith(`${candidate}/`);
  return matches(to) && !navPaths.some((other) => other.length > to.length && matches(other));
}

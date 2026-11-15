/** Settings → Board pages are board-server-wide with their own project tabs, so
    upstream's project/environment scope bar does not apply to them. */
export function isBoardSettingsPath(pathname: string): boolean {
  return pathname === "/settings/board" || pathname.startsWith("/settings/board/");
}

/** The sidebar's own label where it differs from the page's breadcrumb and search label: under
    the Board heading, the main page reads General and Board projects reads Projects. */
export function boardSettingsNavLabel(to: string): string | null {
  if (to === "/settings/board") return "General";
  if (to === "/settings/board/projects") return "Projects";
  return null;
}

/** Whether a settings nav entry is the active one: the longest entry the path falls
    under wins, so Settings → Workers does not also light Board. */
export function isSettingsNavPathActive(
  activePath: string,
  to: string,
  navPaths: ReadonlyArray<string>,
): boolean {
  const matches = (candidate: string) =>
    activePath === candidate || activePath.startsWith(`${candidate}/`);
  return matches(to) && !navPaths.some((other) => other.length > to.length && matches(other));
}

/** Settings → Board pages are board-server-wide with their own project tabs, so
    upstream's project/environment scope bar does not apply to them. */
export function isBoardSettingsPath(pathname: string): boolean {
  return pathname === "/settings/board" || pathname.startsWith("/settings/board/");
}

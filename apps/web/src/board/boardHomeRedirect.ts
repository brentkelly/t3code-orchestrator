/**
 * Cold-start home: only the session's first authenticated resolution, in a
 * session that booted at `/`, redirects to the board. Every later `/` (upstream's
 * "go home") stays threads home.
 */
import { redirect } from "@tanstack/react-router";

export const BOARD_HOME_PATH = "/board";
const THREADS_HOME_PATH = "/";

/**
 * The auth-gate statuses this file branches on. Upstream exports no type for
 * them, so naming the set here turns an upstream rename into a compile error at
 * the seams instead of a silent default branch.
 */
export type BoardAuthStatus =
  | "authenticated"
  | "requires-auth"
  | "hosted-static"
  | "hosted-pairing"
  | "guest";

/**
 * Where pairing lets go of the user. Hosted-static with no environment keeps
 * the threads surface and its connect hero; a guest-link visitor goes where
 * upstream sends it.
 */
export function resolvePairExitTarget(authStatus: BoardAuthStatus): "/" | "/board" {
  return authStatus === "hosted-static" || authStatus === "guest"
    ? THREADS_HOME_PATH
    : BOARD_HOME_PATH;
}

/**
 * Where upstream's first-run wizard exits when it opened no project. It runs
 * after the cold-start flag is spent, so it exits where pairing does. A wizard
 * that set up a project still opens a thread in it.
 */
export function resolveOnboardingExitTarget(authStatus: BoardAuthStatus): "/" | "/board" {
  return resolvePairExitTarget(authStatus);
}

export interface ColdStartHomeRedirect {
  /**
   * True at most once per session: for the first *authenticated* resolution in
   * a session that booted at `/`, and only when that resolution is still at
   * `/`. Spends its own flag, so callers can ask on every route resolution.
   */
  readonly shouldRedirectHome: (pathname: string, authStatus: BoardAuthStatus) => boolean;
}

/**
 * `bootPathname` is the pathname the document loaded with. A session that
 * booted anywhere else — a thread deep link, a card notification — never
 * redirects, because the user asked for that place.
 */
export function createColdStartHomeRedirect({
  bootPathname,
}: {
  readonly bootPathname: string;
}): ColdStartHomeRedirect {
  // Spent up front when the boot was not at the root: there is no cold start
  // at `/` left to claim.
  let spent = bootPathname !== THREADS_HOME_PATH;
  return {
    shouldRedirectHome: (pathname, authStatus) => {
      if (spent) return false;
      // Nothing before authentication is a cold start yet, so the flag stays
      // unspent through the whole unauthenticated phase. `hosted-static` is
      // never "authenticated", which is also how D3 stays exempt forever.
      if (authStatus !== "authenticated") return false;
      // The first authenticated resolution is the cold start wherever it lands, so
      // it is spent here; otherwise pairing's detour would hand the board the next
      // "go home" too.
      spent = true;
      return pathname === THREADS_HOME_PATH;
    },
  };
}

const appColdStartHomeRedirect = createColdStartHomeRedirect({
  bootPathname: typeof window === "undefined" ? "" : window.location.pathname,
});

/**
 * The `__root` seam. Throws TanStack's redirect when this resolution is the
 * app's cold start at `/`, and does nothing otherwise — so the whole rule,
 * including the router dependency, stays in this file.
 */
export function redirectColdStartToBoard(pathname: string, authStatus: BoardAuthStatus): void {
  if (!appColdStartHomeRedirect.shouldRedirectHome(pathname, authStatus)) return;
  throw redirect({ to: BOARD_HOME_PATH, replace: true });
}

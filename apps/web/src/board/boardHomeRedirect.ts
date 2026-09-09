/**
 * T3o cold-start home (T3O-34, D1): the board is the app's *entry*, not the
 * meaning of the root URL.
 *
 * `/` is the "go home" target of roughly a dozen upstream call sites — a
 * thread was deleted, a draft was discarded, settings closed, the sidebar
 * brand was clicked. Making `/` mean the board would drag the user onto the
 * board every one of those times, or force a new `/threads` route and an edit
 * to every one of those files. So only the *first* resolution of `/` in a
 * session that actually booted at `/` is redirected; every later `/` is
 * threads home, exactly as before.
 *
 * Pairing carries the same rule in its own source (D2) rather than inheriting
 * it from here, so a reader of `pair.tsx` can see where pairing goes.
 */
import { redirect } from "@tanstack/react-router";

export const BOARD_HOME_PATH = "/board";
export const THREADS_HOME_PATH = "/";

/**
 * Where the pairing flow lets go of the user. The hosted static app with no
 * environment connected has no board worth showing (D3), so it keeps the
 * threads surface and its "Connect an environment" hero.
 */
export function resolvePairExitTarget(authStatus: string): "/" | "/board" {
  return authStatus === "hosted-static" ? THREADS_HOME_PATH : BOARD_HOME_PATH;
}

export interface ColdStartHomeRedirect {
  /**
   * True exactly once, for the first resolution of `/` in a session that booted
   * there while authenticated. Spends its own flag, so callers can ask on every
   * route resolution.
   */
  readonly shouldRedirectHome: (pathname: string, authStatus: string) => boolean;
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
      if (pathname !== THREADS_HOME_PATH) return false;
      // Not authenticated yet (and `hosted-static`, which is never
      // "authenticated") keeps the flag unspent: the pairing flow lands on the
      // board itself, and the hosted app is exempt by D3.
      if (authStatus !== "authenticated") return false;
      spent = true;
      return true;
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
export function redirectColdStartToBoard(pathname: string, authStatus: string): void {
  if (!appColdStartHomeRedirect.shouldRedirectHome(pathname, authStatus)) return;
  throw redirect({ to: BOARD_HOME_PATH, replace: true });
}

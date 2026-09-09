/**
 * T3o cold-start home (T3O-34, D1): the board is the app's *entry*, not the
 * meaning of the root URL.
 *
 * `/` is the "go home" target of roughly a dozen upstream call sites — a
 * thread was deleted, a draft was discarded, settings closed, the sidebar
 * brand was clicked. Making `/` mean the board would drag the user onto the
 * board every one of those times, or force a new `/threads` route and an edit
 * to every one of those files. So only the session's *first authenticated*
 * resolution is redirected, and only in a session that actually booted at `/`;
 * every later `/` is threads home, exactly as before.
 *
 * Pairing carries the same rule in its own source (D2) rather than inheriting
 * it from here, so a reader of `pair.tsx` can see where pairing goes.
 */
import { redirect } from "@tanstack/react-router";

export const BOARD_HOME_PATH = "/board";
export const THREADS_HOME_PATH = "/";

/**
 * The auth-gate statuses this file branches on. Upstream assembles them in two
 * places and exports a type from neither: `resolveInitialServerAuthGateState`
 * yields `authenticated` / `requires-auth`, and `__root.tsx` returns
 * `hosted-static` / `hosted-pairing` from its own early returns. Naming the set
 * here makes an upstream rename a compile error at the seams that pass
 * `authGateState.status` in, instead of every comparison below silently falling
 * to its default branch — which would stop the cold-start redirect firing and
 * send hosted-static pairing to the board.
 */
export type BoardAuthStatus =
  | "authenticated"
  | "requires-auth"
  | "hosted-static"
  | "hosted-pairing";

/**
 * Where the pairing flow lets go of the user. The hosted static app with no
 * environment connected has no board worth showing (D3), so it keeps the
 * threads surface and its "Connect an environment" hero.
 */
export function resolvePairExitTarget(authStatus: BoardAuthStatus): "/" | "/board" {
  return authStatus === "hosted-static" ? THREADS_HOME_PATH : BOARD_HOME_PATH;
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
      // The first authenticated resolution *is* the cold start, wherever it
      // lands — so it is spent here rather than only at `/`. Pairing boots at
      // `/`, detours through `/pair` and lands on `/board` by its own rule
      // (D2); leaving the flag armed through that would hand the board the
      // user's next "go home" as well.
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

/**
 * T3o cold-start home (T3O-34, D1/D2/D3).
 *
 * The rule is one-shot on purpose: `/` is the "go home" target of a dozen
 * upstream call sites, so a redirect that fires on every `/` would drag the
 * user onto the board every time they deleted a thread. These tests pin both
 * halves — it fires for the cold start, and it never fires again.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_HOME_PATH,
  createColdStartHomeRedirect,
  resolvePairExitTarget,
} from "./boardHomeRedirect";

describe("createColdStartHomeRedirect", () => {
  it("redirects the first resolution of / in a session that booted there", () => {
    const redirect = createColdStartHomeRedirect({ bootPathname: "/" });
    expect(redirect.shouldRedirectHome("/", "authenticated")).toBe(true);
  });

  it("never redirects a second time, so / stays threads home for the session", () => {
    const redirect = createColdStartHomeRedirect({ bootPathname: "/" });
    expect(redirect.shouldRedirectHome("/", "authenticated")).toBe(true);
    // Deleting the last thread, discarding a draft, clicking the sidebar
    // brand: all of these navigate to `/` and must stay on threads.
    expect(redirect.shouldRedirectHome("/", "authenticated")).toBe(false);
    expect(redirect.shouldRedirectHome("/", "authenticated")).toBe(false);
  });

  it("does not redirect resolutions of other routes", () => {
    const redirect = createColdStartHomeRedirect({ bootPathname: "/" });
    expect(redirect.shouldRedirectHome("/env-1/thread-1", "authenticated")).toBe(false);
    expect(redirect.shouldRedirectHome("/settings/general", "authenticated")).toBe(false);
    // …and doing so did not spend the one-shot flag.
    expect(redirect.shouldRedirectHome("/", "authenticated")).toBe(true);
  });

  it("never redirects a session that booted at a deep link", () => {
    // The user asked for that place. Two of them, because a thread deep link
    // and a board deep link are both real entries.
    const fromThread = createColdStartHomeRedirect({ bootPathname: "/env-1/thread-1" });
    expect(fromThread.shouldRedirectHome("/", "authenticated")).toBe(false);
    const fromBoard = createColdStartHomeRedirect({ bootPathname: "/board" });
    expect(fromBoard.shouldRedirectHome("/", "authenticated")).toBe(false);
  });

  it("never redirects the hosted static app (D3)", () => {
    // On app.t3.codes with nothing connected, `/` is the connect-an-environment
    // hero and `/board` is a dead end.
    const redirect = createColdStartHomeRedirect({ bootPathname: "/" });
    expect(redirect.shouldRedirectHome("/", "hosted-static")).toBe(false);
    // Still exempt on every later resolution — the flag was not spent.
    expect(redirect.shouldRedirectHome("/", "hosted-static")).toBe(false);
  });

  it("does not redirect before authentication, and does not burn the flag doing it", () => {
    const redirect = createColdStartHomeRedirect({ bootPathname: "/" });
    expect(redirect.shouldRedirectHome("/", "requires-auth")).toBe(false);
    expect(redirect.shouldRedirectHome("/", "authenticated")).toBe(true);
  });
});

describe("resolvePairExitTarget", () => {
  it("lands a completed pairing on the board", () => {
    expect(resolvePairExitTarget("authenticated")).toBe(BOARD_HOME_PATH);
    expect(resolvePairExitTarget("requires-auth")).toBe(BOARD_HOME_PATH);
  });

  it("keeps the hosted static app on the threads surface (D3)", () => {
    expect(resolvePairExitTarget("hosted-static")).toBe("/");
  });
});

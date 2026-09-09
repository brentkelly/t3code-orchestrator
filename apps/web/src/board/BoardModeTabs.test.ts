/**
 * Regression tests for the Threads/Board tab navigation (t3o).
 *
 * The Board tab "did nothing" because the switch pushed straight onto
 * `router.history`, which does not re-run route matching in this TanStack
 * version. These tests drive the extracted `navigateToMode` against a real
 * in-memory router (no DOM), so a regression back to `router.history.push`
 * fails loudly. The first test pins that failing behaviour as the proof.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { navigateToMode } from "./BoardModeTabs";

function makeRouter(initialPath: string) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const boardRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/board",
    component: () => null,
  });
  const threadRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/$environmentId/$threadId",
    component: () => null,
  });
  const routeTree = rootRoute.addChildren([indexRoute, boardRoute, threadRoute]);
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
}

/** Let the router's async navigation settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("navigateToMode", () => {
  it("proves the original bug: router.history.push alone does not switch route", async () => {
    const router = makeRouter("/");
    await router.load();
    expect(router.state.location.pathname).toBe("/");

    // This is what the Board tab used to do; the location never changes, which
    // is exactly why clicking Board appeared to do nothing.
    router.history.push("/board");
    await flush();

    expect(router.state.location.pathname).toBe("/");
  });

  it("switches to the board route when the Board tab is chosen from threads", async () => {
    const router = makeRouter("/");
    await router.load();
    expect(router.state.location.pathname).toBe("/");

    navigateToMode(router, "threads", "board", {});
    await flush();

    expect(router.state.location.pathname).toBe("/board");
  });

  it("switches back to the threads root", async () => {
    const router = makeRouter("/board");
    await router.load();

    navigateToMode(router, "board", "threads", {});
    await flush();

    expect(router.state.location.pathname).toBe("/");
  });

  it("returns to the target mode's last-seen location, not its root", async () => {
    const router = makeRouter("/");
    await router.load();

    navigateToMode(router, "threads", "board", { board: "/board?project=web" });
    await flush();

    expect(router.state.location.pathname).toBe("/board");
    expect((router.state.location.search as { project?: string }).project).toBe("web");
  });

  it("ignores a poisoned board location (thread href) and lands on the board root", async () => {
    // The exact symptom the user hit: a thread href had been stored under
    // `board`, so clicking Board opened that thread instead of the board.
    const router = makeRouter("/env-1/thread-1");
    await router.load();
    expect(router.state.location.pathname).toBe("/env-1/thread-1");

    navigateToMode(router, "threads", "board", { board: "/env-1/thread-1" });
    await flush();

    expect(router.state.location.pathname).toBe("/board");
  });

  it("ignores a stored settings location and lands on the threads root", async () => {
    // The reported trap: `/settings/general` had been stored under `threads`,
    // so clicking Threads reopened settings and Back from settings went to the
    // board — no way to reach a thread.
    const router = makeRouter("/board");
    await router.load();

    navigateToMode(router, "board", "threads", { threads: "/settings/general" });
    await flush();

    expect(router.state.location.pathname).toBe("/");
  });

  it("is a no-op when the target mode is already active", async () => {
    const router = makeRouter("/board");
    await router.load();
    let navigateCalls = 0;
    const spyRouter = {
      navigate: (options: { readonly href: string }) => {
        navigateCalls += 1;
        return router.navigate(options);
      },
    };

    navigateToMode(spyRouter, "board", "board", { board: "/board?project=web" });
    await flush();

    expect(navigateCalls).toBe(0);
    expect(router.state.location.pathname).toBe("/board");
  });
});

/**
 * Composition guards for the control itself (T3O-34), asserted from source the
 * way `BoardTopBar.test.ts` pins the board header's composition. Rendering the
 * component to markup to read back its children would test React, not us.
 */
describe("BoardModeTabs composition", () => {
  const source = NodeFS.readFileSync(new URL("./BoardModeTabs.tsx", import.meta.url), "utf8");

  it("puts Board before Threads — the board is the primary mode", () => {
    const boardTab = source.indexOf('label="Board"');
    const threadsTab = source.indexOf('label="Threads"');
    expect(boardTab).toBeGreaterThan(-1);
    expect(threadsTab).toBeGreaterThan(-1);
    expect(boardTab).toBeLessThan(threadsTab);
  });

  it("runs the last-location effect before the sidebar-hosting early return", () => {
    // If the early return moves above the effect, there is a window in which
    // nobody records the last threads location and switching back to threads
    // lands on the root instead of the thread you were reading.
    const effect = source.indexOf("recordModeLocation(mode, locationHref)");
    const earlyReturn = source.indexOf("sidebarHostsModeTabs) {");
    expect(effect).toBeGreaterThan(-1);
    expect(earlyReturn).toBeGreaterThan(-1);
    expect(effect).toBeLessThan(earlyReturn);
  });
});

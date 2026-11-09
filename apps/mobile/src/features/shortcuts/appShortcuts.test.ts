import { describe, expect, it } from "vite-plus/test";
import type { NavigationState } from "@react-navigation/native";

import type { RecentThreadShortcut } from "../../persistence/imperative";
import {
  activeThreadRef,
  BOARD_SHORTCUT_HREF,
  BOARD_SHORTCUT_ID,
  buildShortcutActions,
  NEW_TASK_SHORTCUT_ID,
  shortcutHref,
  withRecentThreadShortcut,
} from "./appShortcuts";

function navState(route: { name: string; params?: unknown }): NavigationState {
  return { index: 0, routes: [route] } as unknown as NavigationState;
}

function thread(suffix: string, title = `Thread ${suffix}`): RecentThreadShortcut {
  return { environmentId: `env-${suffix}`, threadId: `thread-${suffix}`, title };
}

describe("withRecentThreadShortcut", () => {
  it("moves a reopened thread to the front without duplicating it", () => {
    const next = withRecentThreadShortcut([thread("a"), thread("b")], thread("b"));
    expect(next.map((entry) => entry.threadId)).toEqual(["thread-b", "thread-a"]);
  });

  it("keeps the known title when a reopen records an empty one", () => {
    const current = [thread("a", "Fix the build")];
    const next = withRecentThreadShortcut(current, thread("a", ""));
    expect(next).toBe(current);
  });
});

describe("buildShortcutActions", () => {
  it("leads with the static new-task and board actions", () => {
    const actions = buildShortcutActions([thread("a")]);
    expect(actions[0]?.id).toBe(NEW_TASK_SHORTCUT_ID);
    expect(actions[0]?.params?.href).toBe("/new");
    expect(actions[1]?.id).toBe(BOARD_SHORTCUT_ID);
    expect(actions[1]?.params?.href).toBe(BOARD_SHORTCUT_HREF);
    expect(actions).toHaveLength(3);
  });

  it("deep-links threads with encoded route params", () => {
    const actions = buildShortcutActions([
      { environmentId: "env 1", threadId: "thread/2", title: "Spaced out" },
    ]);
    expect(actions[2]?.params?.href).toBe("/threads/env%201/thread%2F2");
    expect(actions[2]?.title).toBe("Spaced out");
  });

  it("falls back to a generic label for missing titles", () => {
    const actions = buildShortcutActions([thread("a", "  ")]);
    expect(actions[2]?.title).toBe("Thread");
  });
});

describe("shortcutHref", () => {
  it("accepts exactly the destinations shortcuts can produce", () => {
    expect(shortcutHref({ id: "x", title: "x", params: { href: "/new" } })).toBe("/new");
    expect(shortcutHref({ id: "x", title: "x", params: { href: "/board" } })).toBe("/board");
    expect(shortcutHref({ id: "x", title: "x", params: { href: "/threads/env-1/thread-2" } })).toBe(
      "/threads/env-1/thread-2",
    );
    expect(
      shortcutHref({ id: "x", title: "x", params: { href: "/threads/env%201/thread%2F2" } }),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("rejects everything else", () => {
    for (const href of [
      "https://evil.example",
      "//evil.example",
      "/settings",
      "/threads/only-one-segment",
      "/threads/a/b/c",
      "/threads//x",
      "/threads/a/b?x=1",
      "/threads/a/b#frag",
      "/new/extra",
    ]) {
      expect(shortcutHref({ id: "x", title: "x", params: { href } })).toBe(null);
    }
    expect(shortcutHref({ id: "x", title: "x", params: { href: 3 } })).toBe(null);
    expect(shortcutHref({ id: "x", title: "x" })).toBe(null);
  });
});

describe("activeThreadRef", () => {
  it("returns null instead of throwing for malformed params", () => {
    const malformed: unknown[] = [
      undefined,
      {},
      { environmentId: "env-1" },
      { environmentId: "", threadId: "thread-2" },
      { environmentId: "   ", threadId: "thread-2" },
      { environmentId: "env-1", threadId: "  " },
      { environmentId: 42, threadId: "thread-2" },
      { environmentId: { nested: true }, threadId: "thread-2" },
      { environmentId: [], threadId: [] },
    ];
    for (const params of malformed) {
      expect(activeThreadRef(navState({ name: "Thread", params }))).toBe(null);
    }
  });
});

describe("launcher shortcut ids", () => {
  it("cannot collide across different env/thread pairs", () => {
    const a = buildShortcutActions([{ environmentId: "a-b", threadId: "c", title: "x" }]);
    const b = buildShortcutActions([{ environmentId: "a", threadId: "b-c", title: "x" }]);
    expect(a[2]?.id).not.toBe(b[2]?.id);
  });
});

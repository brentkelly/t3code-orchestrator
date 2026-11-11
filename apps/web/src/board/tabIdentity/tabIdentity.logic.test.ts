import {
  DEFAULT_BOARD_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BoardSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { APP_DISPLAY_NAME } from "../../branding";
import { boardLabelForeground } from "../labelColour";
import { PROJECT_ICON_ACCENTS, projectAccent } from "../projectAccent";
import {
  buildCardIndex,
  resolveIdentity,
  routeKey,
  shouldHold,
  tabFallbackName,
  type TabIdentityInputs,
  type TabProject,
  type TabRouteKey,
  type TabRouteMatch,
  type TabThread,
} from "./tabIdentity.logic";

const central = EnvironmentId.make("env-central");
const worker = EnvironmentId.make("env-worker");
const otherEnv = EnvironmentId.make("env-other");
const t3o = ProjectId.make("project-t3o");
const workerProject = ProjectId.make("project-worker-copy");
const sunny = ProjectId.make("project-sunny");

const snapshot = {
  cards: [
    { cardId: "card-65", key: "T3O-65", title: "Tab identity", projectId: t3o },
    { cardId: "card-60", key: "T3O-60", title: "Distributed board", projectId: t3o },
    { cardId: "card-legacy", key: "CARD-0", title: "Legacy", projectId: t3o },
    { cardId: "card-sun", key: "SUN-4", title: "Sunny card", projectId: sunny },
    {
      cardId: "card-long",
      key: "T3O-1204",
      title: "A card title that goes on and on well past the sixty character limit for tabs",
      projectId: t3o,
    },
  ],
  cardThreads: [
    { cardId: "card-65", threadId: ThreadId.make("thread-local") },
    { cardId: "card-60", threadId: ThreadId.make("thread-remote"), workerId: worker },
  ],
};

const projects: Record<string, TabProject> = {
  [`${central}|${t3o}`]: {
    title: "t3o",
    projectIcon: { kind: "monogram", text: "T3", color: "blue" } as TabProject["projectIcon"],
  },
  [`${central}|${sunny}`]: {
    title: "Sunny",
    projectIcon: { kind: "lucide", name: "sun", color: "yellow" } as TabProject["projectIcon"],
  },
  [`${worker}|${workerProject}`]: { title: "Worker Copy" },
  [`${otherEnv}|${ProjectId.make("project-unset")}`]: { title: "Mesh Web" },
};

const threads: Record<string, TabThread> = {
  [`${central}|thread-local`]: { title: "Build T3O-65", projectId: t3o },
  [`${worker}|thread-remote`]: { title: "Build on worker", projectId: workerProject },
  [`${central}|thread-plain`]: { title: "Just chatting", projectId: t3o },
  [`${otherEnv}|thread-local`]: {
    title: "Same id elsewhere",
    projectId: ProjectId.make("project-unset"),
  },
};

const boardSettings: BoardSettings = {
  ...DEFAULT_BOARD_SETTINGS,
  projects: { [t3o]: { keyPrefix: "T3O" } as BoardSettings["projects"][ProjectId] },
};

function inputs(overrides: Partial<TabIdentityInputs> = {}): TabIdentityInputs {
  return {
    environmentLabel: "mesh-dev",
    fallbackName: "T3 Code (Beta)",
    boardEnvironment: { kind: "ready", environmentId: central },
    cardIndex: buildCardIndex(central, snapshot),
    boardSettings,
    thread: (environmentId, threadId) => threads[`${environmentId}|${threadId}`] ?? null,
    project: (environmentId, projectId) => projects[`${environmentId}|${projectId}`] ?? null,
    ...overrides,
  };
}

const blue = PROJECT_ICON_ACCENTS.blue.mutedHex;
const t3oTile = (number: string | null) => ({
  kind: "tile",
  prefix: "T3O",
  number,
  fill: blue,
  foreground: "#ffffff",
});
const defaultIcon = { kind: "default" };

const card = (cardId: string, projectId: ProjectId | null = null): TabRouteKey => ({
  kind: "card",
  cardId,
  scope: { kind: "board", projectId },
});
const thread = (environmentId: EnvironmentId, threadId: string): TabRouteKey => ({
  kind: "thread",
  environmentId,
  threadId: ThreadId.make(threadId),
});

describe("resolveIdentity", () => {
  it.each<{
    readonly name: string;
    readonly key: TabRouteKey;
    readonly inputs?: Partial<TabIdentityInputs>;
    readonly expected: { title: string; icon: unknown; pending?: boolean } | null;
  }>([
    {
      name: "a card open on the board",
      key: card("card-65"),
      expected: { title: "Tab identity · T3O-65 · mesh-dev", icon: t3oTile("65") },
    },
    {
      name: "a card open inside a sub-board",
      key: {
        kind: "card",
        cardId: "card-65",
        scope: { kind: "subBoard", parentCardId: "card-60" },
      },
      expected: { title: "Tab identity · T3O-65 · mesh-dev", icon: t3oTile("65") },
    },
    {
      name: "a stale ?card falls back to its scope",
      key: card("card-gone", t3o),
      expected: { title: "Board · mesh-dev", icon: t3oTile(null) },
    },
    {
      name: "a card before the snapshot resolves to its scope, pending",
      key: card("card-65"),
      inputs: { cardIndex: null },
      expected: { title: "Board · mesh-dev", icon: defaultIcon, pending: true },
    },
    {
      name: "a card with the nominated board server down resolves with no card",
      key: card("card-65"),
      inputs: { boardEnvironment: { kind: "unavailable" } },
      expected: { title: "Board · mesh-dev", icon: defaultIcon, pending: false },
    },
    {
      name: "a local thread on a card",
      key: thread(central, "thread-local"),
      expected: { title: "Build T3O-65 · T3O-65 · mesh-dev", icon: t3oTile("65") },
    },
    {
      name: "a worker thread takes the card's project fill and prefix, not the worker's",
      key: thread(worker, "thread-remote"),
      expected: { title: "Build on worker · T3O-60 · mesh-dev", icon: t3oTile("60") },
    },
    {
      name: "the same thread id in another environment is not that card's",
      key: thread(otherEnv, "thread-local"),
      expected: {
        title: "Same id elsewhere · mesh-dev",
        icon: {
          kind: "tile",
          prefix: "MW",
          number: null,
          fill: projectAccent(ProjectId.make("project-unset")).mutedHex,
          foreground: "#ffffff",
        },
      },
    },
    {
      name: "a thread with no card shows its project prefix",
      key: thread(central, "thread-plain"),
      expected: { title: "Just chatting · mesh-dev", icon: t3oTile(null) },
    },
    {
      name: "a thread before the snapshot shows no card yet, pending",
      key: thread(central, "thread-local"),
      inputs: { cardIndex: null },
      expected: { title: "Build T3O-65 · mesh-dev", icon: t3oTile(null), pending: true },
    },
    {
      name: "a thread not loaded yet uses the fallback name",
      key: thread(central, "thread-unknown"),
      expected: { title: "T3 Code (Beta) · mesh-dev", icon: defaultIcon },
    },
    {
      name: "a draft uses the fallback name and its project's prefix",
      key: {
        kind: "draft",
        draftId: "draft-1",
        project: { environmentId: central, projectId: t3o },
      },
      expected: { title: "T3 Code (Beta) · mesh-dev", icon: t3oTile(null) },
    },
    {
      name: "a sub-board reads differently from its parent card",
      key: { kind: "subBoard", parentCardId: "card-60" },
      expected: { title: "Distributed board · T3O-60 board · mesh-dev", icon: t3oTile(null) },
    },
    {
      name: "a project-scoped board shows that project's prefix",
      key: { kind: "board", projectId: t3o },
      expected: { title: "Board · mesh-dev", icon: t3oTile(null) },
    },
    {
      name: "the all-projects board keeps the static icon",
      key: { kind: "board", projectId: null },
      expected: { title: "Board · mesh-dev", icon: defaultIcon },
    },
    {
      name: "settings and other pages keep the app name",
      key: { kind: "other" },
      expected: { title: "T3 Code (Beta) · mesh-dev", icon: defaultIcon },
    },
    {
      name: "the guest page is left alone",
      key: { kind: "guest" },
      expected: null,
    },
    {
      name: "no primary config drops the environment suffix",
      key: { kind: "other" },
      inputs: { environmentLabel: null },
      expected: { title: "T3 Code (Beta)", icon: defaultIcon },
    },
    {
      name: "the foreground is the board pill's split for the fill",
      key: card("card-sun"),
      expected: {
        title: "Sunny card · SUN-4 · mesh-dev",
        icon: {
          kind: "tile",
          prefix: "SUN",
          number: "4",
          fill: PROJECT_ICON_ACCENTS.yellow.mutedHex,
          foreground: boardLabelForeground(PROJECT_ICON_ACCENTS.yellow.mutedHex),
        },
      },
    },
    {
      name: "a legacy CARD-0 key shows as-is",
      key: card("card-legacy"),
      expected: { title: "Legacy · CARD-0 · mesh-dev", icon: { ...t3oTile("0"), prefix: "CARD" } },
    },
    {
      name: "a long title is trimmed",
      key: card("card-long"),
      expected: {
        title: "A card title that goes on and on well past the sixty charac… · T3O-1204 · mesh-dev",
        icon: t3oTile("1204"),
      },
    },
  ])("$name", ({ key, inputs: overrides, expected }) => {
    const identity = resolveIdentity(key, inputs(overrides));
    if (expected === null) {
      expect(identity).toBeNull();
      return;
    }
    expect(identity).toMatchObject(expected);
  });

  it("looks thread cards up on the board environment, nominated or primary", () => {
    const nominated = EnvironmentId.make("env-nominated");
    const index = buildCardIndex(nominated, {
      cards: snapshot.cards,
      cardThreads: [{ cardId: "card-65", threadId: ThreadId.make("thread-local") }],
    });
    const onNominated = resolveIdentity(
      thread(nominated, "thread-local"),
      inputs({
        boardEnvironment: { kind: "ready", environmentId: nominated },
        cardIndex: index,
        thread: () => ({ title: "Remote", projectId: t3o }),
      }),
    );
    expect(onNominated?.title).toBe("Remote · T3O-65 · mesh-dev");
    // The same link read as the primary's board: the thread on `nominated` is not local to it.
    const onPrimary = resolveIdentity(
      thread(nominated, "thread-local"),
      inputs({ cardIndex: buildCardIndex(central, snapshot), thread: () => null }),
    );
    expect(onPrimary?.title).toBe("T3 Code (Beta) · mesh-dev");
  });
});

describe("routeKey", () => {
  const match = (routeId: string, params = {}, search = {}): TabRouteMatch => ({
    routeId,
    params,
    search,
  });
  const noDraft = () => null;

  it.each<{ readonly name: string; readonly matches: TabRouteMatch[]; readonly expected: unknown }>(
    [
      {
        name: "/board with a card",
        matches: [match("__root__"), match("/board", {}, { card: "card-65", project: "p" })],
        expected: { kind: "card", cardId: "card-65", scope: { kind: "board", projectId: "p" } },
      },
      {
        name: "/list behaves like /board",
        matches: [match("__root__"), match("/list", {}, { card: "card-65" })],
        expected: { kind: "card", cardId: "card-65", scope: { kind: "board", projectId: null } },
      },
      {
        name: "a sub-board child card",
        matches: [match("/board_/$parentCardId", { parentCardId: "card-60" }, { card: "card-65" })],
        expected: {
          kind: "card",
          cardId: "card-65",
          scope: { kind: "subBoard", parentCardId: "card-60" },
        },
      },
      {
        name: "a sub-board",
        matches: [match("/board_/$parentCardId", { parentCardId: "card-60" })],
        expected: { kind: "subBoard", parentCardId: "card-60" },
      },
      {
        name: "the board",
        matches: [match("/board")],
        expected: { kind: "board", projectId: null },
      },
      {
        name: "a thread",
        matches: [
          match("__root__"),
          match("/_chat"),
          match("/_chat/$environmentId/$threadId", { environmentId: "e", threadId: "t" }),
        ],
        expected: { kind: "thread", environmentId: "e", threadId: "t" },
      },
      {
        name: "a guest page",
        matches: [match("__root__"), match("/guest")],
        expected: { kind: "guest" },
      },
      {
        name: "settings",
        matches: [match("__root__"), match("/_chat"), match("/_chat/settings/general")],
        expected: { kind: "other" },
      },
    ],
  )("$name", ({ matches, expected }) => {
    expect(routeKey(matches, noDraft)).toEqual(expected);
  });

  it("resolves a draft's project from the draft store", () => {
    const project = { environmentId: central, projectId: t3o };
    expect(
      routeKey([match("/_chat/draft/$draftId", { draftId: "draft-1" })], (draftId) =>
        draftId === "draft-1" ? project : null,
      ),
    ).toEqual({ kind: "draft", draftId: "draft-1", project });
  });
});

describe("shouldHold", () => {
  const key = card("card-65");
  const pending = resolveIdentity(key, inputs({ cardIndex: null }))!;
  const resolved = { key: card("card-65"), pending: false };

  it("holds a resolved route while its snapshot reloads", () => {
    expect(shouldHold(pending, key, resolved)).toBe(true);
  });

  it("resolves at once when the route changed", () => {
    expect(shouldHold(pending, key, { key: { kind: "other" }, pending: false })).toBe(false);
    expect(shouldHold(pending, key, null)).toBe(false);
  });

  it("keeps updating a cold start whose snapshot has not arrived yet", () => {
    expect(shouldHold(pending, key, { key: card("card-65"), pending: true })).toBe(false);
  });

  it("never holds when the board server is unavailable", () => {
    const down = resolveIdentity(key, inputs({ boardEnvironment: { kind: "unavailable" } }))!;
    expect(shouldHold(down, key, resolved)).toBe(false);
  });
});

describe("tabFallbackName", () => {
  it("follows the server version's stage label", () => {
    expect(tabFallbackName(null)).toBe(APP_DISPLAY_NAME);
    expect(tabFallbackName("0.1.8")).toBe(APP_DISPLAY_NAME);
    expect(tabFallbackName("0.1.9-nightly.20261110.3")).toBe("T3 Code (Nightly)");
  });
});

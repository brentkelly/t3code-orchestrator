import type { AnyRouter } from "@tanstack/react-router";
import {
  BoardCardId,
  BoardStageId,
  EMPTY_BOARD_WORKERS_STATE,
  ProjectId,
  makeBoardCardShell,
  type BoardCardShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "notifications" as string,
  inApp: false,
  boardEnvironmentId: null as string | null,
  boardNotifications: {
    enabled: true,
    waiting: true,
    needsHuman: true,
    readyForMerge: true,
    blocked: false,
    muteRoutineThreadAlerts: true,
  },
  toast: vi.fn((_toast: unknown) => "toast-1"),
  closeToast: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: {
      ...actual.toastManager,
      add: state.toast as never,
      close: state.closeToast as never,
    },
  };
});
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/board"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    boardEnvironment: {
      ...actual.boardEnvironment,
      boardAtom: ((id: string) => boardAtom(id)) as never,
      workersAtom: (() => workersAtom) as never,
      stageListAtom: (() => stagesAtom) as never,
      projectStageConfigsAtom: (() => stageConfigsAtom) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      get presentationsAtom() {
        return presentationsAtom as never;
      },
    },
  };
});
const hoisted = await vi.hoisted(async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryAtom: Atom.make<string | null>("one") };
});
vi.mock(import("../state/primaryEnvironment"), async (original) => ({
  ...(await original()),
  primaryEnvironmentIdAtom: hoisted.primaryAtom as never,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: (() => serverSettingsAtom) as never,
    },
  };
});
vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      get hiddenThreadKeysAtom() {
        return noHiddenAtom as never;
      },
      get delegatedUnderParentAtom() {
        return noDelegatedAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
    boardEnvironmentId: state.boardEnvironmentId,
    boardNotifications: state.boardNotifications,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  setBoardNotificationBadge: state.badge,
}));

import { startBoardCardNotifications } from "./boardCardNotifications";
import { isBoardRoutineThreadAlertMuted } from "./boardThreadAlertMute";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const boardAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const workersAtom = Atom.make(EMPTY_BOARD_WORKERS_STATE);
const stagesAtom = Atom.make<ReadonlyArray<never>>([]);
const stageConfigsAtom = Atom.make({});
const serverSettingsAtom = Atom.make(null);
const presentationsAtom = Atom.make(new Map<string, unknown>());
const noHiddenAtom = Atom.make<ReadonlySet<string>>(new Set<string>());
const noDelegatedAtom = Atom.make<ReadonlySet<string>>(new Set<string>());

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

const NOW = DateTime.makeUnsafe("2026-11-11T00:00:00.000Z");

function threadShell(id: string, pendingInput: boolean) {
  return {
    id,
    projectId: "project-1",
    title: "Card thread",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run",
    activeRunId: null,
    status: "running",
    pendingRuntimeRequest: pendingInput
      ? { id: "request-1", kind: "user_input", createdAt: NOW }
      : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    latestRunRequestedAt: NOW,
    latestRunStartedAt: NOW,
    latestRunCompletedAt: undefined,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function card(overrides?: Partial<BoardCardShell>): BoardCardShell {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make("card-1"),
      key: "T3-1",
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BoardStageId.make("building"),
      orderKey: "m",
      title: "A card",
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...overrides,
  };
}

const live = (threads: ReadonlyArray<unknown> = []) => ({
  status: "live",
  snapshot: Option.some({ threads }),
});
const presentation = (phase: string) => ({
  entry: { target: { label: "Board" }, enabled: true },
  connection: { phase },
});

function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.boardEnvironmentId = null;
  state.boardNotifications = {
    enabled: true,
    waiting: true,
    needsHuman: true,
    readyForMerge: true,
    blocked: false,
    muteRoutineThreadAlerts: true,
  };
  state.settingsListeners.clear();
  registry.set(
    presentationsAtom,
    new Map([
      ["one", presentation("connected")],
      ["two", presentation("connected")],
    ]),
  );
  registry.set(shellAtom("one"), live());
  registry.set(boardAtom("one"), { cards: [card()], cardThreads: [] });
  TestNotification.sent = [];
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  let focused = false;
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  const navigate = vi.fn();
  const location = { pathname: "/", search: {} as Record<string, string> };
  const router = { state: { location }, navigate } as unknown as AnyRouter;
  return {
    navigate,
    location,
    focus: (value: boolean) => {
      focused = value;
    },
    start: () => {
      stack.defer(startBoardCardNotifications(testRegistry, router));
    },
    setBoard: (env: string, cards: ReadonlyArray<BoardCardShell>, cardThreads: unknown[] = []) =>
      testRegistry.set(boardAtom(env), { cards, cardThreads }),
    changeSettings: () => {
      for (const listener of state.settingsListeners) listener();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it("alerts once when a card starts waiting, opens it on click, and closes when it stops", async () => {
  await using app = setup();
  app.start();
  expect(TestNotification.sent).toEqual([]);
  app.setBoard("one", [card({ awaitingInput: true })]);
  expect(TestNotification.sent.map(({ title, options }) => [title, options.body])).toEqual([
    ["Input needed", "T3-1: A card"],
  ]);
  expect(state.sound).not.toHaveBeenCalled();
  expect(state.badge).toHaveBeenLastCalledWith(1);
  const notification = TestNotification.sent[0]!;
  notification.dispatchEvent(new Event("click"));
  expect(app.navigate).toHaveBeenCalledWith({ to: "/board", search: { card: "card-1" } });

  app.setBoard("one", [card()]);
  expect(notification.close).toHaveBeenCalled();
  expect(state.badge).toHaveBeenLastCalledWith(0);
});

it("toasts in the app, except while that card is open", async () => {
  await using app = setup();
  state.inApp = true;
  app.focus(true);
  app.start();
  app.setBoard("one", [card({ awaitingInput: true })]);
  expect(state.toast).toHaveBeenCalledTimes(1);
  expect(state.toast.mock.calls[0]![0]).toMatchObject({
    title: "Input needed",
    description: "T3-1: A card",
    actionProps: { children: "Open card" },
  });

  app.setBoard("one", [card()]);
  expect(state.closeToast).toHaveBeenCalledWith("toast-1");
  app.location.pathname = "/board";
  app.location.search = { card: "card-1" };
  app.setBoard("one", [card({ awaitingInput: true })]);
  expect(state.toast).toHaveBeenCalledTimes(1);
});

it("stays quiet when the card's thread already alerted for the same question", async () => {
  await using app = setup();
  const linked = [{ cardId: "card-1", threadId: "thread-1" }];
  app.setBoard("one", [card({ activeThreadId: "thread-1" as never })], linked);
  app.start();
  registry.set(shellAtom("one"), live([threadShell("thread-1", true)]));
  app.setBoard("one", [card({ activeThreadId: "thread-1" as never, awaitingInput: true })], linked);
  expect(TestNotification.sent).toEqual([]);
  // The card's threads are muted for routine alerts while the mute is on.
  expect(isBoardRoutineThreadAlertMuted("thread-1", "completion", "ready")).toBe(true);
  expect(isBoardRoutineThreadAlertMuted("thread-1", "input", "input")).toBe(false);
});

it("watches the nominated board server and stays silent while it is disconnected", async () => {
  await using app = setup();
  state.boardEnvironmentId = "two";
  registry.set(shellAtom("two"), live());
  app.setBoard("two", [card()]);
  app.start();
  app.setBoard("one", [card({ awaitingInput: true })]);
  expect(TestNotification.sent).toEqual([]);
  app.setBoard("two", [card({ awaitingInput: true })]);
  expect(TestNotification.sent).toHaveLength(1);

  registry.set(
    presentationsAtom,
    new Map([
      ["one", presentation("connected")],
      ["two", presentation("reconnecting")],
    ]),
  );
  app.setBoard("two", [card({ held: true })]);
  expect(TestNotification.sent).toHaveLength(1);
});

it("keeps the routine mute while every card category is off", async () => {
  await using app = setup();
  state.boardNotifications = {
    ...state.boardNotifications,
    waiting: false,
    needsHuman: false,
    readyForMerge: false,
  };
  const linked = [{ cardId: "card-1", threadId: "thread-1" }];
  app.setBoard("one", [card({ activeThreadId: "thread-1" as never })], linked);
  app.start();
  expect(isBoardRoutineThreadAlertMuted("thread-1", "completion", "ready")).toBe(true);
  app.setBoard("one", [card({ activeThreadId: "thread-1" as never, awaitingInput: true })], linked);
  expect(TestNotification.sent).toEqual([]);
});

it("stops watching when notifications are off", async () => {
  await using app = setup();
  app.start();
  state.mode = "off";
  app.changeSettings();
  app.setBoard("one", [card({ awaitingInput: true })]);
  expect(TestNotification.sent).toEqual([]);
  expect(isBoardRoutineThreadAlertMuted("thread-1", "completion", "ready")).toBe(false);
});

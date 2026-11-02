// @vitest-environment jsdom
/**
 * Compact identity-row layout (T3O-17): on a narrow maximised sheet the title
 * keeps a floor, pane tabs scroll inside the chip cluster, Show more overlays
 * the cluster so it cannot steal that floor, and the thread trigger / Exit /
 * Close stay pinned. jsdom does not run the browser flex algorithm, so this
 * walks the row's flex items and their Tailwind shrink classes and assigns
 * used widths the way the sheet's row does.
 */
import {
  BOARD_SEED_STAGE_IDS,
  BOARD_SEED_STAGES,
  DEFAULT_SERVER_SETTINGS,
  EMPTY_BOARD_WORKERS_STATE,
  BoardCardId,
  BoardLabelId,
  ProjectId,
  ThreadId,
  boardPlanId,
  type BoardCard,
  type BoardCardDetail,
  type BoardLabel,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { boardThreadWorker } from "./workers/threadWorker";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { readonly children?: React.ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("../components/ChatView", () => ({
  default: () => <div>embedded-chat</div>,
}));

vi.mock("../state/entities", () => ({
  useThreadShell: () => ({ id: "thread-1" }),
}));

vi.mock("./workers/BoardThreadWorkerGate", () => ({
  BoardThreadWorkerGate: ({
    worker,
    children,
  }: {
    readonly worker: { readonly environmentId: string };
    readonly children: (environmentId: string) => React.ReactNode;
  }) => children(worker.environmentId),
}));

vi.mock("./workers/BoardCardWorkerRow", () => ({
  BoardCardWorkerRow: () => null,
}));

vi.mock("../lib/observeResize", () => ({
  observeResize: (_elements: unknown, callback: () => void) => {
    callback();
    return () => {};
  },
}));

const compactViewport = vi.hoisted(() => ({ short: true }));
vi.mock("../hooks/useMediaQuery", async () => {
  const { BOARD_CARD_COMPACT_CHROME_QUERY } = await import("./boardCardCompactChrome");
  return {
    useIsMobile: () => false,
    useMediaQuery: (query: string) =>
      query === BOARD_CARD_COMPACT_CHROME_QUERY ? compactViewport.short : false,
  };
});

const { BoardCardDetailPanel } = await import("./BoardCardDetailView");

const NOW = "2026-01-01T00:00:00.000Z";
const environmentId = "env-1" as never;
const cardId = BoardCardId.make("card-1");
const noop = () => {};
const localWorker = boardThreadWorker({
  workerId: undefined,
  workers: EMPTY_BOARD_WORKERS_STATE,
  boardEnvironmentId: environmentId,
});

function card(overrides?: Partial<BoardCard>): BoardCard {
  return {
    id: cardId,
    key: "T3-7",
    cardNumber: 7,
    projectId: ProjectId.make("project-gone"),
    labels: [],
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    stage: BOARD_SEED_STAGE_IDS.planning,
    orderKey: "m",
    title: "Wire the widget",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoStart: false,
    autoMerge: false,
    autoMergeHold: null,
    pinnedWorkerId: null,
    placedWorkerId: null,
    workerMove: null,
    placementOrphaned: null,
    worktree: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function detail(overrides?: Partial<BoardCard>, extra?: Partial<BoardCardDetail>): BoardCardDetail {
  const next = card(overrides);
  return {
    card: next,
    brief: null,
    hasPlan: false,
    plans: [],
    children: [],
    dependencies: [],
    dependents: [],
    activity: [],
    parentModelOverrides: null,
    stepError: null,
    stepCompletions: [],
    ...extra,
  };
}

const samplePlan = {
  planId: boardPlanId(cardId, "1"),
  cardId,
  title: "Key rotation",
  summary: "Rotate the signing keys",
  dependsOn: [],
  ordinal: 0,
  locked: false,
  createdAt: NOW,
  updatedAt: NOW,
  body: "# Key rotation",
} satisfies BoardCardDetail["plans"][number];

const threadLink = {
  threadId: ThreadId.make("thread-live"),
  role: "planning",
  tombstoned: false,
  title: "Live planning thread",
  threadState: "stopped" as const,
  awaitingInput: false,
  worker: localWorker,
  ranOn: null,
};

const baseProps = {
  environmentId,
  baseBranch: {
    effective: "main",
    retargeted: false,
    inheritedFrom: null,
    workspaceRoot: "/tmp/project",
  },
  project: {
    lock: null,
    options: [],
    accent: null,
    names: new Map<string, string>(),
    stopsAgent: false,
    restartsStage: false,
  },
  onMergePullRequest: noop,
  onOpenPullRequest: noop,
  conflictFix: null,
  stepFailure: null,
  stepPaused: null,
  merging: false,
  catalogue: [] as ReadonlyArray<BoardLabel>,
  stages: BOARD_SEED_STAGES,
  humanInLoop: null,
  onSetHumanInLoop: noop,
  labelsById: new Map<BoardLabelId, BoardLabel>(),
  branch: null,
  dependencies: [],
  dependencyOptions: [],
  threadLinks: [threadLink],
  attachments: [],
  adoptableThreads: [],
  stageRestart: null,
  onRestartStage: noop,
  onCreateBlankThread: () => Promise.resolve(null),
  feedback: null,
  maximised: true,
  onToggleMaximised: noop,
  paneChoice: null,
  onSelectPane: noop,
  onClose: noop,
  onSetLabels: noop,
  onCreateLabel: noop,
  onRecolourLabel: noop,
  onDeleteLabel: noop,
  onUndeleteLabel: noop,
  onSaveBrief: noop,
  attachmentLimits: { known: false, enabled: false, maxFileBytes: null },
  onAttachFile: () => Promise.resolve(null),
  onDetachFile: noop,
  onSaveTitle: noop,
  onAddDependency: noop,
  onRemoveDependency: noop,
  onMoveStage: noop,
  onArchiveToggle: noop,
  onDelete: noop,
  canApproveSplit: false,
  approveSplitTargetLabel: null,
  onApproveSplit: noop,
  onLinkThread: noop,
  onUnlinkThread: noop,
  boardSettings: DEFAULT_SERVER_SETTINGS.board,
  onSetModelOverrides: noop,
  scheduleKind: "before-build" as const,
  onSetScheduledStartAt: noop,
  projectName: "P",
  detail: detail({
    stage: BOARD_SEED_STAGE_IDS.planning,
    threadLinks: [
      {
        threadId: threadLink.threadId,
        role: "planning",
        linkedAt: NOW,
        tombstonedAt: null,
      },
    ],
  }),
} as const;

const SHEET_WIDTH = 320;
const ROW_PADDING_X = 32; // identity row `px-4`
const ROW_CONTENT_WIDTH = SHEET_WIDTH - ROW_PADDING_X;
const GAP = 9;
const TITLE_FLOOR = 64;
const TRIGGER_FLOOR = 64;

const PANE_TAB_WIDTH: Record<string, number> = {
  Thread: 72,
  Review: 78,
  Summary: 86,
  Plan: 64,
  Brief: 68,
};

function hasClass(className: string, token: string) {
  return new RegExp(`(?:^|\\s)${token}(?:\\s|$)`).test(className);
}

function isCompactCluster(el: HTMLElement) {
  return (
    hasClass(el.className, "overflow-x-auto") &&
    el.querySelector("#board-card-detail-title") != null
  );
}

function mockClusterOverflow(overflows: () => boolean) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!isCompactCluster(this)) return 100;
    return overflows() ? 400 : 80;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return isCompactCluster(this) ? 80 : 100;
  });
}

function paneTabLabel(el: HTMLElement): string | null {
  const text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return text in PANE_TAB_WIDTH ? text : null;
}

function flexItems(row: HTMLElement): HTMLElement[] {
  return [...row.children].filter((node): node is HTMLElement => {
    if (!(node instanceof HTMLElement)) return false;
    if (node.hidden) return false;
    if (hasClass(node.className, "size-0")) return false;
    if (node.getAttribute("aria-hidden") === "true") return false;
    if (node.getAttribute("role") === "dialog") return false;
    return true;
  });
}

function estimateContentWidth(el: HTMLElement): number {
  const label = el.getAttribute("aria-label") ?? "";
  if (label === "Close") return 28;
  if (label === "More actions") return 28;
  if (label === "Exit fullscreen") return 24;
  if (label === "Show more") return 24;
  if (label.startsWith("Threads")) return 192;
  if (label === "Open in Threads") return 24;
  if (el.id === "board-card-detail-title") return 160;
  const tab = paneTabLabel(el);
  if (tab !== null && el.tagName === "BUTTON") return PANE_TAB_WIDTH[tab]!;
  const allButtons = [...el.querySelectorAll("button")];
  const paneButtons = allButtons.filter((button) => paneTabLabel(button as HTMLElement) !== null);
  if (
    paneButtons.length > 0 &&
    paneButtons.length === allButtons.length &&
    !hasClass(el.className, "overflow-x-auto")
  ) {
    return (
      paneButtons.reduce(
        (sum, button) => sum + PANE_TAB_WIDTH[paneTabLabel(button as HTMLElement)!]!,
        0,
      ) +
      Math.max(0, paneButtons.length - 1) * 2 +
      8
    );
  }
  const innerScroller = [...el.children].find(
    (node): node is HTMLElement =>
      node instanceof HTMLElement && hasClass(node.className, "overflow-x-auto"),
  );
  if (innerScroller !== undefined) return estimateContentWidth(innerScroller);
  if (hasClass(el.className, "overflow-x-auto")) {
    const kids = flexItems(el);
    if (kids.length > 0) {
      return (
        kids.reduce((sum, child) => sum + estimateContentWidth(child), 0) +
        Math.max(0, kids.length - 1) * GAP
      );
    }
    return 720;
  }
  if (hasClass(el.className, "size-7")) return 28;
  if (el.querySelector('[aria-label="Close"]') != null) return 28;
  if (el.querySelector('[aria-label="More actions"]') != null) return 28;
  if (el.querySelector('[aria-label="Exit fullscreen"]') != null) return 24;
  if (el.querySelector('[aria-label="Show more"]') != null) return 24;
  if (el.querySelector('[aria-label^="Threads"]') != null) return 192;
  return 48;
}

function layoutRow(row: HTMLElement, rowWidth: number) {
  const items = flexItems(row);
  const models = items.map((el) => {
    const className = el.className;
    const shrink0 = hasClass(className, "shrink-0");
    const flex1 = hasClass(className, "flex-1");
    const flexAuto = hasClass(className, "flex-auto");
    const minW0 = hasClass(className, "min-w-0");
    const minW16 = hasClass(className, "min-w-16");
    const clipOverflow =
      hasClass(className, "overflow-x-auto") || hasClass(className, "overflow-hidden");
    let content = estimateContentWidth(el);
    if (hasClass(className, "max-w-48")) content = Math.min(content, 192);
    if (className.includes("max-w-[min(40%,14rem)]")) {
      content = Math.min(content, Math.min(rowWidth * 0.4, 224));
    }
    let min = content;
    if (minW16) min = 64;
    else if (minW0 || flex1) min = 0;
    return {
      el,
      grow: flex1 || flexAuto ? 1 : 0,
      shrink: shrink0 ? 0 : 1,
      basis: flex1 ? 0 : content,
      min,
      content,
      clipOverflow,
    };
  });
  const used = models.map((model) => Math.max(model.basis, model.min));
  const gaps = Math.max(0, items.length - 1) * GAP;
  for (let pass = 0; pass < 4; pass++) {
    const total = used.reduce((sum, width) => sum + width, 0) + gaps;
    if (total <= rowWidth) break;
    const extra = total - rowWidth;
    const weights = models.map((model, index) =>
      used[index]! > model.min ? model.shrink * used[index]! : 0,
    );
    const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
    if (weightSum <= 0) break;
    for (let index = 0; index < used.length; index++) {
      if (weights[index] === 0) continue;
      used[index] = Math.max(
        models[index]!.min,
        used[index]! - extra * (weights[index]! / weightSum),
      );
    }
  }
  const usedTotal = used.reduce((sum, width) => sum + width, 0) + gaps;
  if (usedTotal < rowWidth) {
    const leftover = rowWidth - usedTotal;
    const growSum = models.reduce((sum, model) => sum + model.grow, 0);
    if (growSum > 0) {
      for (let index = 0; index < used.length; index++) {
        used[index] = (used[index] ?? 0) + leftover * (models[index]!.grow / growSum);
      }
    }
  }
  let x = 0;
  return models.map((model, index) => {
    const width = used[index]!;
    const start = x;
    x += width + GAP;
    const paint = model.clipOverflow ? width : Math.max(width, model.content);
    return { el: model.el, start, width, paintEnd: start + paint };
  });
}

describe("BoardCardDetailPanel compact identity-row layout", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    compactViewport.short = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps Close clear of compact thread controls on a narrow sheet", async () => {
    await act(() => root.render(<BoardCardDetailPanel {...baseProps} />));
    await act(() => Promise.resolve());

    const close = container.querySelector('[aria-label="Close"]');
    expect(close).toBeInstanceOf(HTMLElement);
    const row = close!.closest('[class*="relative z-10"]');
    expect(row).toBeInstanceOf(HTMLElement);
    const scroller = [...row!.querySelectorAll('[class*="overflow-x-auto"]')].find((node) =>
      hasClass((node as HTMLElement).className, "overflow-x-auto"),
    );
    expect(scroller).toBeInstanceOf(HTMLElement);
    const trigger = container.querySelector('[aria-label^="Threads"]');
    expect(trigger).toBeInstanceOf(HTMLElement);
    const exit = container.querySelector('[aria-label="Exit fullscreen"]');
    expect(exit).toBeInstanceOf(HTMLElement);
    const threadTab = [...row!.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Thread"),
    );
    expect(threadTab).toBeInstanceOf(HTMLElement);

    expect(scroller!.contains(trigger)).toBe(false);
    expect(scroller!.contains(threadTab!)).toBe(true);
    expect(scroller!.contains(close)).toBe(false);
    expect(scroller!.contains(exit)).toBe(false);
    expect(
      hasClass(scroller!.className, "flex-auto") ||
        hasClass((scroller!.parentElement as HTMLElement | null)?.className ?? "", "flex-auto"),
    ).toBe(true);
    expect(hasClass(scroller!.className, "min-w-0")).toBe(true);
    expect(hasClass(close!.className, "shrink-0")).toBe(true);
    expect(hasClass(exit!.className, "shrink-0")).toBe(true);
    expect(hasClass(row!.className, "overflow-x-auto")).toBe(false);

    const boxes = layoutRow(row as HTMLElement, ROW_CONTENT_WIDTH);
    const closeBox = boxes.find((box) => box.el === close || box.el.contains(close));
    expect(closeBox).toBeDefined();
    const overlapping = boxes.filter(
      (box) =>
        box !== closeBox &&
        box.paintEnd > closeBox!.start &&
        box.start < closeBox!.start + closeBox!.width,
    );
    expect(overlapping).toEqual([]);
    expect(closeBox!.start + closeBox!.width).toBeLessThanOrEqual(ROW_CONTENT_WIDTH + GAP);
  });

  it("keeps the compact title floor when Show more mounts", async () => {
    mockClusterOverflow(() => true);
    await act(() => root.render(<BoardCardDetailPanel {...baseProps} />));
    await act(() => Promise.resolve());

    const close = container.querySelector('[aria-label="Close"]') as HTMLElement;
    const row = close.closest('[class*="relative z-10"]') as HTMLElement;
    const title = container.querySelector("#board-card-detail-title") as HTMLElement;
    const trigger = container.querySelector('[aria-label^="Threads"]') as HTMLElement;
    const exit = container.querySelector('[aria-label="Exit fullscreen"]') as HTMLElement;
    const chevron = container.querySelector('[aria-label="Show more"]') as HTMLElement;
    const threadTab = [...row.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Thread"),
    ) as HTMLElement;
    const cluster = [...row.children].find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && hasClass(node.className, "flex-auto"),
    ) as HTMLElement;
    const scroller = (
      hasClass(cluster.className, "overflow-x-auto")
        ? cluster
        : [...cluster.children].find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement && hasClass(node.className, "overflow-x-auto"),
          )
    ) as HTMLElement;

    expect(title).toBeInstanceOf(HTMLElement);
    expect(chevron).toBeInstanceOf(HTMLElement);
    expect(scroller.contains(title)).toBe(true);
    expect(scroller.contains(threadTab)).toBe(true);
    expect(scroller.contains(trigger)).toBe(false);
    expect(scroller.contains(exit)).toBe(false);
    expect(scroller.contains(chevron)).toBe(false);
    expect(hasClass(row.className, "overflow-x-auto")).toBe(false);
    expect(hasClass(trigger.parentElement!.className, "min-w-16")).toBe(true);

    const boxes = layoutRow(row, ROW_CONTENT_WIDTH);
    const clusterBox = boxes.find((box) => box.el === cluster);
    const triggerBox = boxes.find(
      (box) => box.el === trigger || box.el.contains(trigger) || trigger.contains(box.el),
    );
    const chevronBox = boxes.find((box) => box.el === chevron);
    const exitBox = boxes.find((box) => box.el === exit || box.el.contains(exit));
    const closeBox = boxes.find((box) => box.el === close || box.el.contains(close));
    expect(clusterBox).toBeDefined();
    expect(triggerBox).toBeDefined();
    expect(exitBox).toBeDefined();
    expect(closeBox).toBeDefined();
    expect(chevronBox).toBeUndefined();
    expect(cluster.contains(chevron)).toBe(true);
    expect(clusterBox!.width).toBeGreaterThanOrEqual(TITLE_FLOOR);
    expect(triggerBox!.width).toBeGreaterThanOrEqual(TRIGGER_FLOOR);
    expect(exitBox!.paintEnd).toBeLessThanOrEqual(closeBox!.start + 0.5);
    expect(closeBox!.start + closeBox!.width).toBeLessThanOrEqual(ROW_CONTENT_WIDTH + GAP);

    const inner = layoutRow(scroller, clusterBox!.width);
    const titleBox = inner.find((box) => box.el === title || box.el.contains(title));
    expect(titleBox).toBeDefined();
    expect(titleBox!.width).toBeGreaterThanOrEqual(TITLE_FLOOR);
  });

  it("shows a chevron when the compact identity cluster overflows", async () => {
    mockClusterOverflow(() => true);
    await act(() => root.render(<BoardCardDetailPanel {...baseProps} />));
    await act(() => Promise.resolve());

    expect(container.querySelector('[aria-label="Show more"]')).not.toBeNull();

    const close = container.querySelector('[aria-label="Close"]');
    const row = close!.closest('[class*="relative z-10"]') as HTMLElement;
    const scroller = [...row.querySelectorAll('[class*="overflow-x-auto"]')].find(
      (node) =>
        node instanceof HTMLElement &&
        hasClass(node.className, "overflow-x-auto") &&
        node.querySelector("#board-card-detail-title") != null,
    ) as HTMLElement;
    const trigger = container.querySelector('[aria-label^="Threads"]');
    const chevron = container.querySelector('[aria-label="Show more"]');
    expect(scroller.contains(trigger)).toBe(false);
    expect(scroller.contains(chevron)).toBe(false);
  });

  it("hides the compact identity chevron when the cluster fits", async () => {
    await act(() => root.render(<BoardCardDetailPanel {...baseProps} />));
    await act(() => Promise.resolve());
    expect(container.querySelector('[aria-label="Show more"]')).toBeNull();
  });

  it("shows Show more when a plan tab appears without a resize", async () => {
    mockClusterOverflow(() =>
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Plan"),
      ),
    );

    await act(() => root.render(<BoardCardDetailPanel {...baseProps} />));
    await act(() => Promise.resolve());
    expect(container.querySelector('[aria-label="Show more"]')).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Plan"),
      ),
    ).toBe(false);

    await act(() =>
      root.render(
        <BoardCardDetailPanel
          {...baseProps}
          detail={{ ...baseProps.detail, plans: [samplePlan], hasPlan: true }}
        />,
      ),
    );
    await act(() => Promise.resolve());

    expect(
      [...container.querySelectorAll("button")].some((button) =>
        button.textContent?.includes("Plan"),
      ),
    ).toBe(true);
    expect(container.querySelector('[aria-label="Show more"]')).not.toBeNull();
  });
});

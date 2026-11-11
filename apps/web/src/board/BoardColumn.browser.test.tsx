/**
 * Board columns under a group drag: a refused column never accepts a
 * drop — no `preventDefault`, so the browser shows its no-drop cursor — and a
 * sub-board's empty early columns start as rails until a human says otherwise.
 */
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardStageId,
  type BoardCardShell,
  type BoardStageId as BoardStageIdType,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { BoardColumn, type BoardColumnProps } from "./BoardColumn";
import { boardScopeColumnCollapsedByDefault, type BoardScope } from "./boardScope";
import { isBoardColumnCollapsed, useBoardUiStore } from "./boardUiStore";

const STAGE_STATE = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };
const SUB: BoardScope = { kind: "sub-board", parentCardId: BoardCardId.make("group-1") };

function columnProps(overrides: Partial<BoardColumnProps>): BoardColumnProps {
  return {
    stage: BoardStageId.make("ready"),
    label: "Ready",
    cards: [],
    labelsById: new Map(),
    collapsed: false,
    queueSlots: new Map(),
    selectedCardId: null,
    addProjects: [],
    accentNameFor: () => null,
    parentKeyFor: () => undefined,
    attentionFor: () => null,
    childAttentionFor: () => undefined,
    childRunningFor: () => undefined,
    noPullRequestFor: () => false,
    worktreeKeptFor: () => null,
    todosFor: () => ({
      threads: [],
      stateOf: () => undefined,
      titleOf: () => "Thread",
      expanded: false,
      onToggleExpanded: () => undefined,
    }),
    onSetCollapsed: () => undefined,
    onSelectCard: () => undefined,
    onRequestCreate: () => undefined,
    draggedCardId: null,
    dragOverIndex: null,
    dragHeight: 0,
    onColumnDragOver: () => undefined,
    onColumnDrop: () => undefined,
    onCardDragStart: () => undefined,
    onCardDragEnd: () => undefined,
    onCardReorder: () => undefined,
    ...overrides,
  };
}

/** Fires a real dragover at the column's drop zone and reports whether the
    page would accept the drop there. */
function dragOver(element: Element): boolean {
  const event = new DragEvent("dragover", { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("BoardColumn drop refusal", () => {
  it("outlines a refused column and never lets it accept the drop", async () => {
    const onColumnDragOver = vi.fn((_stage: BoardStageIdType, event: { preventDefault(): void }) =>
      event.preventDefault(),
    );
    const onRefusedDragOver = vi.fn();
    await using screen = await render(
      <BoardColumn
        {...columnProps({
          draggedCardId: "group-2",
          dropRefusal: "Ready holds a single card's approved plan.",
          onColumnDragOver,
          onRefusedDragOver,
        })}
      />,
    );
    const column = screen.container.querySelector("[data-board-column]")!;
    expect(column.hasAttribute("data-board-drop-refused")).toBe(true);
    expect(column.className).toContain("border-dashed");
    expect(dragOver(screen.getByText("No cards").element())).toBe(false);
    expect(onColumnDragOver).not.toHaveBeenCalled();
    expect(onRefusedDragOver).toHaveBeenCalledWith(
      "ready",
      "Ready holds a single card's approved plan.",
      expect.anything(),
    );
  });

  it("clears the refusal tip once the drag leaves the refused column", async () => {
    const onRefusedDragLeave = vi.fn();
    await using screen = await render(
      <BoardColumn
        {...columnProps({
          draggedCardId: "group-2",
          dropRefusal: "Reached automatically.",
          onRefusedDragLeave,
        })}
      />,
    );
    const zone = screen.getByText("No cards").element();
    zone.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: zone }));
    expect(onRefusedDragLeave).not.toHaveBeenCalled();
    zone.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: document.body }));
    expect(onRefusedDragLeave).toHaveBeenCalledOnce();
  });

  it("accepts the drop on a column with no refusal", async () => {
    const onColumnDragOver = vi.fn((_stage: BoardStageIdType, event: { preventDefault(): void }) =>
      event.preventDefault(),
    );
    await using screen = await render(
      <BoardColumn
        {...columnProps({ draggedCardId: "card-1", dropRefusal: null, onColumnDragOver })}
      />,
    );
    const column = screen.container.querySelector("[data-board-column]")!;
    expect(column.hasAttribute("data-board-drop-refused")).toBe(false);
    expect(dragOver(screen.getByText("No cards").element())).toBe(true);
    expect(onColumnDragOver).toHaveBeenCalledOnce();
  });

  it("refuses a collapsed rail the same way", async () => {
    const onColumnDragOver = vi.fn();
    await using screen = await render(
      <BoardColumn
        {...columnProps({
          collapsed: true,
          draggedCardId: "group-2",
          dropRefusal: "Reached automatically.",
          onColumnDragOver,
        })}
      />,
    );
    const rail = screen.container.querySelector("[data-board-drop-refused]")!;
    expect(dragOver(rail)).toBe(false);
    expect(onColumnDragOver).not.toHaveBeenCalled();
  });
});

/** One sub-board column wired to the real store, as the board page wires it. */
function ScopedColumn({
  stageId,
  index,
  cards,
}: {
  readonly stageId: string;
  readonly index: number;
  readonly cards: ReadonlyArray<BoardCardShell>;
}) {
  const collapsedByStage = useBoardUiStore((state) => state.collapsedByStage);
  const setColumnCollapsed = useBoardUiStore((state) => state.setColumnCollapsed);
  const key = `sub/group-1/${stageId}`;
  const collapsed = isBoardColumnCollapsed(
    collapsedByStage,
    key,
    boardScopeColumnCollapsedByDefault({
      scope: SUB,
      stageState: STAGE_STATE,
      stageId: BoardStageId.make(stageId),
      renderedIndex: index,
      cardCount: cards.length,
    }),
  );
  return (
    <BoardColumn
      {...columnProps({
        stage: BoardStageId.make(stageId),
        label: stageId,
        cards,
        collapsed,
        onSetCollapsed: (_stage, next) => setColumnCollapsed(key, next),
      })}
    />
  );
}

function Harness() {
  return (
    <div>
      <ScopedColumn cards={[]} index={0} stageId="deferred" />
      <ScopedColumn cards={[]} index={3} stageId="planning" />
      <ScopedColumn cards={[]} index={4} stageId="ready" />
    </div>
  );
}

function setup() {
  useBoardUiStore.setState({ collapsedByStage: {} });
}

/** The stage ids drawn as full columns; the rest are rails. */
const expanded = (container: HTMLElement) =>
  [...container.querySelectorAll("[data-board-column]")].map((column) =>
    column.getAttribute("data-board-column"),
  );

describe("sub-board column auto-collapse", () => {
  it("collapses empty Deferred and pre-Ready columns, and a manual toggle sticks", async () => {
    setup();
    await using screen = await render(<Harness />);
    await vi.waitFor(() => expect(expanded(screen.container)).toEqual(["ready"]));

    // Expanding the empty Deferred rail by hand overrides the default.
    const rails = screen.container.querySelectorAll("button");
    await userEvent.click(rails[0]!);
    await vi.waitFor(() => expect(expanded(screen.container)).toEqual(["deferred", "ready"]));
    expect(useBoardUiStore.getState().collapsedByStage["sub/group-1/deferred"]).toBe(false);

    // …and so does collapsing a column that defaults open.
    await act(() => useBoardUiStore.getState().setColumnCollapsed("sub/group-1/ready", true));
    await vi.waitFor(() => expect(expanded(screen.container)).toEqual(["deferred"]));
  });

  it("opens a pre-Ready column that holds cards", () => {
    expect(
      boardScopeColumnCollapsedByDefault({
        scope: SUB,
        stageState: STAGE_STATE,
        stageId: BoardStageId.make("planning"),
        renderedIndex: 3,
        cardCount: 1,
      }),
    ).toBe(false);
  });
});

/**
 * The List view (T3O-30): indent and outdent eligibility with their reasons,
 * range selection, the drop-zone thirds, filter ancestor dimming, the
 * started-card dialog on Tab, and Tab staying with text fields.
 */
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardStageId,
  EnvironmentId,
  ProjectId,
  makeBoardCardShell,
  type BoardCardGroup,
  type BoardCardShell,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";

const commands = vi.hoisted(() => {
  const calls: Array<{ readonly label: string; readonly input: unknown }> = [];
  return {
    calls,
    setup: () => {
      calls.length = 0;
    },
  };
});

vi.mock(import("../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { readonly label: string }) => async (value: { input: unknown }) => {
    commands.calls.push({ label: command.label, input: value.input });
    return { _tag: "Success", value: undefined };
  }) as never,
}));

import { BoardListView } from "./BoardListView";

const STAGES = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };
const MOVE = "environment-data:commands:board:move-cards";

function group(overrides: Partial<BoardCardGroup> = {}): BoardCardGroup {
  return {
    target: "inherit",
    autoBuild: false,
    autoMerge: false,
    autoPlan: false,
    started: false,
    placed: BoardStageId.make("backlog"),
    prevStage: BoardStageId.make("backlog"),
    heading: false,
    integrated: false,
    ...overrides,
  };
}

function shell(
  id: string,
  stage: string,
  overrides: Partial<BoardCardShell> & { readonly parent?: string } = {},
): BoardCardShell {
  const { parent, ...rest } = overrides;
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make(id),
      key: id.toUpperCase(),
      projectId: ProjectId.make("p1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: `Card ${id}`,
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...(parent === undefined ? {} : { parentCardId: BoardCardId.make(parent) }),
    ...rest,
  };
}

function renderList(shells: ReadonlyArray<BoardCardShell>, query = "") {
  commands.setup();
  return render(
    <>
      <input aria-label="Elsewhere" />
      <BoardListView
        accentNameFor={() => null}
        attentionFor={() => null}
        environmentId={EnvironmentId.make("environment-1")}
        inScope={() => true}
        keyPrefixFor={() => "T3"}
        onOpenBoard={() => undefined}
        onOpenCard={() => undefined}
        projects={[{ id: ProjectId.make("p1"), title: "Project one" }]}
        query={query}
        scopeName="All projects"
        shells={shells}
        stages={STAGES}
      />
    </>,
  );
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-board-list-row="${id}"]`)!;

async function rowReady(id: string) {
  await vi.waitFor(() => expect(row(id)).toBeTruthy());
  return row(id);
}

const moves = () => commands.calls.filter((call) => call.label === MOVE);

describe("BoardListView", () => {
  const flat = [
    shell("a", "backlog", { orderKey: "a" }),
    shell("b", "backlog", { orderKey: "b" }),
    shell("c", "backlog", { orderKey: "c" }),
  ];

  it("explains why indent and outdent are unavailable, and indents with Tab", async () => {
    await using _screen = await renderList(flat);
    await userEvent.click(await rowReady("a"));
    const indent = page.getByRole("button", { name: /^Indent/ });
    const outdent = page.getByRole("button", { name: /^Outdent/ });
    await expect.element(indent).toHaveAttribute("aria-disabled", "true");
    await expect.element(indent).toHaveAccessibleDescription("Nothing above to indent under");
    await expect.element(outdent).toHaveAccessibleDescription("Already at the top level");

    await userEvent.click(row("b"));
    await expect.element(indent).not.toHaveAttribute("aria-disabled");
    await expect.element(indent).toHaveAccessibleDescription("Indent under A · Card a (Tab)");

    await userEvent.keyboard("{Tab}");
    await vi.waitFor(() => expect(moves()).toHaveLength(1));
    expect(moves()[0]!.input).toEqual({
      cardId: "b",
      cardIds: ["b"],
      parentCardId: "a",
    });
  });

  it("outdents with Shift+Tab to directly after the parent", async () => {
    await using _screen = await renderList([
      shell("g", "backlog", { orderKey: "a", group: group() }),
      shell("k1", "backlog", { orderKey: "a", parent: "g" }),
      shell("k2", "backlog", { orderKey: "b", parent: "g" }),
      shell("z", "backlog", { orderKey: "z" }),
    ]);
    await userEvent.click(await rowReady("k2"));
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await vi.waitFor(() => expect(moves()).toHaveLength(1));
    expect(moves()[0]!.input).toEqual({
      cardId: "k2",
      cardIds: ["k2"],
      parentCardId: null,
      afterCardId: "g",
    });
  });

  it("refuses indenting cards that don't share a parent", async () => {
    await using _screen = await renderList([
      shell("g", "backlog", { orderKey: "a", group: group() }),
      shell("k1", "backlog", { parent: "g" }),
      shell("z", "backlog", { orderKey: "z" }),
    ]);
    await userEvent.click(await rowReady("k1"));
    await userEvent.click(row("z"), { modifiers: ["ControlOrMeta"] });
    await expect
      .element(page.getByRole("button", { name: /^Indent/ }))
      .toHaveAccessibleDescription("Select cards that share a parent");
    await userEvent.keyboard("{Tab}");
    expect(moves()).toHaveLength(0);
  });

  it("selects a range with shift-click and clears it with Escape", async () => {
    await using _screen = await renderList([...flat, shell("d", "backlog", { orderKey: "d" })]);
    await userEvent.click(await rowReady("d"));
    await userEvent.click(row("b"), { modifiers: ["Shift"] });
    for (const [id, on] of [
      ["a", "false"],
      ["b", "true"],
      ["c", "true"],
      ["d", "true"],
    ] as const) {
      expect(row(id).getAttribute("aria-selected")).toBe(on);
    }
    await expect.element(page.getByText("3 selected")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(row("b").getAttribute("aria-selected")).toBe("false"));
  });

  it("keeps a double-clicked row selected", async () => {
    await using _screen = await renderList(flat);
    await userEvent.dblClick(await rowReady("b"));
    await expect.element(page.getByText("1 selected")).toBeInTheDocument();
    expect(row("b").getAttribute("aria-selected")).toBe("true");
  });

  it("with a filter on, indents under the sibling above that is still shown", async () => {
    await using _screen = await renderList(
      [
        shell("a", "backlog", { orderKey: "a", title: "Match one" }),
        shell("b", "backlog", { orderKey: "b", title: "Hidden" }),
        shell("c", "backlog", { orderKey: "c", title: "Match two" }),
      ],
      "match",
    );
    await userEvent.click(await rowReady("c"));
    await expect
      .element(page.getByRole("button", { name: /^Indent/ }))
      .toHaveAccessibleDescription("Indent under A · Match one (Tab)");
  });

  it("drops before, into or after a row by thirds, and dims the dragged subtree", async () => {
    await using _screen = await renderList([
      shell("g", "backlog", { orderKey: "a", group: group() }),
      shell("k", "backlog", { parent: "g" }),
      shell("t", "backlog", { orderKey: "b" }),
    ]);
    const source = await rowReady("g");
    const target = row("t");
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer }));
    await vi.waitFor(() => expect(row("k").hasAttribute("data-drop-blocked")).toBe(true));
    expect(row("g").hasAttribute("data-drop-blocked")).toBe(true);
    expect(target.hasAttribute("data-drop-blocked")).toBe(false);

    const rect = target.getBoundingClientRect();
    const overAt = (fraction: number) =>
      target.dispatchEvent(
        new DragEvent("dragover", {
          bubbles: true,
          cancelable: true,
          dataTransfer,
          clientY: rect.top + rect.height * fraction,
        }),
      );
    overAt(0.1);
    await vi.waitFor(() => expect(row("t").dataset.dropZone).toBe("before"));
    overAt(0.5);
    await vi.waitFor(() => expect(row("t").dataset.dropZone).toBe("into"));
    overAt(0.9);
    await vi.waitFor(() => expect(row("t").dataset.dropZone).toBe("after"));

    row("t").dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientY: rect.top + rect.height * 0.5,
      }),
    );
    await vi.waitFor(() => expect(moves()).toHaveLength(1));
    expect(moves()[0]!.input).toEqual({ cardId: "g", cardIds: ["g"], parentCardId: "t" });
  });

  it("keeps a filter match's ancestors, dimmed for context", async () => {
    await using _screen = await renderList(
      [
        shell("g", "backlog", { orderKey: "a", group: group(), title: "Billing" }),
        shell("k", "backlog", { parent: "g", title: "Invoice export" }),
        shell("o", "backlog", { orderKey: "b", title: "Other" }),
      ],
      "invoice",
    );
    const child = await rowReady("k");
    expect(row("g").hasAttribute("data-context")).toBe(true);
    expect(child.hasAttribute("data-context")).toBe(false);
    expect(row("o")).toBeNull();
  });

  it("opens the started-card dialog when Tab would nest under a started leaf", async () => {
    await using _screen = await renderList([
      shell("s", "building", { orderKey: "a" }),
      shell("x", "building", { orderKey: "b" }),
    ]);
    await userEvent.click(await rowReady("x"));
    await userEvent.keyboard("{Tab}");
    await expect.element(page.getByText("Work has started on S")).toBeInTheDocument();
    await expect.element(page.getByText("Create a shared parent")).toBeInTheDocument();
    expect(moves()).toHaveLength(0);
  });

  it("leaves Tab to a text field outside the list", async () => {
    await using _screen = await renderList(flat);
    await userEvent.click(await rowReady("b"));
    await userEvent.click(page.getByLabelText("Elsewhere"));
    await userEvent.keyboard("{Tab}");
    expect(moves()).toHaveLength(0);
  });
});

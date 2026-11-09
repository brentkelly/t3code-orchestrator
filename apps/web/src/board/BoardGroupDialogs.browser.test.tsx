/**
 * The group confirmations (T3O-29): the typed-ID gate on the dialog shell,
 * and the New phase dialog's default title and the commands it sends.
 */
import {
  BOARD_SEED_STAGES,
  BoardCardId,
  BoardStageId,
  EnvironmentId,
  ProjectId,
  makeBoardCardShell,
  type BoardCardShell,
} from "@t3tools/contracts";
import { useState } from "react";
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

import { BoardDialogShell } from "./BoardDialogShell";
import {
  BoardArchiveGroupDialog,
  BoardNewPhaseDialog,
  BoardStartedParentDialog,
  boardGroupArchiveLosses,
} from "./BoardGroupDialogs";

/** A DOM click: Base UI's modal guard intercepts Playwright's pointer inside
    a dialog opened without a trigger, as `ThreadDetailsPrRow`'s test found. */
async function press(locator: { element(): Element }) {
  await vi.waitFor(() => expect(locator.element()).toBeTruthy());
  (locator.element() as HTMLElement).click();
}

const STAGES = { cards: [], stages: BOARD_SEED_STAGES, nextCardNumberByProject: {} };
const environmentId = EnvironmentId.make("environment-1");

function shell(id: string, stage: string, overrides: Partial<BoardCardShell> = {}) {
  return {
    ...makeBoardCardShell({
      cardId: BoardCardId.make(id),
      key: id.toUpperCase(),
      projectId: ProjectId.make("project-1"),
      labelIds: [],
      stage: BoardStageId.make(stage),
      orderKey: "m",
      title: `Card ${id}`,
      blocked: false,
      dependencyCount: 0,
      hasBrief: false,
      activeThreadId: null,
    }),
    ...overrides,
  };
}

describe("BoardDialogShell typed-ID gate", () => {
  it("keeps confirm off until the card's key is typed, then Enter confirms", async () => {
    const onConfirm = vi.fn();
    await using _screen = await render(<TypedKeyDialog onConfirm={onConfirm} />);
    const confirm = page.getByRole("button", { name: "Archive group" });
    await expect.element(confirm).toBeDisabled();

    const input = page.getByLabelText("Type T3O-26 to confirm");
    await userEvent.type(input, "T3O-2{Enter}");
    expect(onConfirm).not.toHaveBeenCalled();
    await expect.element(confirm).toBeDisabled();

    await userEvent.type(input, "6");
    await expect.element(confirm).toBeEnabled();
    await userEvent.type(input, "{Enter}");
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("refuses the key in the wrong case, as the server does", async () => {
    const onConfirm = vi.fn();
    await using _screen = await render(<TypedKeyDialog onConfirm={onConfirm} />);
    await userEvent.type(page.getByLabelText("Type T3O-26 to confirm"), "t3o-26{Enter}");
    await expect.element(page.getByRole("button", { name: "Archive group" })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

function TypedKeyDialog({ onConfirm }: { readonly onConfirm: () => void }) {
  const [typed, setTyped] = useState("");
  return (
    <BoardDialogShell
      confirmDanger
      confirmLabel="Archive group"
      onConfirm={onConfirm}
      onOpenChange={() => undefined}
      open
      title="Archive T3O-26?"
      typedKey={{ key: "T3O-26", value: typed, onChange: setTyped }}
    />
  );
}

describe("BoardNewPhaseDialog", () => {
  const renderPhase = (title: string) => {
    const group = shell("g-1", "planning", {
      title,
      group: {
        target: "inherit",
        autoBuild: false,
        autoMerge: false,
        autoPlan: false,
        started: false,
        placed: BoardStageId.make("planning"),
        prevStage: null,
        heading: false,
        integrated: false,
      },
    });
    const shells = [
      group,
      shell("c-1", "deferred", { parentCardId: group.cardId }),
      shell("c-2", "deferred", { parentCardId: group.cardId }),
      shell("c-3", "ready", { parentCardId: group.cardId }),
    ];
    return render(
      <BoardNewPhaseDialog
        environmentId={environmentId}
        group={group}
        keyPrefix="EVT"
        onClose={() => undefined}
        onOpenBoard={() => undefined}
        shells={shells}
        stages={STAGES}
      />,
    );
  };

  it("names the first stage even when the parent group has its own branch", async () => {
    commands.setup();
    const ownGroup = {
      target: "own" as const,
      autoBuild: false,
      autoMerge: false,
      autoPlan: false,
      started: false,
      placed: BoardStageId.make("planning"),
      prevStage: null,
      heading: false,
      integrated: false,
    };
    const parent = shell("p-1", "planning", { group: ownGroup });
    const group = shell("g-1", "ready", {
      title: "Event log",
      parentCardId: parent.cardId,
      group: { ...ownGroup, target: "inherit" },
    });
    const shells = [parent, group, shell("c-1", "deferred", { parentCardId: group.cardId })];
    await using _screen = await render(
      <BoardNewPhaseDialog
        environmentId={environmentId}
        group={group}
        keyPrefix="EVT"
        onClose={() => undefined}
        onOpenBoard={() => undefined}
        shells={shells}
        stages={STAGES}
      />,
    );
    await expect.element(page.getByText(/in the Backlog of P-1\./)).toBeInTheDocument();
    await press(page.getByRole("button", { name: "Create phase with 1" }));
    await vi.waitFor(() => expect(commands.calls.length).toBeGreaterThan(0));
    expect(commands.calls[0]!.input).toMatchObject({ heading: true, stage: "backlog" });
  });

  it("pre-fills `‹Group›: Phase 2` and ticks every deferred card", async () => {
    commands.setup();
    await using _screen = await renderPhase("Event log");
    await expect.element(page.getByLabelText("Phase title")).toHaveValue("Event log: Phase 2");
    await expect.element(page.getByRole("checkbox", { name: /C-1/ })).toBeChecked();
    await expect.element(page.getByRole("checkbox", { name: /C-2/ })).toBeChecked();
    await expect.element(page.getByText("C-3")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Create phase with 2" })).toBeEnabled();
  });

  it("increments a title that already names its phase", async () => {
    commands.setup();
    await using _screen = await renderPhase("Event log: Phase 2");
    await expect.element(page.getByLabelText("Phase title")).toHaveValue("Event log: Phase 3");
  });

  it("needs a ticked card and creates the heading, then moves the ticked cards into Backlog", async () => {
    commands.setup();
    await using _screen = await renderPhase("Event log");
    await press(page.getByRole("checkbox", { name: /C-1/ }));
    await press(page.getByRole("checkbox", { name: /C-2/ }));
    await expect.element(page.getByRole("button", { name: "Create phase with 0" })).toBeDisabled();
    await press(page.getByRole("checkbox", { name: /C-2/ }));
    await press(page.getByRole("button", { name: "Create phase with 1" }));
    // One command: the heading, its cards and their landing stage decide together.
    await vi.waitFor(() => expect(commands.calls).toHaveLength(1));
    const [create] = commands.calls;
    expect(create!.label).toContain("create-card");
    expect(create!.input).toMatchObject({
      title: "Event log: Phase 2",
      heading: true,
      stage: "backlog",
      keyPrefix: "EVT",
      adoptCardIds: ["c-2"],
      adoptStage: "backlog",
    });
  });
});

describe("BoardStartedParentDialog", () => {
  const started = shell("t3o-40", "building", { key: "T3O-40", hasPr: true });
  const moving = [shell("t3o-41", "backlog", { key: "T3O-41" })];
  const renderStarted = () =>
    render(
      <BoardStartedParentDialog
        environmentId={environmentId}
        keyPrefix="T3O"
        moving={moving}
        onClose={() => undefined}
        stages={STAGES}
        started={started}
      />,
    );

  it("defaults to a shared parent, which needs a title and keeps the work", async () => {
    commands.setup();
    await using _screen = await renderStarted();
    const create = page.getByRole("button", { name: "Create parent" });
    await expect.element(create).toBeDisabled();
    await userEvent.type(page.getByLabelText("New parent's title"), "Event log overhaul");
    await press(create);
    await vi.waitFor(() => expect(commands.calls).toHaveLength(1));
    expect(commands.calls[0]!.input).toMatchObject({
      title: "Event log overhaul",
      heading: true,
      adoptCardIds: ["t3o-40", "t3o-41"],
    });
  });

  it("gates cancelling the work behind the typed key, and keeps the branch", async () => {
    commands.setup();
    await using _screen = await renderStarted();
    await press(page.getByRole("radio", { name: /Cancel work on T3O-40/ }));
    await expect
      .element(page.getByText(/branch is kept until its worktree is reclaimed/))
      .toBeInTheDocument();
    await expect.element(page.getByText("Its pull request will be closed")).toBeInTheDocument();
    const confirm = page.getByRole("button", { name: "Cancel work and make it the parent" });
    await expect.element(confirm).toBeDisabled();
    await userEvent.type(page.getByLabelText("Type T3O-40 to confirm"), "t3o-40");
    // The server compares the key exactly, so a lowercase key must not confirm.
    await expect.element(confirm).toBeDisabled();
    await userEvent.clear(page.getByLabelText("Type T3O-40 to confirm"));
    await userEvent.type(page.getByLabelText("Type T3O-40 to confirm"), "T3O-40");
    await press(confirm);
    await vi.waitFor(() => expect(commands.calls).toHaveLength(1));
    expect(commands.calls[0]!.label).toContain("cancel-card-work");
    expect(commands.calls[0]!.input).toMatchObject({
      cardId: "t3o-40",
      confirmCardKey: "T3O-40",
      adoptCardIds: ["t3o-41"],
    });
  });
});

describe("BoardArchiveGroupDialog", () => {
  it("lists what is lost and archives only once the key is typed", async () => {
    const group = shell("g-1", "building", {
      key: "T3O-26",
      group: {
        target: "own",
        autoBuild: true,
        autoMerge: false,
        autoPlan: false,
        started: true,
        placed: BoardStageId.make("planning"),
        prevStage: null,
        heading: false,
        integrated: false,
      },
    });
    const shells = [
      group,
      shell("c-1", "building", { key: "T3O-27", parentCardId: group.cardId, hasPr: true }),
      shell("c-2", "deferred", { key: "T3O-28", parentCardId: group.cardId }),
    ];
    expect(boardGroupArchiveLosses(shells, STAGES, group)).toEqual([
      "1 building now, whose threads stop: T3O-27",
      "1 pull request closed: T3O-27",
      "Branches deleted, remote copies included: board/t3o-26, board/t3o-27",
    ]);
    // A nested own-branch group's integration branch goes too, so it is listed.
    const nested = shell("g-2", "building", {
      key: "T3O-29",
      parentCardId: group.cardId,
      group: { ...group.group!, started: true },
    });
    expect(boardGroupArchiveLosses([...shells, nested], STAGES, group).at(-1)).toBe(
      "Branches deleted, remote copies included: board/t3o-26, board/t3o-27, board/t3o-29",
    );
    // A leaf already in Done had its branch reclaimed after merge, so it is not listed.
    const merged = shell("c-3", "done", { key: "T3O-30", parentCardId: group.cardId });
    expect(boardGroupArchiveLosses([...shells, merged], STAGES, group).at(-1)).toBe(
      "Branches deleted, remote copies included: board/t3o-26, board/t3o-27",
    );
    const onConfirm = vi.fn();
    await using _screen = await render(
      <BoardArchiveGroupDialog
        group={group}
        onClose={() => undefined}
        onConfirm={onConfirm}
        shells={shells}
        stages={STAGES}
      />,
    );
    await expect.element(page.getByText(/all 2 cards inside it/)).toBeInTheDocument();
    await expect.element(page.getByText(/but not the work on their branches/)).toBeInTheDocument();
    const archive = page.getByRole("button", { name: "Archive group" });
    await expect.element(archive).toBeDisabled();
    await userEvent.type(page.getByLabelText("Type T3O-26 to confirm"), "T3O-26");
    await press(archive);
    expect(onConfirm).toHaveBeenCalledWith("T3O-26");
  });
});

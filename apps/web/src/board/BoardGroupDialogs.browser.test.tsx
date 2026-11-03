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
import { BoardNewPhaseDialog } from "./BoardGroupDialogs";

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

  it("accepts the key in any case", async () => {
    const onConfirm = vi.fn();
    await using _screen = await render(<TypedKeyDialog onConfirm={onConfirm} />);
    await userEvent.type(page.getByLabelText("Type T3O-26 to confirm"), "t3o-26");
    await press(page.getByRole("button", { name: "Archive group" }));
    expect(onConfirm).toHaveBeenCalledOnce();
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
        onClose={() => undefined}
        onOpenBoard={() => undefined}
        shells={shells}
        stages={STAGES}
      />,
    );
  };

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
    await vi.waitFor(() => expect(commands.calls).toHaveLength(3));
    const [create, moveCards, move] = commands.calls;
    expect(create!.label).toContain("create-card");
    expect(create!.input).toMatchObject({
      title: "Event log: Phase 2",
      heading: true,
      stage: "backlog",
      keyPrefix: "G",
    });
    expect(moveCards!.input).toMatchObject({ cardIds: ["c-2"] });
    expect(move!.input).toMatchObject({ cardId: "c-2", toStage: "backlog" });
  });
});

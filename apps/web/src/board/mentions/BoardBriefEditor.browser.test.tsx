import { EnvironmentId, type BoardCardId, type ProjectId } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { BoardBriefEditor } from "./BoardBriefEditor";
import { matchBoardCardMentions } from "./boardCardMentions";

const CARD_ID = "0b9a2c1e-4d5f-4a6b-8c7d-9e0f1a2b3c4d" as BoardCardId;
const PROJECT = "project-1" as ProjectId;
const CARDS = [
  { cardId: CARD_ID, key: "T3O-58", title: "Review round one", projectId: PROJECT },
  {
    cardId: "11111111-2222-4333-8444-555555555555" as BoardCardId,
    key: "T3O-5",
    title: "Older card",
    projectId: PROJECT,
  },
  {
    cardId: "22222222-3333-4444-8555-666666666666" as BoardCardId,
    key: "T3O-90",
    title: "Review tooling",
    projectId: "project-2" as ProjectId,
  },
];

vi.mock("~/board/mentions/boardCardMentionState", async () => {
  const { useContext } = await import("react");
  const { BoardCardMentionProjectContext } = await import("./boardCardMentionProject");
  return {
    useBoardCardMentionItems: (input: { active: boolean; query: string }) => {
      const currentProjectId = useContext(BoardCardMentionProjectContext);
      return input.active
        ? matchBoardCardMentions({ cards: CARDS, currentProjectId, query: input.query }).map(
            (card) => ({
              id: `card:${card.cardId}`,
              type: "card",
              cardId: card.cardId,
              key: card.key,
              projectId: card.projectId,
              accent: null,
              label: card.title,
              description: "T3o",
            }),
          )
        : [];
    },
    useBoardCardMentionSummary: (cardId: string | null) => {
      const card = CARDS.find((candidate) => candidate.cardId === cardId);
      return card ? { ...card, projectName: "T3o", accent: null, stageLabel: "Building" } : null;
    },
  };
});

vi.mock("~/board/useBoardEnvironmentId", () => ({
  useBoardSettings: () => ({}),
  useBoardServerProviders: () => [],
  useBoardEnvironmentId: () => null,
}));

const modEnter = /Mac/.test(navigator.platform)
  ? "{Meta>}{Enter}{/Meta}"
  : "{Control>}{Enter}{/Control}";

function Harness(props: {
  initial: string;
  onChange: (value: string) => void;
  onEscape: () => boolean;
  onModEnter: () => void;
  onBlur: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <BoardBriefEditor
      ariaLabel="Brief"
      autoFocus
      environmentId={EnvironmentId.make("env-board")}
      onChange={(next) => {
        setValue(next);
        props.onChange(next);
      }}
      onEscape={props.onEscape}
      onModEnter={props.onModEnter}
      onBlur={props.onBlur}
      onPaste={() => {}}
      placeholder="Describe the task"
      projectId={PROJECT}
      value={value}
    />
  );
}

async function renderEditor(initial = "") {
  const onChange = vi.fn<(value: string) => void>();
  const onEscape = vi.fn(() => true);
  const onModEnter = vi.fn();
  const onBlur = vi.fn();
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <Harness
        initial={initial}
        onBlur={onBlur}
        onChange={onChange}
        onEscape={onEscape}
        onModEnter={onModEnter}
      />,
    ),
  );
  await expect.element(screen.getByRole("textbox", { name: "Brief" })).toHaveFocus();
  const environment = stack.move();
  return Object.assign(screen, {
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    onChange,
    onEscape,
    onModEnter,
    onBlur,
  });
}

describe("BoardBriefEditor", () => {
  it("lists a matching card first and inserts its chip on Enter", async () => {
    await using screen = await renderEditor("See ");
    const { onChange } = screen;
    await userEvent.keyboard("@T3O");
    // The menu portals out of the render container.
    const options = page.getByRole("option");
    await expect.element(options.first()).toHaveTextContent("T3O-58Review round oneT3o");
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith(
        `See [T3O-58 · Review round one](t3-context://v1/card/card_${CARD_ID}) `,
      ),
    );
    const chip = screen.getByRole("link", { name: "Card, T3O-58 Review round one" });
    await expect.element(chip).toHaveTextContent("T3O-58Review round one");
  });

  it("commits the draft before a chip's link navigates away", async () => {
    await using screen = await renderEditor(
      `See [T3O-58 · Review round one](t3-context://v1/card/card_${CARD_ID}) `,
    );
    const { onBlur } = screen;
    await screen.getByRole("link", { name: "Card, T3O-58 Review round one" }).click();
    expect(onBlur).toHaveBeenCalledTimes(1);
  });

  it("ranks the brief's own project's cards first", async () => {
    await using _screen = await renderEditor();
    await userEvent.keyboard("@review");
    const options = page.getByRole("option");
    await expect.element(options.nth(0)).toHaveTextContent("T3O-58Review round oneT3o");
    await expect.element(options.nth(1)).toHaveTextContent("T3O-90Review toolingT3o");
  });

  it("closes the menu on Escape before handing Escape to the brief", async () => {
    await using screen = await renderEditor();
    const { onEscape } = screen;
    await userEvent.keyboard("@58");
    await expect.element(page.getByRole("option").first()).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("option").first()).not.toBeInTheDocument();
    expect(onEscape).not.toHaveBeenCalled();
    await userEvent.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("hands Cmd/Ctrl+Enter to onModEnter without a newline", async () => {
    await using screen = await renderEditor("Done");
    const { onChange, onModEnter } = screen;
    await userEvent.keyboard(modEnter);
    expect(onModEnter).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });
});

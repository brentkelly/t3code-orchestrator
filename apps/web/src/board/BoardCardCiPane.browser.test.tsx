import { BoardCardId, EnvironmentId, type BoardCardCi, type BoardCiPass } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import "../index.css";

import { BoardCardCiPane } from "./BoardCardCiPane";

const TAIL = "error[E0425]: cannot find value `slot`\n --> infra/relay/src/fanout.rs:7:5\n";

const pass: BoardCiPass = {
  runId: "run-1",
  cardId: BoardCardId.make("card-1"),
  entry: 1,
  ordinal: 1,
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: null,
  outcome: null,
  snapshot: null,
  configVersion: null,
  steps: [
    {
      name: "Typecheck",
      command: "bun run typecheck",
      timeoutMinutes: 30,
      status: "passed",
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:46.000Z",
      exitCode: 0,
      tail: "",
    },
    {
      name: "Check",
      command: "cargo xtask check",
      timeoutMinutes: 30,
      status: "failed",
      startedAt: "2026-01-01T00:00:46.000Z",
      finishedAt: "2026-01-01T00:02:50.000Z",
      exitCode: 101,
      tail: TAIL,
    },
  ],
  logDir: ".t3/ci/run-1",
  fixThreadId: null,
};

const ci: BoardCardCi = {
  runId: "run-1",
  entry: 1,
  fixAttempts: 0,
  maxFixAttempts: 2,
  phase: "running",
  steps: pass.steps.map(({ name, status, startedAt, finishedAt }) => ({
    name,
    status,
    startedAt,
    finishedAt,
  })),
};

describe("BoardCardCiPane", () => {
  it("expands and collapses a failed step's output tail", async () => {
    await using screen = await render(
      <BoardCardCiPane
        activeThreadId={null}
        cardId={BoardCardId.make("card-1")}
        cardKey="RL-16"
        environmentId={EnvironmentId.make("env-1")}
        ci={ci}
        inCi
        lastOutcome={null}
        onBackToThread={() => {}}
        onOpenThread={() => {}}
        passes={[pass]}
      />,
    );
    // The current pass opens its failure's tail by default.
    await expect.element(screen.getByLabelText("Check output")).toBeVisible();
    await expect
      .element(screen.getByText("Output tail · last 200 lines (2 captured)"))
      .toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Hide output" }));
    await expect.element(screen.getByLabelText("Check output")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Show output" }));
    const output = screen.getByLabelText("Check output");
    await expect.element(output).toBeVisible();
    expect(output.element().textContent).toContain("cannot find value `slot`");
  });

  it("asks before skipping CI, and skips only on the confirming button", async () => {
    const onSkipCi = vi.fn();
    await using screen = await render(
      <BoardCardCiPane
        activeThreadId={null}
        cardId={BoardCardId.make("card-1")}
        cardKey="RL-16"
        environmentId={EnvironmentId.make("env-1")}
        ci={ci}
        inCi
        lastOutcome={null}
        onBackToThread={() => {}}
        onOpenThread={() => {}}
        onSkipCi={onSkipCi}
        passes={[pass]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Skip CI…" }));
    await expect.element(screen.getByRole("group", { name: "Skip CI for RL-16?" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Keep running" }));
    await expect
      .element(screen.getByRole("group", { name: "Skip CI for RL-16?" }))
      .not.toBeInTheDocument();
    expect(onSkipCi).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Skip CI…" }));
    await userEvent.click(
      screen.getByRole("button", { name: "Skip CI and move to Ready for merge" }),
    );
    expect(onSkipCi).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByRole("button", { name: "Skip CI…" })).toBeVisible();
  });
});

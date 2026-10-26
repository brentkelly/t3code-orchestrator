import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import type { BoardEnvironmentResolution } from "../../board/useBoardEnvironmentId";
import { visitElements } from "../../test/reactElementTree";

const board = vi.hoisted(() => ({
  resolution: { kind: "none" } as BoardEnvironmentResolution,
}));
vi.mock("../../board/useBoardEnvironmentId", () => ({
  useBoardEnvironment: () => board.resolution,
  useBoardEnvironmentId: () => null,
  useBoardServerProviders: () => [],
  useBoardSettings: () => {
    throw new Error("board settings read without a board server");
  },
  useUpdateBoardSettings: () => () => undefined,
}));

import { BoardSettingsPanel } from "./BoardSettingsPanel";

const environmentId = EnvironmentId.make("env-central");
/** Whether the panel renders the board server's own settings sections. */
const showsBoardSettings = () =>
  visitElements(
    BoardSettingsPanel(),
    (element) =>
      typeof element.type === "function" && element.type.name === "BoardSettingsSections",
  ) !== null;

beforeEach(() => {
  board.resolution = { kind: "none" };
});

it("shows the board server's settings once it resolves", () => {
  board.resolution = { kind: "ready", environmentId, nominated: true };
  expect(showsBoardSettings()).toBe(true);
});

it("hides the settings sections while the nominated board server is unavailable", () => {
  // Rendering them would show defaults and drop every edit (T3O-71 review r1-i2).
  board.resolution = { kind: "unavailable", environmentId, label: "Central" };
  expect(showsBoardSettings()).toBe(false);
});

it("hides the settings sections before any environment connects", () => {
  expect(showsBoardSettings()).toBe(false);
});

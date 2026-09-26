import type { ProjectIconOverride } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useRef: reactHookHarness.useRef,
    useEffect: () => undefined,
    useMemo: reactHookHarness.useMemo,
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

import { ProjectIconPickerDialog } from "./ProjectIconPickerDialog";

const onSelect = vi.fn<(icon: ProjectIconOverride) => void>();

/** Calls the dialog as a plain function, so state survives across renders. */
function render(current: ProjectIconOverride | null = null) {
  hooks.beginRender();
  return ProjectIconPickerDialog({
    current,
    projectName: "Test",
    open: true,
    onOpenChange: () => {},
    onSelect,
  });
}
type Tree = ReturnType<typeof render>;

function find(tree: Tree, label: string, describe: (props: Record<string, unknown>) => boolean) {
  const node = visitElements(tree, (element) => describe(element.props));
  if (!node) throw new Error(`Missing ${label}`);
  return node.props;
}
function byAriaLabel(tree: Tree, label: string) {
  return find(tree, label, (props) => props["aria-label"] === label);
}
function hexField(tree: Tree) {
  return byAriaLabel(tree, "Hex color") as {
    value: string;
    "aria-invalid": boolean;
    "aria-describedby": string;
    onChange: (event: { currentTarget: { value: string } }) => void;
  };
}
function hexHint(tree: Tree) {
  const node = visitElements(tree, (element) => element.props.id === "project-icon-hex-hint");
  return node?.props.children;
}
function saveButton(tree: Tree) {
  return find(tree, "Save icon button", (props) => props.children === "Save icon") as {
    disabled: boolean;
    onClick: () => void;
  };
}
function modeGroup(tree: Tree) {
  return byAriaLabel(tree, "Icon type") as { onValueChange: (next: readonly string[]) => void };
}
function typeHex(value: string) {
  hexField(render()).onChange({ currentTarget: { value } });
}

beforeEach(() => {
  hooks.reset();
  onSelect.mockReset();
});

it("blocks saving an unparseable hex and saves the normalised one once it parses", () => {
  expect(saveButton(render()).disabled).toBe(false);

  typeHex("#12");
  let tree = render();
  expect(hexField(tree)["aria-invalid"]).toBe(true);
  expect(hexHint(tree)).toContain("Enter a hex color");
  expect(saveButton(tree).disabled).toBe(true);
  saveButton(tree).onClick();
  expect(onSelect).not.toHaveBeenCalled();

  typeHex("#ABC");
  tree = render();
  expect(hexField(tree)["aria-invalid"]).toBe(false);
  expect(hexHint(tree)).toContain("Or pick any color");
  expect(saveButton(tree).disabled).toBe(false);
  saveButton(tree).onClick();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith({
    kind: "lucide",
    name: "folder-code",
    color: "#aabbcc",
  });
});

it("still saves in emoji mode while the hidden hex draft is unparseable", () => {
  typeHex("nope");
  modeGroup(render()).onValueChange(["emoji"]);

  const tree = render();
  expect(visitElements(tree, (element) => element.props["aria-label"] === "Hex color")).toBeNull();
  expect(saveButton(tree).disabled).toBe(false);
  saveButton(tree).onClick();
  expect(onSelect).toHaveBeenCalledExactlyOnceWith({ kind: "emoji", emoji: "💻" });
});

it("keeps blocking save in monogram mode when the hex is unparseable", () => {
  typeHex("#12");
  modeGroup(render()).onValueChange(["monogram"]);

  const tree = render();
  expect(saveButton(tree).disabled).toBe(true);
  saveButton(tree).onClick();
  expect(onSelect).not.toHaveBeenCalled();
});

it("opens a project holding a retired colour name on its mapped palette hex", () => {
  const tree = render({ kind: "lucide", name: "folder-code", color: "violet" });

  expect(hexField(tree).value).toBe("#7b5fa8");
  expect(hexField(tree)["aria-invalid"]).toBe(false);
  const swatch = visitElements(
    tree,
    (element) => element.props["aria-label"] === "Muted violet",
  ) as ReactElement<{ "aria-pressed": boolean }> | null;
  expect(swatch?.props["aria-pressed"]).toBe(true);
});

it("shows icons first and offers the colour row for an automatic project", () => {
  const tree = render();

  expect((byAriaLabel(tree, "Icon type") as { value: readonly string[] }).value).toEqual(["lucide"]);
  expect(byAriaLabel(tree, "Icon color")).toBeDefined();
  expect(byAriaLabel(tree, "Custom color")).toBeDefined();
});

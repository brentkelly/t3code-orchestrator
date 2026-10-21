// @vitest-environment jsdom

import type { Editor } from "@tiptap/core";
import { act, createRef, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { serializeEditorDoc } from "~/composer-rich-text-doc";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "./ComposerPromptEditor";

const destroyed: Editor[] = [];

// useEditor destroys its first editor when the mount takes longer than 1 ms to
// commit. Reproduce that window deterministically: destroy the first editor in
// a layout effect that runs after render and before the composer's own layout
// effects, exactly where the 1 ms timeout lands on a slow commit.
vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditor: (...args: Parameters<typeof actual.useEditor>) => {
      const editor = actual.useEditor(...args);
      useLayoutEffect(() => {
        if (editor && destroyed.length === 0) {
          destroyed.push(editor);
          editor.destroy();
        }
      }, [editor]);
      return editor;
    },
  };
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  destroyed.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("survives an editor destroyed between render and commit, then applies the value to its replacement", async () => {
  await act(async () =>
    root.render(
      <ComposerPromptEditor
        editorRef={createRef<ComposerPromptEditorHandle>()}
        value="hello **world**"
        cursor={5}
        richTextEnabled
        contextRecords={new Map()}
        skills={[]}
        disabled={false}
        placeholder=""
        onChange={() => {}}
        onPaste={() => {}}
      />,
    ),
  );

  expect(destroyed).toHaveLength(1);
  const element = container.querySelector<HTMLElement & { editor: Editor }>(".tiptap");
  if (!element) throw new Error("Composer did not mount a replacement editor");
  const editor = element.editor;
  expect(editor).not.toBe(destroyed[0]);
  expect(editor.isDestroyed).toBe(false);
  expect(serializeEditorDoc(editor.state.doc).value).toBe("hello **world**");
  expect(editor.state.selection.from).toBe(6);
});

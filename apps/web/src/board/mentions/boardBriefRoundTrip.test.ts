import { getSchemaByResolvedExtensions, Node, resolveExtensions } from "@tiptap/core";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import { buildDocJson, serializeEditorDoc } from "../../composer-rich-text-doc";

function stubAtom(name: string, attrs: Record<string, { default: unknown }>) {
  return Node.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => attrs,
  });
}

// The brief editor's plain mode: no block or mark extensions, only the chip atoms.
const schema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
      italic: false,
      bold: false,
      strike: false,
    }),
    stubAtom("composer-mention", { path: { default: "" }, source: { default: "" } }),
    stubAtom("composer-skill", {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    }),
    stubAtom("composer-model", {
      instanceId: { default: "" },
      model: { default: "" },
      source: { default: "" },
    }),
    stubAtom("composer-citation", {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    }),
    stubAtom("composer-context-reference", {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    }),
  ]),
);

function plainRoundTrip(value: string) {
  const doc = ProseMirrorNode.fromJSON(
    schema,
    buildDocJson(value, (name) => ({ label: name, description: null }), { styling: false }),
  );
  doc.check();
  return serializeEditorDoc(doc);
}

// Agents write briefs with section end markers and Markdown the editor must not rewrite.
const BRIEFS: ReadonlyArray<readonly [string, string]> = [
  [
    "section end markers and comments",
    "## Plan\nDo it.\n<!-- end ## Plan -->\n\n<!-- a note -->\n## Notes\n<!-- end ## Notes -->",
  ],
  ["a GFM table", "| Step | State |\n| --- | :-: |\n| one | `done` |\n| two | *wip* |"],
  ["runs of blank lines", "first\n\n\n\nsecond\n\n\n"],
  ["a trailing newline", "ends with one\n"],
  ["no trailing newline", "ends with none"],
  [
    "nested, ordered and task lists",
    "- outer\n  - inner\n    1. deep\n1. one\n2. two\n- [ ] todo\n- [x] done",
  ],
  ["code fences", "```ts\nconst a_b = c_d * 2;\n```\n~~~\nraw\n~~~"],
  ["underscores and emphasis", "/_astro/Page.a_.css and | |_____^ and __init__ and *star*"],
  ["mentions, skills and commands", "see @apps/web/src/a.ts, use $frontend-design and /review now"],
  [
    "context tokens",
    "[T3O-58 · Fix login](t3-context://v1/card/card_0b9a2c1e-4d5f-4a6b-8c7d-9e0f1a2b3c4d) and [Old thread](t3-context://v1/thread/thread_abc) on [laptop](t3-context://v1/environment/environment_e1)",
  ],
  ["a hard tab and trailing spaces", "\tindented  \nline"],
];

describe("brief round trip in plain mode", () => {
  it.each(BRIEFS)("keeps %s byte for byte", (_name, brief) => {
    expect(plainRoundTrip(brief).value).toBe(brief);
  });

  it("draws context tokens as chips, not text", () => {
    const [, brief] = BRIEFS.find(([name]) => name === "context tokens")!;
    const chips = plainRoundTrip(brief).runs.filter(
      (run) => run.nodeName === "composer-context-reference",
    );
    expect(chips).toHaveLength(3);
  });
});

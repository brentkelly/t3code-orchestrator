import { describe, expect, it } from "@effect/vitest";

import { applyBoardPlanEdits, type BoardPlanEdit } from "./planEdits.ts";

const PLAN = [
  "# Plan",
  "",
  "## Design",
  "Use a tool.",
  "",
  "### Details",
  "Flat schema.",
  "",
  "## Rollout",
  "Ship it.",
  "",
  "## Tests",
  "Table driven.",
  "",
].join("\n");

const FENCED = [
  "## Steps",
  "Run:",
  "```sh",
  "# Rollout",
  "## Rollout",
  "```",
  "~~~",
  "## Rollout",
  "~~~",
  "Done.",
  "",
  "## Rollout",
  "Ship it.",
  "",
].join("\n");

type Case = {
  readonly name: string;
  readonly body?: string;
  readonly edits: ReadonlyArray<BoardPlanEdit>;
  readonly expected: string | { readonly error: string };
};

const cases: ReadonlyArray<Case> = [
  // Text edits
  {
    name: "replaces one exact occurrence",
    edits: [{ old_text: "Ship it.", new_text: "Ship it behind a flag." }],
    expected: PLAN.replace("Ship it.", "Ship it behind a flag."),
  },
  {
    name: "reports old_text that is not there",
    edits: [{ old_text: "Nope.", new_text: "x" }],
    expected: { error: "edits[0]: old_text not found" },
  },
  {
    name: "hints at a match that differs only in whitespace",
    edits: [{ old_text: "Use  a\ntool.", new_text: "x" }],
    expected: {
      error:
        "edits[0]: old_text not found; a match exists that differs only in whitespace, copy it exactly from board_get_plan",
    },
  },
  {
    name: "refuses an ambiguous old_text with its count",
    body: "a x\nb x\nc x\n",
    edits: [{ old_text: "x", new_text: "y" }],
    expected: {
      error: "edits[0]: old_text matches 3 times; include more surrounding text or set replace_all",
    },
  },
  {
    name: "replaces every occurrence with replace_all",
    body: "a x\nb x\n",
    edits: [{ old_text: "x", new_text: "y", replace_all: true }],
    expected: "a y\nb y\n",
  },
  {
    name: "inserts $& and $1 in new_text literally",
    body: "cost: N\n",
    edits: [{ old_text: "N", new_text: "$& and $1" }],
    expected: "cost: $& and $1\n",
  },
  {
    name: "normalises a CRLF body and CRLF inputs",
    body: "one\r\ntwo\r\nthree\r\n",
    edits: [{ old_text: "one\r\ntwo", new_text: "1\r\n2" }],
    expected: "1\n2\nthree\n",
  },

  // Section edits
  {
    name: "replaces a middle section up to the next same-level heading",
    edits: [{ section: "## Rollout", new_text: "## Rollout\nShip it slowly.\n\n" }],
    expected: PLAN.replace("## Rollout\nShip it.\n\n", "## Rollout\nShip it slowly.\n\n"),
  },
  {
    name: "replaces the last section up to the end",
    edits: [{ section: "## Tests", new_text: "## Tests\nProperty based.\n" }],
    expected: PLAN.replace("## Tests\nTable driven.\n", "## Tests\nProperty based.\n"),
  },
  {
    name: "keeps ### content inside its ## parent",
    edits: [{ section: "## Design", new_text: "## Design\nRewritten.\n\n" }],
    expected: PLAN.replace(
      "## Design\nUse a tool.\n\n### Details\nFlat schema.\n\n",
      "## Design\nRewritten.\n\n",
    ),
  },
  {
    name: "stops a ### section at the next higher-level heading",
    edits: [{ section: "### Details", new_text: "### Details\nUnion schema.\n\n" }],
    expected: PLAN.replace("Flat schema.", "Union schema."),
  },
  {
    name: "renames a section and changes its level",
    edits: [{ section: "### Details", new_text: "## Detail notes\nFlat schema.\n\n" }],
    expected: PLAN.replace("### Details", "## Detail notes"),
  },
  {
    name: "deletes a section with an empty new_text",
    edits: [{ section: "## Rollout", new_text: "" }],
    expected: PLAN.replace("## Rollout\nShip it.\n\n", ""),
  },
  {
    name: "keeps one blank line before the next heading however new_text ends",
    edits: [{ section: "## Rollout", new_text: "## Rollout\nShip it slowly." }],
    expected: PLAN.replace("## Rollout\nShip it.\n\n", "## Rollout\nShip it slowly.\n\n"),
  },
  {
    name: "collapses extra trailing blank lines before the next heading",
    edits: [{ section: "## Rollout", new_text: "## Rollout\nShip it slowly.\n\n\n\n" }],
    expected: PLAN.replace("## Rollout\nShip it.\n\n", "## Rollout\nShip it slowly.\n\n"),
  },
  {
    name: "matches a heading despite trailing whitespace and a closing sequence",
    body: "## Rollout ##  \nShip it.\n## Tests\nx\n",
    edits: [{ section: "## Rollout   ", new_text: "## Rollout\nShip.\n" }],
    expected: "## Rollout\nShip.\n\n## Tests\nx\n",
  },
  {
    name: "treats the # level as part of the match",
    edits: [{ section: "### Rollout", new_text: "### Rollout\nx" }],
    expected: {
      error:
        'edits[0]: no heading "### Rollout"; headings are: # Plan, ## Design, ### Details, ## Rollout, ## Tests',
    },
  },
  {
    name: "refuses a duplicate heading as ambiguous",
    body: "## A\n### Tests\nx\n## B\n### Tests\ny\n",
    edits: [{ section: "### Tests", new_text: "### Tests\nz\n" }],
    expected: {
      error: 'edits[0]: heading "### Tests" appears 2 times; use a text edit with more context',
    },
  },
  {
    name: "keeps a section whole across an indented # line in its body",
    body: "## Steps\n- build:\n\n        # build first\n        make\n\nAfter.\n\n## Rollout\nShip it.\n",
    edits: [{ section: "## Steps", new_text: "## Steps\nNone.\n" }],
    expected: "## Steps\nNone.\n\n## Rollout\nShip it.\n",
  },
  {
    name: "ends the plan with one newline when the last section's new_text lacks one",
    edits: [{ section: "## Tests", new_text: "## Tests\nProperty based." }],
    expected: PLAN.replace("## Tests\nTable driven.\n", "## Tests\nProperty based.\n"),
  },
  {
    name: "drops the blank separator line when deleting the last section",
    edits: [{ section: "## Tests", new_text: "" }],
    expected: PLAN.replace("\n## Tests\nTable driven.\n", ""),
  },
  {
    name: "refuses a multi-line section value",
    edits: [{ section: "## Rollout\nShip it.", new_text: "## Rollout\nx\n" }],
    expected: { error: 'edits[0]: section must be a markdown heading line like "## Name"' },
  },
  {
    name: "refuses a section value that is not a heading",
    edits: [{ section: "Rollout", new_text: "x" }],
    expected: { error: 'edits[0]: section must be a markdown heading line like "## Name"' },
  },
  {
    name: "refuses a new_text that does not start with a heading",
    edits: [{ section: "## Rollout", new_text: "Ship it slowly." }],
    expected: {
      error:
        'edits[0]: new_text must start with the section\'s heading line, e.g. "## Rollout"; use "" to delete the section',
    },
  },
  {
    name: "ignores # lines inside ``` and ~~~ fences as targets and as boundaries",
    body: FENCED,
    edits: [{ section: "## Steps", new_text: "## Steps\nNone.\n\n" }],
    expected: "## Steps\nNone.\n\n## Rollout\nShip it.\n",
  },
  {
    name: "finds the only unfenced heading even when fenced copies exist",
    body: FENCED,
    edits: [{ section: "## Rollout", new_text: "## Rollout\nShipped.\n" }],
    expected: FENCED.replace("## Rollout\nShip it.\n", "## Rollout\nShipped.\n"),
  },
  {
    name: "refuses a section edit on a body with an unclosed fence",
    body: "## A\n```sh\n# comment\n## B\nx\n",
    edits: [{ section: "## A", new_text: "## A\ny\n" }],
    expected: {
      error:
        'edits[0]: the plan has an unclosed code fence at "```sh"; fix it with a text edit first',
    },
  },
  {
    name: "treats an end-marker line as ordinary text",
    body: "## A\na\n<!-- end ## A -->\ntrailing\n## B\nb\n",
    edits: [{ section: "## A", new_text: "## A\nnew\n" }],
    expected: "## A\nnew\n\n## B\nb\n",
  },

  // Shape and batch
  {
    name: "rejects an edit with both old_text and section",
    edits: [{ old_text: "Ship it.", section: "## Rollout", new_text: "x" }],
    expected: { error: "edits[0]: set exactly one of old_text or section" },
  },
  {
    name: "rejects an edit with neither old_text nor section",
    edits: [{ old_text: "", new_text: "x" }],
    expected: { error: "edits[0]: set exactly one of old_text or section" },
  },
  {
    name: "applies edits in order, each seeing the one before",
    edits: [
      { old_text: "Ship it.", new_text: "Ship it, then watch." },
      { old_text: "then watch.", new_text: "then watch the dashboards." },
    ],
    expected: PLAN.replace("Ship it.", "Ship it, then watch the dashboards."),
  },
  {
    name: "aborts the whole batch on the first failure",
    edits: [
      { old_text: "Ship it.", new_text: "Changed." },
      { section: "## Missing", new_text: "" },
    ],
    expected: {
      error:
        'edits[1]: no heading "## Missing"; headings are: # Plan, ## Design, ### Details, ## Rollout, ## Tests',
    },
  },
  {
    name: "rejects edits that leave the plan empty",
    edits: [{ section: "# Plan", new_text: "" }],
    expected: { error: "edits would leave the plan empty; use board_write_plan to replace it" },
  },
  {
    name: "rejects edits that leave the plan unchanged",
    edits: [{ old_text: "Ship it.", new_text: "Ship it." }],
    expected: { error: "edits made no change to the plan" },
  },
];

describe("applyBoardPlanEdits", () => {
  it.each(cases)("$name", (testCase) => {
    const result = applyBoardPlanEdits(testCase.body ?? PLAN, testCase.edits);
    if (typeof testCase.expected === "string") {
      expect(result).toEqual({ ok: true, body: testCase.expected });
    } else {
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.message).toBe(testCase.expected.error);
    }
  });

  it("caps the listed headings at 40", () => {
    const body = Array.from({ length: 45 }, (_, index) => `## H${index}\n`).join("");
    const result = applyBoardPlanEdits(body, [{ section: "## Missing", new_text: "" }]);
    expect(result.ok ? null : result.message).toMatch(/## H39, …$/);
  });
});

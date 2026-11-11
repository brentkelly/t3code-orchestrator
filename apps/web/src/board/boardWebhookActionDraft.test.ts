import { githubIssueBoardWebhookAction } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardWebhookActionDraft,
  emptyBoardRuleDraft,
  parseBoardWebhookActionDraft,
} from "./boardWebhookActionDraft";

describe("board rule drafts", () => {
  it("round-trips the GitHub preset through the editable text", () => {
    const preset = githubIssueBoardWebhookAction("needs-card");
    expect(parseBoardWebhookActionDraft(boardWebhookActionDraft(preset))).toEqual({
      action: preset,
    });
  });

  it("round-trips filter values with edge spaces, line breaks or a leading quote", () => {
    const action = {
      externalRef: { system: "github-issue", idTemplate: "{{body.issue.number}}" },
      rules: [
        {
          filters: [
            { path: "body.action", op: "equals", value: " closed " },
            { path: "body.title", op: "startsWith", value: "a\nb" },
            { path: "body.label", op: "notEquals", value: '"quoted"' },
          ],
          action: { kind: "archive" },
        },
      ],
    } as const;
    expect(parseBoardWebhookActionDraft(boardWebhookActionDraft(action))).toEqual({ action });
  });

  it("names the rule and line a person must fix", () => {
    const draft = {
      system: "github-issue",
      idTemplate: "{{body.issue.number}}",
      urlTemplate: "",
      rules: [
        { ...emptyBoardRuleDraft("archive"), filters: "body.action equals closed" },
        { ...emptyBoardRuleDraft("move"), filters: "\nbody.action resembles closed" },
      ],
    };
    expect(parseBoardWebhookActionDraft(draft)).toEqual({
      error: expect.stringMatching(/^Rule 2: Filter line 2 needs a path, an operator/),
    });
    expect(
      parseBoardWebhookActionDraft({ ...draft, rules: [{ ...emptyBoardRuleDraft("move") }] }),
    ).toEqual({ error: "Rule 1 needs a stage to move to." });
    expect(
      parseBoardWebhookActionDraft({
        ...draft,
        rules: [{ ...emptyBoardRuleDraft("archive"), filters: "body.label.name exists" }],
      }),
    ).toEqual({
      action: {
        externalRef: { system: "github-issue", idTemplate: "{{body.issue.number}}" },
        rules: [
          { filters: [{ path: "body.label.name", op: "exists" }], action: { kind: "archive" } },
        ],
      },
    });
  });
});

/**
 * Claude Code drops EVERY tool on a server when one `tools/list` entry is malformed, so the
 * toolkits are asserted together, exactly as `McpHttpServer.layer` registers them
 * (`PreviewStandardToolkit`, `PreviewSnapshotToolkit`, `BoardToolkit`). Add any new toolkit here.
 */
import { expect, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { PreviewSnapshotToolkit, PreviewStandardToolkit } from "../preview/tools.ts";
import { BoardToolkit } from "./tools.ts";

const advertisedTools = [
  ...Object.values(PreviewStandardToolkit.tools),
  ...Object.values(PreviewSnapshotToolkit.tools),
  ...Object.values(BoardToolkit.tools),
] as ReadonlyArray<{ readonly name: string }>;

it("advertises board_get_card_context among the board tools", () => {
  const boardToolNames = Object.values(BoardToolkit.tools).map((tool) => tool.name);
  expect(boardToolNames).toContain("board_get_card_context");
});

it("advertises the card lifecycle verbs, delete included (T3O-2)", () => {
  const boardToolNames = Object.values(BoardToolkit.tools).map((tool) => tool.name);
  // An agent could create and move cards but never take one off the board, so
  // the board it populated only ever grew. Delete is the destructive half;
  // archive and unarchive are the reversible pair it should reach for first.
  expect(boardToolNames).toContain("board_archive_card");
  expect(boardToolNames).toContain("board_unarchive_card");
  expect(boardToolNames).toContain("board_delete_card");
});

it("advertises board_manage_labels so agents can manage the label catalogue (T3O-68)", () => {
  const boardToolNames = Object.values(BoardToolkit.tools).map((tool) => tool.name);
  expect(boardToolNames).toContain("board_manage_labels");
});

it("no longer advertises the deleted agent-activity tools (t3o-18, D13)", () => {
  const boardToolNames = Object.values(BoardToolkit.tools).map((tool) => tool.name);
  // `tools/list` is all-or-nothing to a client, so this is also the tripwire for
  // a stale reference resurrecting a tool that has no handler behind it.
  expect(boardToolNames).not.toContain("board_report_progress");
  expect(boardToolNames).not.toContain("board_request_input");
});

it("gives agents no tool to choose a card's worker (D20: a human act)", () => {
  const boardToolNames = Object.values(BoardToolkit.tools).map((tool) => tool.name);
  expect(boardToolNames).not.toContain("board_pin_card_worker");
});

it("gives every advertised tool an MCP-valid object inputSchema", () => {
  const invalid = advertisedTools
    .map((tool) => {
      const inputSchema = Tool.getJsonSchema(tool as never) as { readonly type?: unknown };
      return { name: tool.name, type: inputSchema?.type, inputSchema };
    })
    .filter((entry) => entry.type !== "object");

  // Named rather than counted: the message has to say which tool poisoned the
  // response, because the symptom (no tools at all) never points at it.
  expect(invalid.map((entry) => `${entry.name}: ${JSON.stringify(entry.inputSchema)}`)).toEqual([]);
});

it("keeps the no-parameter tool an empty object rather than an anyOf", () => {
  const getCardContext = Object.values(BoardToolkit.tools).find(
    (tool) => tool.name === "board_get_card_context",
  );
  expect(getCardContext).toBeDefined();

  const inputSchema = Tool.getJsonSchema(getCardContext as never) as Record<string, unknown>;
  expect(inputSchema).toMatchObject({ type: "object" });
  expect(inputSchema).not.toHaveProperty("anyOf");
  expect(inputSchema.properties ?? {}).toEqual({});
});

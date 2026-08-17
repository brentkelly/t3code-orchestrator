/**
 * T3o board MCP toolkit — advertised-tool contract (t3o-08, D3).
 *
 * `handlers.board.test.ts` proves the handlers work once called. This proves
 * they are *reachable*: that the tools the MCP server advertises satisfy the
 * shape MCP clients enforce on `tools/list`.
 *
 * The failure this guards against is not local. Claude Code validates the
 * entire `tools/list` response and, on a single malformed entry, retries three
 * times and then drops **every** tool the server offers — board and preview
 * alike — with the server still reporting `hasTools: true`. An agent in that
 * state has no board tools and no notion that cards exist, which reads as a
 * missing feature rather than a schema defect. The concrete regression:
 * `board_get_card_context` takes no parameters, and `Schema.Struct({})`
 * serializes to `{"anyOf":[{"type":"object"},{"type":"array"}]}` — no
 * top-level `type`, so the response failed validation and every thread lost
 * the whole `t3-code` server.
 *
 * Both toolkits are asserted together because that is how they are served:
 * `McpHttpServer.layer` merges them onto one MCP server, so a malformed board
 * tool takes preview down with it and vice versa.
 */
import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { PreviewToolkit } from "../preview/tools.ts";
import { BoardToolkit } from "./tools.ts";

const advertisedTools = [
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(BoardToolkit.tools),
] as ReadonlyArray<{ readonly name: string }>;

it("advertises board_get_card_context among the board tools", () => {
  const boardToolNames = Object.values(BoardToolkit.tools).map((tool) => tool.name);
  expect(boardToolNames).toContain("board_get_card_context");
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

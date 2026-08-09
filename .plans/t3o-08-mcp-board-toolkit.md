---
id: t3o-08
title: MCP board toolkit — the agent write path
phase: 2
prerequisites: [t3o-03]
---

# MCP board toolkit

How agents read and write the board. This is the interface that makes T3o an orchestrator rather
than a diagram.

## Locked decisions

- **D3** — MCP is the agent write path; `McpInvocationScope.threadId` identifies the caller;
  authorization lives in the handlers, not in capability gating.
- **D8** — tools dispatch **commands**; they never write projected tables directly.

## Seam inventory

1. `apps/server/src/mcp/McpInvocationContext.ts` — `McpCapability` gains `"board"`.
2. `apps/server/src/mcp/McpSessionRegistry.ts` — granted capability set gains `"board"`.
3. `apps/server/src/mcp/McpHttpServer.ts` — `BoardToolkitRegistrationLive` joins the layer merge.

Everything else lives under a new `apps/server/src/mcp/toolkits/board/`, mirroring the existing
`toolkits/preview/` structure.

## Authorization model

Capability is granted broadly; **the handlers authorize**. Every tool resolves the calling
`threadId` to its card through the thread-link index. Rules:

- Thread linked to a card → operates on that card by default.
- Thread not linked → **write tools that target a card are rejected** with a message explaining how
  to be adopted. Rejections must be actionable; an agent that gets a bare error will invent a
  workaround.
- Cross-card writes require an explicit `cardId` **and** are limited to the tools listed as
  board-scoped below.

## Tools

### Card-scoped (operate on the caller's own card)

- `board_get_card_context` — card, stage, brief, plan, dependency states, prior steps and their
  outcomes, outstanding issues. The pull half of D5.
- `board_report_progress` — a human-readable progress note appended to card activity. Cheap, safe,
  called often.
- `board_complete_step` — **the completion contract.** Takes an outcome (`succeeded` / `blocked` /
  `failed`), a summary, and optional structured payload. A step is complete only via this call
  (D4). Must be idempotent: agents retry on timeouts, and a double call is a no-op, never a double
  transition.
- `board_request_input` — explicitly hand the gate to the human. Wraps the provider's own question
  mechanism so the thread enters pending-user-input state and D13's notification path fires.

### Board-scoped (require an explicit target)

- `board_list_cards` — filter by project, stage, key, text.
- `board_create_card` — title, brief, type, project, target stage, dependencies. Returns the
  allocated key.
- `board_move_card` — move a card between stages, subject to the same decider invariants a drag is
  subject to. No privileged path: an agent cannot move a blocked card past Ready either.
- `board_update_card` — title, brief, type, dependencies, `externalRef`.

`board_create_card` and `board_move_card` exist so an agent can populate and drive a board
conversationally — "create cards for each of these features and put them in Sprint". Once Phase 1
lands, the T3o specs themselves should become the board's first cards.

### Plan tools (schema now, flow post-MVP)

- `board_propose_plans` — an ordered array of `{ title, summary, dependsOn, body }`. **Validated on
  ingest**: schema, unknown dependency references, and cycles, rejected with the offending edge
  named. This is strictly better than frontmatter, which can only be discovered broken later.
- `board_get_plan` / `board_write_plan` — reject writes once the plan is `locked` (set when the plan
  is materialised to `.plans/` at Building entry), telling the agent to edit the file instead. One
  source of truth at any moment, with an explicit handover.

## Tool description discipline

These descriptions are prompts. They are read by every model the board uses, across vendors, with no
shared conventions between them. Each must state what the tool does, when to call it, and what
happens if it is not called — particularly `board_complete_step`, whose omission is
indistinguishable from death.

## Out of scope

- The reactor that spawns threads and consumes these calls (`t3o-10`).
- Review-pipeline tools (`board_report_issue`, adjudication) — post-MVP.

## Verification

- A tool call from a linked thread resolves the right card with no card id in the payload.
- A call from an unlinked thread is rejected with an actionable message.
- `board_complete_step` called twice produces one transition.
- `board_propose_plans` with a cycle is rejected naming the edge.
- Tools are reachable over a relay connection, not just locally.

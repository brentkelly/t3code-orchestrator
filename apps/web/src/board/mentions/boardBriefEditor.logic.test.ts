import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type BoardCardId,
  type ProjectId,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { formatComposerModelMention } from "@t3tools/client-runtime/composer-model-mentions";
import { describe, expect, it } from "vite-plus/test";

import type { ComposerCommandItem } from "~/components/chat/ComposerCommandMenu";
import {
  boardBriefContextRecords,
  boardBriefMenuReplacement,
  boardBriefViewSegments,
  mergeBoardBriefProviderCatalog,
  nudgeBoardBriefHighlight,
} from "./boardBriefEditor.logic";

const board = EnvironmentId.make("env-board");
const skill = (name: string, description?: string): ServerProviderSkill => ({
  name,
  path: `.agents/skills/${name}/SKILL.md`,
  enabled: true,
  ...(description ? { description } : {}),
});
const provider = (
  driver: string,
  displayName: string,
  skills: ServerProviderSkill[],
  commands: string[],
  enabled = true,
) => ({
  driver: ProviderDriverKind.make(driver),
  displayName,
  enabled,
  skills,
  slashCommands: commands.map((name) => ({ name, description: `${name} it` })),
});

describe("mergeBoardBriefProviderCatalog", () => {
  it("passes a single provider's catalog through untouched", () => {
    const catalog = mergeBoardBriefProviderCatalog([
      provider("codex", "Codex", [skill("review", "Review code")], ["init"]),
      provider("claudeAgent", "Claude", [skill("other")], ["other"], false),
    ]);
    expect(catalog.provider).toBe("codex");
    expect(catalog.skills).toEqual([skill("review", "Review code")]);
    expect(catalog.slashCommands).toEqual([{ name: "init", description: "init it" }]);
  });

  it("merges every enabled provider by name and names the providers on each row", () => {
    const catalog = mergeBoardBriefProviderCatalog([
      provider("codex", "Codex", [skill("review", "Review code")], ["init", "compact"]),
      provider("claudeAgent", "Claude", [skill("review"), skill("design")], ["compact"]),
    ]);
    expect(catalog.skills.map((s) => [s.name, s.shortDescription])).toEqual([
      ["review", "Review code · Codex, Claude"],
      ["design", "Claude"],
    ]);
    expect(catalog.slashCommands.map((c) => [c.name, c.description])).toEqual([
      ["init", "init it · Codex"],
      ["compact", "compact it · Codex, Claude"],
    ]);
  });

  it("has no provider when none is enabled", () => {
    expect(mergeBoardBriefProviderCatalog([]).provider).toBeNull();
  });
});

describe("boardBriefContextRecords", () => {
  it("builds thread records on the board server and machine records from their ids", () => {
    const records = boardBriefContextRecords(
      "[Old](t3-context://v1/thread/thread_t1) [laptop](t3-context://v1/environment/environment_e1) [T3O-1](t3-context://v1/card/card_x) [Old](t3-context://v1/thread/thread_t1)",
      board,
    );
    expect([...records.keys()]).toEqual(["thread_t1", "environment_e1"]);
    expect(records.get("thread_t1")).toMatchObject({
      kind: "thread",
      record: { contextId: "thread_t1", environmentId: board, threadId: "t1", title: "Old" },
    });
    expect(records.get("environment_e1")).toMatchObject({
      kind: "environment",
      record: { contextId: "environment_e1", environmentId: "e1", label: "laptop" },
    });
  });
});

describe("boardBriefMenuReplacement", () => {
  const cardId = "0b9a2c1e-4d5f-4a6b-8c7d-9e0f1a2b3c4d" as BoardCardId;
  const base = { id: "x", label: "Label", description: "" };
  const cases: ReadonlyArray<readonly [ComposerCommandItem, string | null]> = [
    [
      {
        ...base,
        type: "card",
        cardId,
        key: "T3O-58",
        projectId: "p" as ProjectId,
        accent: null,
      },
      `[T3O-58 · Label](t3-context://v1/card/card_${cardId}) `,
    ],
    [
      {
        ...base,
        type: "thread",
        thread: { environmentId: EnvironmentId.make("elsewhere"), threadId: ThreadId.make("t1") },
      },
      "[Label](t3-context://v1/thread/thread_t1) ",
    ],
    [
      {
        ...base,
        type: "environment",
        environmentId: EnvironmentId.make("e1"),
        machine: "server",
      },
      "[Label](t3-context://v1/environment/environment_e1) ",
    ],
    [
      {
        ...base,
        type: "model",
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5",
        driverKind: ProviderDriverKind.make("codex"),
        providerDisplayName: "Codex",
        acpRegistryAgentId: undefined,
        acpRegistryIconUrl: undefined,
      },
      `${formatComposerModelMention("codex", "gpt-5")} `,
    ],
    [
      {
        ...base,
        type: "skill",
        provider: ProviderDriverKind.make("codex"),
        skill: skill("review"),
      },
      "$review ",
    ],
    [
      {
        ...base,
        type: "provider-slash-command",
        provider: ProviderDriverKind.make("codex"),
        command: { name: "init" },
      },
      "/init ",
    ],
    [{ ...base, type: "slash-command", command: "model" }, null],
  ];

  it.each(cases)("inserts the right text for item %#", (item, expected) => {
    expect(boardBriefMenuReplacement(item, board)).toBe(expected);
  });
});

describe("nudgeBoardBriefHighlight", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("moves and wraps", () => {
    expect(nudgeBoardBriefHighlight(items, "a", "ArrowDown")).toBe("b");
    expect(nudgeBoardBriefHighlight(items, "c", "ArrowDown")).toBe("a");
    expect(nudgeBoardBriefHighlight(items, "a", "ArrowUp")).toBe("c");
    expect(nudgeBoardBriefHighlight(items, null, "ArrowDown")).toBe("a");
    expect(nudgeBoardBriefHighlight([], null, "ArrowDown")).toBeNull();
  });
});

describe("boardBriefViewSegments", () => {
  it("chips a link-form file mention and keeps a bare @word as text", () => {
    const text = "Ask @alice about [README.md](docs/README.md) today";
    const parts = boardBriefViewSegments(text).map(({ segment }) =>
      segment.type === "text" ? segment.text : `<${segment.type}>`,
    );
    expect(parts).toEqual(["Ask ", "@alice", " about ", "<mention>", " today"]);
  });
});

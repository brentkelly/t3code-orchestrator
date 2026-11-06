import {
  DEFAULT_BOARD_SETTINGS,
  DEFAULT_BOARD_KEY_PREFIX,
  ProjectId,
  type BoardSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { boardCreateKeyPrefix, boardKeyPrefixPersistPatch } from "./boardCreateKeyPrefix";

const PROJECT = ProjectId.make("project-1");

function boardWithPrefix(prefix: string): BoardSettings {
  return {
    ...DEFAULT_BOARD_SETTINGS,
    projects: { [PROJECT]: { keyPrefix: prefix, hidden: false } },
  };
}

describe("boardCreateKeyPrefix", () => {
  it("sends the stored project prefix instead of CARD", () => {
    const result = boardCreateKeyPrefix({
      board: boardWithPrefix("T3O"),
      projectId: PROJECT,
      projectTitle: "t3code-orchestrator",
    });
    expect(result).toEqual({ prefix: "T3O", assigned: false });
    expect(result.prefix).not.toBe(DEFAULT_BOARD_KEY_PREFIX);
  });

  it("assigns an acronym for a project with no stored prefix", () => {
    const result = boardCreateKeyPrefix({
      board: DEFAULT_BOARD_SETTINGS,
      projectId: PROJECT,
      projectTitle: "t3code-orchestrator",
    });
    expect(result.assigned).toBe(true);
    expect(result.prefix).toBe("TO");
    expect(result.prefix).not.toBe(DEFAULT_BOARD_KEY_PREFIX);
  });

  it("still derives a prefix when settings have not loaded", () => {
    const result = boardCreateKeyPrefix({
      board: null,
      projectId: PROJECT,
      projectTitle: "t3code-orchestrator",
    });
    expect(result.assigned).toBe(true);
    expect(result.prefix).toBe("TO");
  });
});

describe("boardKeyPrefixPersistPatch", () => {
  it("writes the assigned prefix without dropping other projects", () => {
    const other = ProjectId.make("project-2");
    const board: BoardSettings = {
      ...DEFAULT_BOARD_SETTINGS,
      projects: {
        [other]: { keyPrefix: "AL", hidden: true },
      },
    };
    expect(boardKeyPrefixPersistPatch({ board, projectId: PROJECT, prefix: "TO" })).toEqual({
      projects: {
        [other]: { keyPrefix: "AL", hidden: true },
        [PROJECT]: { keyPrefix: "TO", hidden: false },
      },
    });
  });
});

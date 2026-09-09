/**
 * The new-card draft rules (T3O-26): what counts as a draft, and how a stored
 * one is mapped back onto a board that has moved on since it was saved.
 */
import {
  BOARD_SEED_STAGES,
  BOARD_SEED_STAGE_IDS,
  BoardCardId,
  BoardLabelId,
  ProjectId,
  type BoardLabel,
  type IsoDateTime,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOARD_CARD_DRAFT_ATTACHMENT_TTL_MS,
  boardCardDraftHasContent,
  boardCardDraftKey,
  parseBoardCardDraft,
  restoreBoardCardDraft,
  stagedRowsFromUploads,
  type BoardCardDraft,
  type BoardCardDraftCard,
} from "./boardCardDraft";
import type { EnvironmentId } from "@t3tools/contracts";

const projectOne = ProjectId.make("project-one");
const projectTwo = ProjectId.make("project-two");
const parent = BoardCardId.make("parent");
const NOW = 1_700_000_000_000;

const attachment = (id: string) => ({
  pendingAttachmentId: id,
  name: `${id}.png`,
  type: "image" as const,
  mimeType: "image/png",
  sizeBytes: 1024,
});

const draftOf = (patch: Partial<BoardCardDraft> = {}): BoardCardDraft => ({
  title: "",
  brief: "",
  stage: BOARD_SEED_STAGE_IDS.planning,
  projectId: projectOne,
  baseBranch: null,
  labelIds: [],
  dependsOn: [],
  scheduledStartAt: null,
  attachments: [],
  updatedAt: NOW,
  ...patch,
});

const card = (
  id: string,
  projectId: ProjectId,
  parentCardId?: BoardCardId,
): BoardCardDraftCard => ({
  cardId: BoardCardId.make(id),
  projectId,
  ...(parentCardId === undefined ? {} : { parentCardId }),
});

const label = (id: string, deleted: boolean): BoardLabel => ({
  labelId: BoardLabelId.make(id),
  name: id,
  colour: "blue",
  deletedAt: deleted ? ("2026-01-01T00:00:00.000Z" as IsoDateTime) : null,
  createdAt: "2026-01-01T00:00:00.000Z" as IsoDateTime,
  updatedAt: "2026-01-01T00:00:00.000Z" as IsoDateTime,
});

const restore = (
  draft: BoardCardDraft,
  overrides: Partial<Parameters<typeof restoreBoardCardDraft>[0]> = {},
) =>
  restoreBoardCardDraft({
    draft,
    now: NOW,
    cards: [],
    projectIds: [projectOne, projectTwo],
    labels: [],
    stageOptions: BOARD_SEED_STAGES,
    subBoardParentId: null,
    fallbackProjectId: projectOne,
    openedStage: BOARD_SEED_STAGE_IDS.backlog,
    ...overrides,
  });

describe("boardCardDraftKey", () => {
  it("separates the root board from each sub-board, and one server from another", () => {
    const one = "env-one" as EnvironmentId;
    const two = "env-two" as EnvironmentId;
    const keys = new Set([
      boardCardDraftKey(one, null),
      boardCardDraftKey(one, parent),
      boardCardDraftKey(two, null),
    ]);
    expect(keys.size).toBe(3);
    expect(boardCardDraftKey(one, null)).toBe(boardCardDraftKey(one, null));
  });
});

describe("boardCardDraftHasContent", () => {
  it("counts title, brief, dependencies and attachments", () => {
    expect(boardCardDraftHasContent(draftOf({ title: "Ship it" }))).toBe(true);
    expect(boardCardDraftHasContent(draftOf({ brief: "context" }))).toBe(true);
    expect(boardCardDraftHasContent(draftOf({ dependsOn: [BoardCardId.make("other")] }))).toBe(
      true,
    );
    expect(boardCardDraftHasContent(draftOf({ attachments: [attachment("a")] }))).toBe(true);
  });

  it("ignores whitespace, and the defaults the dialog opens with", () => {
    expect(boardCardDraftHasContent(draftOf({ title: "   \n " }))).toBe(false);
    expect(boardCardDraftHasContent(draftOf({ brief: "\t" }))).toBe(false);
    // Project, stage, labels, base branch and a schedule are not content: a
    // draft made of those alone would greet you forever after merely opening
    // the dialog.
    expect(
      boardCardDraftHasContent(
        draftOf({
          projectId: projectTwo,
          stage: BOARD_SEED_STAGE_IDS.ready,
          labelIds: [BoardLabelId.make("bug")],
          baseBranch: "release",
          scheduledStartAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(false);
  });
});

describe("parseBoardCardDraft", () => {
  it("round-trips a stored draft", () => {
    const draft = draftOf({ title: "Ship it", attachments: [attachment("a")] });
    expect(parseBoardCardDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
  });

  it("reads corrupt, foreign-shaped and empty records as no draft", () => {
    expect(parseBoardCardDraft(null)).toBeNull();
    expect(parseBoardCardDraft("draft")).toBeNull();
    expect(parseBoardCardDraft({ title: "Ship it" })).toBeNull();
    expect(parseBoardCardDraft({ ...draftOf({ title: "Ship it" }), updatedAt: "now" })).toBeNull();
    // Decodable, but nothing was typed — not a draft.
    expect(parseBoardCardDraft(draftOf({ stage: BOARD_SEED_STAGE_IDS.ready }))).toBeNull();
  });
});

describe("restoreBoardCardDraft — stage", () => {
  it("keeps its own stage over the one the dialog was opened on", () => {
    // Including a column's + : the identity row's picker shows the restored
    // stage, so where the card will land is never a surprise.
    for (const openedStage of [BOARD_SEED_STAGE_IDS.backlog, BOARD_SEED_STAGE_IDS.sprint]) {
      const restored = restore(draftOf({ stage: BOARD_SEED_STAGE_IDS.planning }), { openedStage });
      expect(restored.fields.stage).toBe(BOARD_SEED_STAGE_IDS.planning);
    }
  });

  it("falls back to the opened stage when its own is no longer offered", () => {
    const restored = restore(draftOf({ stage: BOARD_SEED_STAGE_IDS.planning }), {
      stageOptions: BOARD_SEED_STAGES.filter(
        (definition) => definition.stageId !== BOARD_SEED_STAGE_IDS.planning,
      ),
      openedStage: BOARD_SEED_STAGE_IDS.backlog,
    });
    expect(restored.fields.stage).toBe(BOARD_SEED_STAGE_IDS.backlog);
  });

  it("clamps to the stages a sub-board child may occupy", () => {
    // The drill-in offers the materialisation floor onward; a draft saved on
    // the root board's Backlog cannot land a child there.
    const options = BOARD_SEED_STAGES.filter((definition) =>
      [
        BOARD_SEED_STAGE_IDS.ready,
        BOARD_SEED_STAGE_IDS.building,
        BOARD_SEED_STAGE_IDS.done,
      ].includes(definition.stageId as never),
    );
    const restored = restore(draftOf({ stage: BOARD_SEED_STAGE_IDS.backlog }), {
      stageOptions: options,
      openedStage: BOARD_SEED_STAGE_IDS.backlog,
      subBoardParentId: parent,
    });
    expect(restored.fields.stage).toBe(BOARD_SEED_STAGE_IDS.ready);
  });
});

describe("restoreBoardCardDraft — project, dependencies and labels", () => {
  it("keeps dependencies that still exist in the chosen project", () => {
    const restored = restore(
      draftOf({ dependsOn: [BoardCardId.make("one"), BoardCardId.make("two")] }),
      { cards: [card("one", projectOne), card("two", projectOne)] },
    );
    expect(restored.fields.dependsOn).toEqual([BoardCardId.make("one"), BoardCardId.make("two")]);
  });

  it("drops dependencies that are gone or belong to another project", () => {
    const restored = restore(
      draftOf({
        dependsOn: [
          BoardCardId.make("one"),
          BoardCardId.make("elsewhere"),
          BoardCardId.make("deleted"),
        ],
      }),
      { cards: [card("one", projectOne), card("elsewhere", projectTwo)] },
    );
    expect(restored.fields.dependsOn).toEqual([BoardCardId.make("one")]);
  });

  it("keeps only siblings inside a sub-board", () => {
    const restored = restore(
      draftOf({ dependsOn: [BoardCardId.make("sibling"), BoardCardId.make("stranger")] }),
      {
        cards: [card("sibling", projectOne, parent), card("stranger", projectOne)],
        subBoardParentId: parent,
      },
    );
    expect(restored.fields.dependsOn).toEqual([BoardCardId.make("sibling")]);
  });

  it("falls back to the default project when the draft's is gone, taking its dependencies and base branch with it", () => {
    const restored = restore(
      draftOf({
        projectId: ProjectId.make("removed"),
        baseBranch: "release/2026",
        dependsOn: [BoardCardId.make("one")],
        title: "Ship it",
      }),
      { cards: [card("one", projectOne)], fallbackProjectId: projectTwo },
    );
    expect(restored.fields.projectId).toBe(projectTwo);
    expect(restored.fields.baseBranch).toBeNull();
    expect(restored.fields.dependsOn).toEqual([]);
    // The typed text survives the project going missing.
    expect(restored.fields.title).toBe("Ship it");
  });

  it("drops labels that were deleted from the catalogue", () => {
    const restored = restore(
      draftOf({ labelIds: [BoardLabelId.make("live"), BoardLabelId.make("retired")] }),
      { labels: [label("live", false), label("retired", true)] },
    );
    expect(restored.fields.labelIds).toEqual([BoardLabelId.make("live")]);
  });

  it("keeps a scheduled start that is now in the past", () => {
    const restored = restore(draftOf({ scheduledStartAt: "2020-01-01T00:00:00.000Z" }));
    expect(restored.fields.scheduledStartAt).toBe("2020-01-01T00:00:00.000Z");
  });
});

describe("restoreBoardCardDraft — attachments", () => {
  it("offers references back while the pending uploads can still be claimed", () => {
    const restored = restore(
      draftOf({
        attachments: [attachment("a"), attachment("b")],
        updatedAt: NOW - BOARD_CARD_DRAFT_ATTACHMENT_TTL_MS + 1_000,
      }),
    );
    expect(restored.fields.attachments).toHaveLength(2);
    expect(restored.droppedAttachments).toBe(false);
  });

  it("drops references the server has already swept, and says so", () => {
    const restored = restore(
      draftOf({
        title: "Ship it",
        attachments: [attachment("a")],
        updatedAt: NOW - BOARD_CARD_DRAFT_ATTACHMENT_TTL_MS - 1,
      }),
    );
    expect(restored.fields.attachments).toEqual([]);
    expect(restored.droppedAttachments).toBe(true);
  });

  it("trims to the per-card cap", () => {
    const restored = restore(
      draftOf({ attachments: [attachment("a"), attachment("b"), attachment("c")] }),
      { maxAttachments: 2 },
    );
    expect(restored.fields.attachments.map((row) => row.pendingAttachmentId)).toEqual(["a", "b"]);
    expect(restored.droppedAttachments).toBe(true);
  });
});

describe("stagedRowsFromUploads", () => {
  it("produces uploaded rows with no local bytes, so nothing offers a retry", () => {
    const rows = stagedRowsFromUploads([attachment("a")]);
    expect(rows).toEqual([
      {
        id: "a",
        name: "a.png",
        type: "image",
        mimeType: "image/png",
        sizeBytes: 1024,
        file: null,
        previewUrl: null,
        status: "uploaded",
        progress: 1,
        error: null,
        upload: attachment("a"),
      },
    ]);
  });
});

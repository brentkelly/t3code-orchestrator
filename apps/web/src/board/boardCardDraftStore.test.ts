/**
 * The new-card draft store (T3O-26): one draft per board scope, written
 * through debounced storage, sanitised on the way back in.
 */
import { BOARD_SEED_STAGE_IDS, BoardCardId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import type { BoardCardDraft } from "./boardCardDraft";
import { boardCardDraftKey } from "./boardCardDraft";
import {
  BOARD_CARD_DRAFT_STORAGE_KEY,
  boardCardDraftStorage,
  clearBoardCardDraft,
  flushBoardCardDrafts,
  readBoardCardDraft,
  sanitisePersistedBoardCardDrafts,
  saveBoardCardDraft,
  useBoardCardDraftStore,
} from "./boardCardDraftStore";
import type { EnvironmentId } from "@t3tools/contracts";

const environmentOne = "env-one" as EnvironmentId;
const environmentTwo = "env-two" as EnvironmentId;
const parent = BoardCardId.make("parent");

const draftOf = (patch: Partial<BoardCardDraft> = {}): BoardCardDraft => ({
  title: "Ship it",
  brief: "",
  stage: BOARD_SEED_STAGE_IDS.planning,
  projectId: ProjectId.make("project-one"),
  baseBranch: null,
  labelIds: [],
  dependsOn: [],
  scheduledStartAt: null,
  attachments: [],
  updatedAt: 1_700_000_000_000,
  ...patch,
});

/** What actually landed in storage, not what the store holds in memory. */
function persistedKeys(): ReadonlyArray<string> {
  const raw = boardCardDraftStorage.getItem(BOARD_CARD_DRAFT_STORAGE_KEY);
  if (typeof raw !== "string") return [];
  return Object.keys(JSON.parse(raw).state.draftsByKey);
}

beforeEach(() => {
  useBoardCardDraftStore.setState({ draftsByKey: {} });
  flushBoardCardDrafts();
});

describe("scope isolation", () => {
  it("never lets one scope's draft surface in another", () => {
    const root = boardCardDraftKey(environmentOne, null);
    const subBoard = boardCardDraftKey(environmentOne, parent);
    const otherServer = boardCardDraftKey(environmentTwo, null);

    saveBoardCardDraft(root, draftOf({ title: "Root card" }));
    saveBoardCardDraft(subBoard, draftOf({ title: "Child card" }));

    expect(readBoardCardDraft(root)?.title).toBe("Root card");
    expect(readBoardCardDraft(subBoard)?.title).toBe("Child card");
    expect(readBoardCardDraft(otherServer)).toBeNull();

    clearBoardCardDraft(subBoard);
    expect(readBoardCardDraft(subBoard)).toBeNull();
    expect(readBoardCardDraft(root)?.title).toBe("Root card");
  });
});

describe("saveBoardCardDraft", () => {
  it("reaches storage once the debounced write is flushed", () => {
    const key = boardCardDraftKey(environmentOne, null);
    saveBoardCardDraft(key, draftOf({ title: "Ship it", brief: "context" }));
    flushBoardCardDrafts();

    expect(persistedKeys()).toEqual([key]);
    const restored = sanitisePersistedBoardCardDrafts(
      JSON.parse(boardCardDraftStorage.getItem(BOARD_CARD_DRAFT_STORAGE_KEY) as string).state,
    );
    expect(restored.draftsByKey[key]?.brief).toBe("context");
  });

  it("removes the record once the fields fall back below the content rule", () => {
    const key = boardCardDraftKey(environmentOne, null);
    saveBoardCardDraft(key, draftOf({ title: "Ship it" }));
    saveBoardCardDraft(key, draftOf({ title: "  " }));
    flushBoardCardDrafts();

    expect(readBoardCardDraft(key)).toBeNull();
    expect(persistedKeys()).toEqual([]);
  });

  it("leaves state untouched when nothing a draft stores has changed", () => {
    const key = boardCardDraftKey(environmentOne, null);
    saveBoardCardDraft(key, draftOf({ updatedAt: 1 }));
    const first = useBoardCardDraftStore.getState().draftsByKey;
    // Same input, later clock: the autosave fires on renders that changed
    // nothing, and those must not churn state or the storage write.
    saveBoardCardDraft(key, draftOf({ updatedAt: 2 }));
    expect(useBoardCardDraftStore.getState().draftsByKey).toBe(first);
  });

  it("discarding lands immediately, without waiting on the debounce", () => {
    const key = boardCardDraftKey(environmentOne, null);
    saveBoardCardDraft(key, draftOf());
    flushBoardCardDrafts();
    clearBoardCardDraft(key);

    expect(persistedKeys()).toEqual([]);
  });
});

describe("sanitisePersistedBoardCardDrafts", () => {
  it("keeps decodable drafts with content and drops everything else", () => {
    const sanitised = sanitisePersistedBoardCardDrafts({
      draftsByKey: {
        good: draftOf({ title: "Ship it" }),
        corrupt: { title: "Ship it" },
        wrongType: { ...draftOf(), updatedAt: "now" },
        empty: draftOf({ title: "   " }),
        notAnObject: 7,
      },
    });
    expect(Object.keys(sanitised.draftsByKey)).toEqual(["good"]);
  });

  it("reads a missing, non-object or foreign-shaped store as no drafts", () => {
    expect(sanitisePersistedBoardCardDrafts(undefined).draftsByKey).toEqual({});
    expect(sanitisePersistedBoardCardDrafts("drafts").draftsByKey).toEqual({});
    expect(sanitisePersistedBoardCardDrafts({ draftsByKey: 7 }).draftsByKey).toEqual({});
  });

  it("is what `merge` runs, so same-version corruption cannot reach state", () => {
    // `migrate` only runs on a version bump; hand-edited storage at the
    // current version arrives through `merge` — the boardUiStore lesson.
    const merged = useBoardCardDraftStore.persist
      .getOptions()
      .merge?.(
        { draftsByKey: { corrupt: { title: "Ship it" } } },
        useBoardCardDraftStore.getState(),
      );
    expect((merged as { draftsByKey: Record<string, unknown> }).draftsByKey).toEqual({});
  });
});

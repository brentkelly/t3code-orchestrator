/**
 * T3o new-card drafts (T3O-26) — the persisted store.
 *
 * One draft per board scope (`boardCardDraftKey`), autosaved while the create
 * dialog is open and restored the next time it opens. Shaped on
 * `boardUiStore.ts` — zustand `persist` over `resolveStorage`, its own key, a
 * `migrate` AND a `merge` sanitiser so hand-edited or corrupt storage cannot
 * poison state — with `composerDraftStore.ts`'s debounced writes and
 * `beforeunload` flush, which is what makes "save every ~0.7s" cheap.
 *
 * The dialog talks to this module through the plain functions below rather
 * than a hook: it writes on every keystroke and must not re-render itself for
 * its own writes.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createDebouncedStorage, createMemoryStorage } from "../lib/storage";
import {
  boardCardDraftContentEquals,
  boardCardDraftHasContent,
  parseBoardCardDraft,
  type BoardCardDraft,
} from "./boardCardDraft";

export const BOARD_CARD_DRAFT_STORAGE_KEY = "t3code:board-card-draft:v1";

/** The spec's "autosave every ~0.7s is enough". */
const BOARD_CARD_DRAFT_DEBOUNCE_MS = 700;

/** Exported for the persistence round-trip test; the app writes through the
    store and reads through `readBoardCardDraft`. */
export const boardCardDraftStorage = createDebouncedStorage(
  typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  BOARD_CARD_DRAFT_DEBOUNCE_MS,
);

// A tab closed mid-sentence must not lose the sentence.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("beforeunload", () => {
    boardCardDraftStorage.flush();
  });
}

interface BoardCardDraftState {
  draftsByKey: Readonly<Record<string, BoardCardDraft>>;
}

interface BoardCardDraftStore extends BoardCardDraftState {
  saveDraft: (key: string, draft: BoardCardDraft) => void;
  clearDraft: (key: string) => void;
}

/** Drop every record that is not a decodable draft with content. Runs on a
    version bump (`migrate`) and on every rehydrate (`merge`), since the
    latter is the only one that sees same-version corruption. */
export function sanitisePersistedBoardCardDrafts(persistedState: unknown): BoardCardDraftState {
  if (!persistedState || typeof persistedState !== "object") return { draftsByKey: {} };
  const candidate = (persistedState as Partial<BoardCardDraftState>).draftsByKey;
  if (!candidate || typeof candidate !== "object") return { draftsByKey: {} };
  const draftsByKey: Record<string, BoardCardDraft> = {};
  for (const [key, value] of Object.entries(candidate)) {
    const draft = parseBoardCardDraft(value);
    if (draft !== null) draftsByKey[key] = draft;
  }
  return { draftsByKey };
}

export const useBoardCardDraftStore = create<BoardCardDraftStore>()(
  persist(
    (set) => ({
      draftsByKey: {},
      saveDraft: (key, draft) =>
        set((state) => {
          // Falling below the content rule is how a draft is deleted: emptying
          // the fields must not leave a record that greets you next time.
          if (!boardCardDraftHasContent(draft)) {
            if (state.draftsByKey[key] === undefined) return state;
            const { [key]: _dropped, ...rest } = state.draftsByKey;
            return { draftsByKey: rest };
          }
          const previous = state.draftsByKey[key];
          // Most keystrokes change nothing that is stored (a caret move, a
          // re-render). Skipping those keeps both the write and the notify off
          // the hot path.
          if (previous !== undefined && boardCardDraftContentEquals(previous, draft)) return state;
          return { draftsByKey: { ...state.draftsByKey, [key]: draft } };
        }),
      clearDraft: (key) =>
        set((state) => {
          if (state.draftsByKey[key] === undefined) return state;
          const { [key]: _dropped, ...rest } = state.draftsByKey;
          return { draftsByKey: rest };
        }),
    }),
    {
      name: BOARD_CARD_DRAFT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => boardCardDraftStorage),
      migrate: sanitisePersistedBoardCardDrafts,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...sanitisePersistedBoardCardDrafts(persistedState),
      }),
      partialize: (state) => ({ draftsByKey: state.draftsByKey }),
    },
  ),
);

/** The stored draft for a scope, or null. */
export function readBoardCardDraft(key: string): BoardCardDraft | null {
  return useBoardCardDraftStore.getState().draftsByKey[key] ?? null;
}

export function saveBoardCardDraft(key: string, draft: BoardCardDraft): void {
  useBoardCardDraftStore.getState().saveDraft(key, draft);
}

export function clearBoardCardDraft(key: string): void {
  useBoardCardDraftStore.getState().clearDraft(key);
  // Discarding is a decision, not a keystroke — land it now rather than in
  // 0.7s, so a reload right after cannot resurrect what was just discarded.
  boardCardDraftStorage.flush();
}

/** Land the pending debounced write — called when the dialog closes. */
export function flushBoardCardDrafts(): void {
  boardCardDraftStorage.flush();
}

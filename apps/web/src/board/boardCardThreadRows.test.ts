import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardCardChatPresence,
  boardCardMissingThreadReason,
  cardThreadIdsMissingFromShell,
  type BoardCardThreadRows,
} from "./boardCardThreadRows";

const linkedAt = "2026-11-04T00:00:00.000Z";
const link = (id: string, extra: { tombstonedAt?: string; workerId?: string } = {}) => ({
  threadId: ThreadId.make(id),
  tombstonedAt: extra.tombstonedAt ?? null,
  ...(extra.workerId === undefined ? {} : { workerId: EnvironmentId.make(extra.workerId) }),
});

describe("cardThreadIdsMissingFromShell", () => {
  it("reads only this server's live links the shell left out", () => {
    const links = [
      link("in-shell"),
      link("older-settled"),
      link("deleted", { tombstonedAt: linkedAt }),
      link("on-worker", { workerId: "environment:worker" }),
    ];
    expect(cardThreadIdsMissingFromShell(links, [{ id: ThreadId.make("in-shell") }])).toEqual([
      ThreadId.make("older-settled"),
    ]);
  });
});

describe("boardCardChatPresence", () => {
  const threadId = ThreadId.make("thread");
  const rows = (
    input: Partial<Record<keyof BoardCardThreadRows, unknown>>,
  ): BoardCardThreadRows => ({
    threads: new Map(),
    loading: new Set(),
    failed: new Set(),
    ...(input as Partial<BoardCardThreadRows>),
  });

  it("opens a thread the shell or its family read holds", () => {
    expect(boardCardChatPresence({ threadId, inShell: true, rows: rows({}) })).toBe("open");
    const read = rows({ threads: new Map([[threadId, {}]]) });
    expect(boardCardChatPresence({ threadId, inShell: false, rows: read })).toBe("open");
  });

  it("calls a thread gone only once a read succeeded without it", () => {
    const loading = rows({ loading: new Set([threadId]) });
    expect(boardCardChatPresence({ threadId, inShell: false, rows: loading })).toBe("loading");
    const failed = rows({ failed: new Set([threadId]) });
    expect(boardCardChatPresence({ threadId, inShell: false, rows: failed })).toBe("failed");
    expect(boardCardChatPresence({ threadId, inShell: false, rows: rows({}) })).toBe("gone");
  });
});

describe("boardCardMissingThreadReason", () => {
  const threadId = ThreadId.make("thread");
  const reason = (archivedThreadIds: ReadonlyArray<ThreadId> | null, archivedLoading = false) =>
    boardCardMissingThreadReason({ threadId, archivedThreadIds, archivedLoading });

  it("names an archived thread instead of calling it gone", () => {
    expect(reason([threadId])).toBe("archived");
    expect(reason([threadId], true)).toBe("archived");
  });

  it("calls a thread gone only once the archived read lacks it", () => {
    expect(reason(null, true)).toBe("checking");
    expect(reason([], true)).toBe("checking");
    expect(reason(null)).toBe("unknown");
    expect(reason([ThreadId.make("other")])).toBe("gone");
  });
});

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { cardThreadIdsMissingFromShell } from "./boardCardThreadRows";

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

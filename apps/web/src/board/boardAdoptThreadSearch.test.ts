import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { boardAdoptableThreads } from "./boardAdoptThreadSearch";

const project = ProjectId.make("project:a");
const thread = (
  name: string,
  overrides: { projectId?: ProjectId; archivedAt?: DateTime.Utc } = {},
) => ({
  id: ThreadId.make(`thread:${name}`),
  projectId: overrides.projectId ?? project,
  archivedAt: overrides.archivedAt ?? null,
  title: name,
});

describe("boardAdoptableThreads", () => {
  it("offers only free threads in the card's project, once each", () => {
    const onOtherCard = new Set([ThreadId.make("thread:other-card")]);
    const options = boardAdoptableThreads({
      projectId: project,
      cardThreadIds: [ThreadId.make("thread:this-card")],
      linkedElsewhere: (threadId) => onOtherCard.has(threadId),
      threads: [
        thread("free"),
        thread("this-card"),
        thread("other-card"),
        thread("other-project", { projectId: ProjectId.make("project:b") }),
        thread("archived", { archivedAt: DateTime.makeUnsafe("2026-11-01T00:00:00.000Z") }),
        // A search row can repeat a shell row.
        thread("free"),
      ],
    });
    expect(options.map((option) => option.title)).toEqual(["free"]);
  });
});

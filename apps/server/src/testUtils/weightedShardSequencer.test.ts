import { describe, expect, it } from "vite-plus/test";

import { shuffleWithinProjects } from "./weightedShardSequencer.ts";

const files = [
  ...Array.from({ length: 6 }, (_, index) => ({ project: { name: "board" }, id: `b${index}` })),
  ...Array.from({ length: 6 }, (_, index) => ({ project: { name: "server" }, id: `s${index}` })),
];

describe("shuffleWithinProjects", () => {
  it("reorders files only within each project, the same way for the same seed", () => {
    const shuffled = shuffleWithinProjects(files, 7);

    expect(shuffled.map((file) => file.project.name)).toEqual(
      files.map((file) => file.project.name),
    );
    expect(shuffled.map((file) => file.id).toSorted()).toEqual(
      files.map((file) => file.id).toSorted(),
    );
    expect(shuffled.map((file) => file.id)).not.toEqual(files.map((file) => file.id));
    expect(shuffleWithinProjects(files, 7)).toEqual(shuffled);
    expect(shuffleWithinProjects(files, 8)).not.toEqual(shuffled);
  });
});

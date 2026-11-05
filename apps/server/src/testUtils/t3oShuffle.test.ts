import { describe, expect, it } from "vite-plus/test";

import type { TestSpecification, Vitest } from "vite-plus/test/node";

import { shuffleWithinProjects } from "./t3oShuffle.ts";
import { WeightedShardSequencer } from "./weightedShardSequencer.ts";

const files = [
  ...Array.from({ length: 6 }, (_, index) => ({ project: { name: "board" }, id: `b${index}` })),
  ...Array.from({ length: 6 }, (_, index) => ({ project: { name: "server" }, id: `s${index}` })),
];

describe("shuffleWithinProjects", () => {
  it("reorders files only within each project, the same way for the same seed, and not at all unseeded", () => {
    const shuffled = shuffleWithinProjects(files, "7");

    expect(shuffled.map((file) => file.project.name)).toEqual(
      files.map((file) => file.project.name),
    );
    expect(shuffled.map((file) => file.id).toSorted()).toEqual(
      files.map((file) => file.id).toSorted(),
    );
    expect(shuffled.map((file) => file.id)).not.toEqual(files.map((file) => file.id));
    expect(shuffleWithinProjects(files, "7")).toEqual(shuffled);
    expect(shuffleWithinProjects(files, "8")).not.toEqual(shuffled);
    expect(shuffleWithinProjects(files, undefined)).toEqual(files);
  });

  it("splits board and server files across shards, each file exactly once", async () => {
    const specs = files.map(
      (file) =>
        ({
          ...file,
          moduleId: `/repo/src/${file.project.name}/${file.id}.test.ts`,
        }) as unknown as TestSpecification,
    );
    const shardOf = (index: number) =>
      new WeightedShardSequencer({
        config: { root: "/repo", shard: { index, count: 2 } },
      } as unknown as Vitest).shard(specs);

    const [first, second] = await Promise.all([shardOf(1), shardOf(2)]);
    const ids = (shard: ReadonlyArray<TestSpecification>) =>
      shard.map((spec) => (spec as unknown as { id: string }).id);

    expect([...ids(first), ...ids(second)].toSorted()).toEqual(
      files.map((file) => file.id).toSorted(),
    );
    for (const shard of [first, second]) {
      expect(new Set(shard.map((spec) => spec.project.name))).toEqual(new Set(["board", "server"]));
    }
  });
});

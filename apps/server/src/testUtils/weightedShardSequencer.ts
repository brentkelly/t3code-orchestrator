// @effect-diagnostics nodeBuiltinImport:off - vitest loads this sequencer from the config,
// outside any Effect runtime, and only needs path.relative.
import * as NodePath from "node:path";

import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";

import shardWeights from "./shardWeights.json" with { type: "json" };

// Use the recorded median for new files.
const UNRECORDED_FILE_SECONDS = 0.6;

const recordedSeconds: Readonly<Record<string, number>> = shardWeights;

// Include import time (~1/3 of CI shards) in weights; derive identical splits so each file runs once.
export class WeightedShardSequencer extends BaseSequencer {
  // T3o: `T3O_SHUFFLE_SEED=<n>` reorders files within each project, to prove
  // the non-isolated board project does not depend on file order (T3O-45).
  override async sort(files: TestSpecification[]) {
    const sorted = await super.sort(files);
    const seed = process.env.T3O_SHUFFLE_SEED;
    return seed ? shuffleWithinProjects(sorted, Number(seed)) : sorted;
  }

  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const weighted = files
      .map((spec) => {
        const key = NodePath.relative(this.ctx.config.root, spec.moduleId).replaceAll("\\", "/");
        return { spec, key, seconds: recordedSeconds[key] ?? UNRECORDED_FILE_SECONDS };
      })
      .toSorted((a, b) => b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const loads = Array.from({ length: count }, () => 0);
    const picked: TestSpecification[] = [];
    for (const file of weighted) {
      const least = Math.min(...loads);
      const lightest = loads.indexOf(least);
      loads[lightest] = least + file.seconds;
      if (lightest === index - 1) picked.push(file.spec);
    }
    return picked;
  }
}

// T3o: mulberry32, so a failing order replays from its seed.
const seededRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const shuffleWithinProjects = <T extends { readonly project: { readonly name: string } }>(
  files: ReadonlyArray<T>,
  seed: number,
): Array<T> => {
  const random = seededRandom(seed);
  const out = [...files];
  let start = 0;
  while (start < out.length) {
    let end = start + 1;
    while (end < out.length && out[end]!.project.name === out[start]!.project.name) end += 1;
    for (let index = end - 1; index > start; index -= 1) {
      const pick = start + Math.floor(random() * (index - start + 1));
      [out[index], out[pick]] = [out[pick]!, out[index]!];
    }
    start = end;
  }
  return out;
};

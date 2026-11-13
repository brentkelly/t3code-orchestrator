/** The worker runs only a readiness script that is a file inside the repository (T3O-86). */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { committedReadinessScript } from "./BoardWorkerCapacityLive.ts";

const repo = (types: Record<string, string>) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const read = (args: ReadonlyArray<string>) =>
    Effect.sync(() => {
      calls.push(args);
      const object = args.at(-1)!;
      if (args[0] === "cat-file") return types[object] ?? null;
      if (args[0] === "rev-parse") return "blob-1\n";
      return "echo ready\n";
    });
  return { read, calls };
};

it.effect("a directory or an escaping path is no script; a file is read normalised", () =>
  Effect.gen(function* () {
    const { read, calls } = repo({ "origin/main:ci": "tree", "origin/main:ci/ready.sh": "blob" });
    assert.isNull(yield* committedReadinessScript(read, "origin/main", "ci"));
    assert.isNull(yield* committedReadinessScript(read, "origin/main", "../etc/passwd"));
    assert.lengthOf(calls, 1);
    assert.deepStrictEqual(yield* committedReadinessScript(read, "origin/main", "./ci//ready.sh"), {
      version: "blob-1",
      text: "echo ready\n",
    });
  }),
);

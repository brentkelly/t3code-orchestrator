/** The worker runs only a readiness script that is a file inside the repository (T3O-86). */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { committedReadinessBlob, committedReadinessScript } from "./BoardWorkerCapacityLive.ts";

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

it.effect(
  "a check's repository file is sized before it is read, raw and at most 64 KB (T3O-124)",
  () =>
    Effect.gen(function* () {
      const sizes: Record<string, string> = {
        "origin/main:.nvmrc": "8\n",
        "origin/main:big": "70000\n",
      };
      const calls: Array<ReadonlyArray<string>> = [];
      const read = (args: ReadonlyArray<string>) =>
        Effect.sync(() => {
          calls.push(args);
          const object = args.at(-1)!;
          if (args[2] === "-t") return object in sizes ? "blob\n" : null;
          if (args[2] === "-s") return sizes[object] ?? null;
          return "v22.1.0\n";
        });
      assert.strictEqual(yield* committedReadinessBlob(read, "origin/main", ".nvmrc"), "v22.1.0\n");
      assert.isNull(yield* committedReadinessBlob(read, "origin/main", "big"));
      assert.isNull(yield* committedReadinessBlob(read, "origin/main", "../outside"));
      for (const args of calls)
        assert.deepStrictEqual(args.slice(0, 2), ["--no-replace-objects", "cat-file"]);
      // The oversized blob was never read.
      assert.notDeepInclude(calls, ["--no-replace-objects", "cat-file", "blob", "origin/main:big"]);
    }),
);

// @effect-diagnostics nodeBuiltinImport:off - a real git dir for the marker and log.
/**
 * A card's setup on its worker (T3O-86): once per worktree, a marker on success, Retry runs
 * the script again, a timeout fails the stage, and no script is a setup that succeeded.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { BoardCardSetupProgress } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeCardSetup, SETUP_DONE_MARKER, type CardSetupScript } from "./cardSetup.ts";

type StepExit = {
  readonly status: "passed" | "failed" | "timed-out";
  readonly exitCode: number | null;
};

const harness = (exits: Array<StepExit>, script: CardSetupScript | null = defaultScript) => {
  const gitDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-setup-"));
  const commands: Array<string> = [];
  const setup = makeCardSetup({
    gitDir: () => Effect.succeed(gitDir),
    script: () => Effect.succeed(script),
    runStep: ((input: { readonly command: string; readonly tail: { push(text: string): void } }) =>
      Effect.sync(() => {
        commands.push(input.command);
        input.tail.push("installing\nready\n");
        return exits.shift() ?? { status: "passed", exitCode: 0 };
      })) as never,
  });
  return { setup, gitDir, commands };
};

const defaultScript: CardSetupScript = {
  command: "pnpm install",
  async: true,
  env: { T3CODE_PROJECT_ROOT: "/repo" },
};

const input = { cardId: "card-1", projectId: "p", worktreePath: "/w/card-1", timeoutMinutes: 30 };

const collect = (stream: Stream.Stream<BoardCardSetupProgress>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]));

it.effect("runs the setup script once per worktree, and only the script on Retry", () =>
  Effect.gen(function* () {
    const { setup, gitDir, commands } = harness([{ status: "passed", exitCode: 0 }]);
    const first = yield* collect(setup.run(input));
    const last = first.at(-1)!;
    assert.strictEqual(last.status, "succeeded");
    assert.deepStrictEqual(
      last.stages.map((stage) => [stage.stage, stage.status]),
      [
        ["fetch", "done"],
        ["checkout", "done"],
        ["submodules", "done"],
        ["setup-script", "done"],
      ],
    );
    assert.isTrue(NodeFS.existsSync(NodePath.join(gitDir, SETUP_DONE_MARKER)));
    assert.strictEqual(commands[0], "pnpm install");
    // A second provision of the same worktree runs nothing.
    yield* collect(setup.run(input));
    assert.lengthOf(commands, 1);
    assert.strictEqual(yield* setup.state(input.worktreePath), "done");
    // Retry runs the script again, and only the script.
    yield* collect(setup.run({ ...input, retry: true }));
    assert.lengthOf(commands, 2);
  }),
);

// Variables prefixed to the command text reached only its first simple command.
it.live("every command of a compound setup script sees the worktree and project variables", () =>
  Effect.gen(function* () {
    const gitDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-setup-"));
    const worktreePath = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-setup-wt-"));
    const setup = makeCardSetup({
      gitDir: () => Effect.succeed(gitDir),
      script: () =>
        Effect.succeed({
          command: 'true && printf "%s|%s" "$T3CODE_WORKTREE_PATH" "$T3CODE_PROJECT_ROOT"',
          async: true,
          env: { T3CODE_PROJECT_ROOT: "/repo" },
        }),
    });
    const last = (yield* collect(setup.run({ ...input, worktreePath }))).at(-1)!;
    assert.strictEqual(last.status, "succeeded");
    assert.include(last.tail ?? "", `${worktreePath}|/repo`);
  }),
);

it.effect("a second run while one is in flight in the worktree starts no second script", () =>
  Effect.gen(function* () {
    const gitDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3o-setup-"));
    let started = 0;
    const setup = makeCardSetup({
      gitDir: () => Effect.succeed(gitDir),
      script: () => Effect.succeed(defaultScript),
      runStep: (() =>
        Effect.sync(() => void (started += 1)).pipe(Effect.andThen(Effect.never))) as never,
    });
    yield* collect(setup.run(input).pipe(Stream.take(1)));
    const second = yield* collect(setup.run({ ...input, retry: true }));
    assert.deepStrictEqual(
      second.map((item) => [item.status, item.detail]),
      [["running", "Already running on the worker."]],
    );
    yield* setup.cancel(input.worktreePath);
  }),
);

it.effect("a failure or timeout fails the script stage, and later stages read skipped", () =>
  Effect.gen(function* () {
    const { setup } = harness([{ status: "timed-out", exitCode: null }]);
    const last = (yield* collect(setup.run(input))).at(-1)!;
    assert.strictEqual(last.status, "failed");
    assert.strictEqual(last.detail, "Timed out after 30 min.");
    assert.strictEqual(last.stages.at(-1)?.status, "failed");
    assert.strictEqual(yield* setup.state(input.worktreePath), "failed");
  }),
);

it.effect("upstream's async flag: a setup that holds the agent says so", () =>
  Effect.gen(function* () {
    const { setup } = harness([], { ...defaultScript, async: false });
    const progress = yield* collect(setup.run(input));
    assert.isTrue(progress.every((item) => item.blocking));
  }),
);

it.effect("no script, or a card that already built, is set up with nothing run", () =>
  Effect.gen(function* () {
    const none = harness([], null);
    const result = (yield* collect(none.setup.run(input))).at(-1)!;
    assert.strictEqual(result.status, "succeeded");
    assert.lengthOf(none.commands, 0);
    const built = harness([]);
    yield* collect(built.setup.run({ ...input, markOnly: true }));
    assert.lengthOf(built.commands, 0);
    assert.isTrue(NodeFS.existsSync(NodePath.join(built.gitDir, SETUP_DONE_MARKER)));
  }),
);

it.effect("a worktree with no setup run and no marker reads none: interrupted", () =>
  Effect.gen(function* () {
    const { setup } = harness([]);
    assert.strictEqual(yield* setup.state(input.worktreePath), "none");
  }),
);

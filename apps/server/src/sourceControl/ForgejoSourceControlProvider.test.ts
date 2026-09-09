import { assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ForgejoCli from "./ForgejoCli.ts";
import * as ForgejoSourceControlProvider from "./ForgejoSourceControlProvider.ts";
import type * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  FORGEJO_AUTH_STATUS_AUTHENTICATED,
  FORGEJO_AUTH_STATUS_UNAUTHENTICATED,
} from "./testing/forgejoFixtures.ts";

function makeProvider(forgejo: Partial<ForgejoCli.ForgejoCli["Service"]>) {
  return ForgejoSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(ForgejoCli.ForgejoCli)(forgejo)),
  );
}

const context: SourceControlProvider.SourceControlProviderContext = {
  provider: { kind: "forgejo", name: "Forgejo", baseUrl: "https://forgejo.example.test" },
  remoteName: "origin",
  remoteUrl: "https://forgejo.example.test/octocat/widgets.git",
};

function authProbe(stdout: string) {
  return { stdout, stderr: "", exitCode: ChildProcessSpawner.ExitCode(0) };
}

it.effect("maps Forgejo pull request summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 41,
          title: "Rate ideas and assign rock owners",
          url: "https://forgejo.example.test/octocat/widgets/pulls/41",
          baseRefName: "main",
          headRefName: "board/ma-3",
          state: "merged",
          isCrossRepository: false,
          headRepositoryNameWithOwner: "octocat/widgets",
          headRepositoryOwnerLogin: "octocat",
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      context,
      reference: "41",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "forgejo",
      number: 41,
      title: "Rate ideas and assign rock owners",
      url: "https://forgejo.example.test/octocat/widgets/pulls/41",
      baseRefName: "main",
      headRefName: "board/ma-3",
      state: "merged",
      updatedAt: Option.none(),
      isCrossRepository: false,
      headRepositoryNameWithOwner: "octocat/widgets",
      headRepositoryOwnerLogin: "octocat",
    });
  }),
);

it.effect("keeps the CLI's own words in `detail`, which is what the board shows", () =>
  Effect.gen(function* () {
    const cause = new ForgejoCli.ForgejoCliCommandError({
      operation: "execute",
      command: "fgj",
      cwd: "/repo",
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({ mergePullRequest: () => Effect.fail(cause) });

    const error = yield* provider
      .mergeChangeRequest({ cwd: "/repo", context, reference: "41", strategy: "squash" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "forgejo",
        operation: "mergeChangeRequest",
        command: "fgj",
        cwd: "/repo",
        reference: "41",
        detail: "Forgejo CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.strictEqual(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("merges through fgj rather than refusing the way the other non-GitHub hosts do", () =>
  Effect.gen(function* () {
    const mergePullRequest = vi.fn<ForgejoCli.ForgejoCli["Service"]["mergePullRequest"]>(
      () => Effect.void,
    );
    const provider = yield* makeProvider({ mergePullRequest });

    yield* provider.mergeChangeRequest({
      cwd: "/repo",
      context,
      reference: "41",
      strategy: "rebase",
    });

    expect(mergePullRequest).toHaveBeenCalledWith({
      cwd: "/repo",
      context,
      reference: "41",
      strategy: "rebase",
    });
  }),
);

it.effect("refuses to create a repository, and says why", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({});

    const error = yield* provider
      .createRepository({ cwd: "/repo", repository: "octocat/widgets", visibility: "private" })
      .pipe(Effect.flip);

    assert.strictEqual(error.provider, "forgejo");
    assert.strictEqual(error.operation, "createRepository");
    assert.strictEqual(
      error.detail,
      "Creating a repository is not supported for Forgejo. Create it on the host first.",
    );
  }),
);

it.effect("passes the resolved head selector through to the CLI", () =>
  Effect.gen(function* () {
    const listPullRequests = vi.fn<ForgejoCli.ForgejoCli["Service"]["listPullRequests"]>(() =>
      Effect.succeed([]),
    );
    const provider = yield* makeProvider({ listPullRequests });

    yield* provider.listChangeRequests({
      cwd: "/repo",
      context,
      headSelector: "hubot:patch-1",
      state: "open",
      limit: 5,
    });

    expect(listPullRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        headSelector: "hubot:patch-1",
        source: { owner: "hubot", refName: "patch-1" },
        state: "open",
        limit: 5,
      }),
    );
  }),
);

it("reports the signed-in instance and account from `fgj auth status`", () => {
  const auth = ForgejoSourceControlProvider.discovery.parseAuth(
    authProbe(FORGEJO_AUTH_STATUS_AUTHENTICATED),
  );

  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(Option.getOrNull(auth.account), "octocat");
  assert.deepStrictEqual(Option.getOrNull(auth.host), "forgejo.example.test");
});

it("reports unauthenticated when fgj holds no token, even though it exits 0", () => {
  const auth = ForgejoSourceControlProvider.discovery.parseAuth(
    authProbe(FORGEJO_AUTH_STATUS_UNAUTHENTICATED),
  );

  assert.strictEqual(auth.status, "unauthenticated");
  assert.strictEqual(
    Option.getOrNull(auth.detail),
    "Forgejo CLI is not authenticated. Run `fgj auth login` and retry.",
  );
});

it("degrades to unknown rather than throwing on output it cannot read", () => {
  const auth = ForgejoSourceControlProvider.discovery.parseAuth(
    authProbe("panic: runtime error\n"),
  );

  assert.strictEqual(auth.status, "unknown");
});

it("claims an unnamed host only when fgj holds a token for it", () => {
  const unknownRemote = {
    cwd: "/repo",
    context: {
      provider: {
        kind: "unknown" as const,
        name: "forgejo.example.test",
        baseUrl: "https://forgejo.example.test",
      },
      remoteName: "origin",
      remoteUrl: "https://forgejo.example.test/octocat/widgets.git",
    },
  };

  assert.deepStrictEqual(
    ForgejoSourceControlProvider.discovery.refineUnknownRemote?.({
      ...unknownRemote,
      auth: authProbe(FORGEJO_AUTH_STATUS_AUTHENTICATED),
    }),
    { kind: "forgejo", name: "Forgejo", baseUrl: "https://forgejo.example.test" },
  );

  assert.strictEqual(
    ForgejoSourceControlProvider.discovery.refineUnknownRemote?.({
      ...unknownRemote,
      auth: authProbe(FORGEJO_AUTH_STATUS_UNAUTHENTICATED),
    }),
    null,
  );
});

it("claims a host fgj listed without a readable login", () => {
  assert.deepStrictEqual(
    ForgejoSourceControlProvider.discovery.refineUnknownRemote?.({
      cwd: "/repo",
      context: {
        provider: {
          kind: "unknown" as const,
          name: "forgejo.example.test",
          baseUrl: "https://forgejo.example.test",
        },
        remoteName: "origin",
        remoteUrl: "https://forgejo.example.test/octocat/widgets.git",
      },
      auth: authProbe("Authenticated instances:\n  • forgejo.example.test\n"),
    }),
    { kind: "forgejo", name: "Forgejo", baseUrl: "https://forgejo.example.test" },
  );
});

it("does not claim a host fgj is signed in to under a different name", () => {
  assert.strictEqual(
    ForgejoSourceControlProvider.discovery.refineUnknownRemote?.({
      cwd: "/repo",
      context: {
        provider: {
          kind: "unknown" as const,
          name: "someone-else.example.test",
          baseUrl: "https://someone-else.example.test",
        },
        remoteName: "origin",
        remoteUrl: "https://someone-else.example.test/octocat/widgets.git",
      },
      auth: authProbe(FORGEJO_AUTH_STATUS_AUTHENTICATED),
    }),
    null,
  );
});

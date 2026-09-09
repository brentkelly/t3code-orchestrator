import { assert, describe, it } from "@effect/vitest";

import {
  findAuthenticatedForgejoHost,
  isAuthenticatedForgejoHost,
  parseForgejoAuthStatusHosts,
} from "./forgejoAuthStatus.ts";
import {
  FORGEJO_AUTH_STATUS_AUTHENTICATED,
  FORGEJO_AUTH_STATUS_UNAUTHENTICATED,
} from "./testing/forgejoFixtures.ts";

describe("parseForgejoAuthStatusHosts", () => {
  it("reads the instance and its login from a real capture", () => {
    assert.deepStrictEqual(parseForgejoAuthStatusHosts(FORGEJO_AUTH_STATUS_AUTHENTICATED), [
      { host: "forgejo.example.test", account: "octocat" },
    ]);
  });

  it("reads every instance when several are configured", () => {
    const hosts = parseForgejoAuthStatusHosts(`Authenticated instances:
  • codeberg.org (user: octocat)
  • forgejo.example.test:3000 (user: hubot)
`);

    assert.deepStrictEqual(hosts, [
      { host: "codeberg.org", account: "octocat" },
      { host: "forgejo.example.test:3000", account: "hubot" },
    ]);
  });

  it("finds nothing when fgj holds no token", () => {
    assert.deepStrictEqual(parseForgejoAuthStatusHosts(FORGEJO_AUTH_STATUS_UNAUTHENTICATED), []);
  });

  it("degrades to no hosts rather than throwing on unfamiliar output", () => {
    assert.deepStrictEqual(parseForgejoAuthStatusHosts(""), []);
    assert.deepStrictEqual(parseForgejoAuthStatusHosts("panic: runtime error\n\tgoroutine 1"), []);
  });

  it("keeps a host whose login fgj did not print", () => {
    assert.deepStrictEqual(parseForgejoAuthStatusHosts("  • codeberg.org"), [
      { host: "codeberg.org", account: null },
    ]);
  });
});

describe("findAuthenticatedForgejoHost", () => {
  it("skips a host with no login", () => {
    const hosts = parseForgejoAuthStatusHosts(`Authenticated instances:
  • codeberg.org
  • forgejo.example.test (user: octocat)
`);

    assert.deepStrictEqual(findAuthenticatedForgejoHost(hosts), {
      host: "forgejo.example.test",
      account: "octocat",
    });
  });
});

describe("isAuthenticatedForgejoHost", () => {
  const hosts = parseForgejoAuthStatusHosts(FORGEJO_AUTH_STATUS_AUTHENTICATED);

  it("matches the host regardless of case", () => {
    assert.strictEqual(isAuthenticatedForgejoHost(hosts, "Forgejo.Example.Test"), true);
  });

  it("does not match a different host", () => {
    assert.strictEqual(isAuthenticatedForgejoHost(hosts, "codeberg.org"), false);
  });

  it("treats a port as part of the host", () => {
    assert.strictEqual(isAuthenticatedForgejoHost(hosts, "forgejo.example.test:3000"), false);
  });
});

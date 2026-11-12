import { describe, expect, it } from "vite-plus/test";

import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { resolveAssetUrl } from "../state/assets.ts";
import { webhookAddress } from "../webhookAddress.ts";
import {
  environmentAddressKey,
  environmentBasePath,
  environmentSocketUrl,
  joinEnvironmentPath,
  withEnvironmentBasePath,
} from "./basePath.ts";
import { environmentEndpointUrl } from "./endpoint.ts";

const ROOT = "https://remote.example.com/";
const PREFIXED = "https://board.example/api/t3o/workers/w1/";

describe("environment base path", () => {
  it.each([
    [ROOT, "/api/auth/session", "https://remote.example.com/api/auth/session"],
    ["https://remote.example.com", "/oauth/token", "https://remote.example.com/oauth/token"],
    [`${ROOT}?x=1#h`, "/oauth/token", "https://remote.example.com/oauth/token"],
    [PREFIXED, "/api/auth/session", "https://board.example/api/t3o/workers/w1/api/auth/session"],
    [
      "https://board.example/api/t3o/workers/w1",
      "/oauth/token",
      "https://board.example/api/t3o/workers/w1/oauth/token",
    ],
    [
      PREFIXED,
      "/api/assets/a?token=t#frag",
      "https://board.example/api/t3o/workers/w1/api/assets/a?token=t#frag",
    ],
    [PREFIXED, "/", "https://board.example/api/t3o/workers/w1/"],
    [ROOT, "/", ROOT],
    // Only a worker proxy prefix is a base path; any other path is the root.
    ["https://host.example/ws", "/api/auth/session", "https://host.example/api/auth/session"],
  ])("joins %s + %s", (base, path, expected) => {
    expect(joinEnvironmentPath(base, path).toString()).toBe(expected);
  });

  it("keys an address by origin, plus the base path when there is one", () => {
    expect(environmentBasePath(ROOT)).toBe("");
    expect(environmentBasePath(PREFIXED)).toBe("/api/t3o/workers/w1");
    expect(environmentBasePath("https://host.example/ws")).toBe("");
    expect(environmentAddressKey("https://host.example/ws")).toBe("https://host.example");
    expect(environmentAddressKey(ROOT)).toBe("https://remote.example.com");
    expect(environmentAddressKey(PREFIXED)).toBe("https://board.example/api/t3o/workers/w1");
    expect(environmentAddressKey("https://board.example/api/t3o/workers/w2")).not.toBe(
      environmentAddressKey(PREFIXED),
    );
  });

  it("re-applies the base path after a root-only normaliser", () => {
    expect(withEnvironmentBasePath(ROOT, "https://remote.example.com")).toBe(ROOT);
    expect(withEnvironmentBasePath("wss://board.example/", PREFIXED)).toBe(
      "wss://board.example/api/t3o/workers/w1/",
    );
    // A pasted page path isn't a base: the environment is at the root.
    expect(
      withEnvironmentBasePath(
        "http://100.65.180.100:3773/",
        "http://100.65.180.100:3773/settings/connections",
      ),
    ).toBe("http://100.65.180.100:3773/");
  });

  it.each([
    ["wss://remote.example.com/", "wss://remote.example.com/ws"],
    ["wss://remote.example.com", "wss://remote.example.com/ws"],
    ["wss://remote.example.com/ws", "wss://remote.example.com/ws"],
    ["wss://board.example/api/t3o/workers/w1/", "wss://board.example/api/t3o/workers/w1/ws"],
    ["wss://board.example/api/t3o/workers/w1/ws", "wss://board.example/api/t3o/workers/w1/ws"],
    ["wss://board.example/api/t3o/workers/w1", "wss://board.example/api/t3o/workers/w1/ws"],
    ["wss://remote.example.com/socket", "wss://remote.example.com/socket"],
  ])("puts the RPC socket of %s at %s", (wsBaseUrl, expected) => {
    expect(environmentSocketUrl(wsBaseUrl).toString()).toBe(expected);
  });

  it.each([
    [ROOT, "https://remote.example.com/"],
    [PREFIXED, PREFIXED],
    ["https://remote.example.com/ws", "https://remote.example.com/"],
  ])("builders keep the base path of %s", (base, expectedRoot) => {
    expect(environmentEndpointUrl(base, "/oauth/token")).toBe(`${expectedRoot}oauth/token`);
    expect(makeEnvironmentHttpApiUrlBuilder(base).auth.session()).toBe(
      `${expectedRoot}api/auth/session`,
    );
    expect(resolveAssetUrl(base, "/api/assets/abc?sig=1")).toBe(
      `${expectedRoot}api/assets/abc?sig=1`,
    );
    expect(resolveAssetUrl(base, "https://cdn.example/x.png")).toBe("https://cdn.example/x.png");
    expect(
      webhookAddress({ path: "/api/webhooks/t1", url: null, hasSecret: false }, base).address,
    ).toBe(`${expectedRoot}api/webhooks/t1`);
  });
});

import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import {
  decodeForgejoPullRequestJson,
  decodeForgejoPullRequestListJson,
} from "./forgejoPullRequests.ts";
import { FORGEJO_PR_LIST_JSON, FORGEJO_PR_VIEW_JSON } from "./testing/forgejoFixtures.ts";

function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  assert.strictEqual(Result.isSuccess(result), true);
  if (!Result.isSuccess(result)) throw new Error("unreachable");
  return result.success;
}

describe("decodeForgejoPullRequestListJson", () => {
  const records = expectSuccess(decodeForgejoPullRequestListJson(FORGEJO_PR_LIST_JSON));

  it("reads every entry of a real `fgj pr list --json` capture", () => {
    assert.deepStrictEqual(
      records.map((record) => ({ number: record.number, state: record.state })),
      [
        { number: 37, state: "open" },
        { number: 41, state: "merged" },
        { number: 23, state: "closed" },
      ],
    );
  });

  it("reads the merged entry Forgejo files under `closed`", () => {
    const merged = records.find((record) => record.number === 41);

    assert.deepStrictEqual(
      { ...merged, updatedAt: Option.isSome(merged?.updatedAt ?? Option.none()) },
      {
        number: 41,
        title: "Rate ideas and assign rock owners",
        url: "https://forgejo.example.test/octocat/widgets/pulls/41",
        baseRefName: "main",
        headRefName: "board/ma-3",
        state: "merged",
        updatedAt: true,
        isCrossRepository: false,
        headRepositoryNameWithOwner: "octocat/widgets",
        headRepositoryOwnerLogin: "octocat",
      },
    );
  });

  it("keeps the update time Forgejo reports, normalised to UTC", () => {
    const open = records.find((record) => record.number === 37);

    assert.strictEqual(
      Option.map(open?.updatedAt ?? Option.none(), DateTime.formatIso).pipe(
        Option.getOrElse(() => ""),
      ),
      "2026-09-08T11:49:12.000Z",
    );
  });

  it("flags a fork's change request as cross-repository", () => {
    const decoded = expectSuccess(
      decodeForgejoPullRequestListJson(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify([
          {
            number: 7,
            title: "From a fork",
            html_url: "https://forgejo.example.test/octocat/widgets/pulls/7",
            base: { ref: "main", repo: { full_name: "octocat/widgets" } },
            head: { ref: "patch-1", repo: { full_name: "hubot/widgets" } },
            state: "open",
          },
        ]),
      ),
    );

    assert.deepStrictEqual(decoded[0]?.isCrossRepository, true);
    assert.deepStrictEqual(decoded[0]?.headRepositoryNameWithOwner, "hubot/widgets");
    assert.deepStrictEqual(decoded[0]?.headRepositoryOwnerLogin, "hubot");
  });

  it("drops an unreadable entry rather than the whole page", () => {
    const decoded = expectSuccess(
      decodeForgejoPullRequestListJson(
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify([
          { number: 0, title: "no number", html_url: "x", base: { ref: "a" }, head: { ref: "b" } },
          {
            number: 9,
            title: "  Valid  ",
            html_url: " https://forgejo.example.test/octocat/widgets/pulls/9 ",
            base: { ref: " main " },
            head: { ref: " feature " },
            state: "open",
          },
        ]),
      ),
    );

    assert.deepStrictEqual(
      decoded.map((record) => [record.number, record.title, record.headRefName]),
      [[9, "Valid", "feature"]],
    );
  });

  it("fails when the body is not a JSON array", () => {
    assert.strictEqual(Result.isSuccess(decodeForgejoPullRequestListJson("not json")), false);
    assert.strictEqual(Result.isSuccess(decodeForgejoPullRequestListJson("{}")), false);
  });
});

describe("decodeForgejoPullRequestJson", () => {
  it("reads a real `fgj pr view --json` capture", () => {
    const record = expectSuccess(decodeForgejoPullRequestJson(FORGEJO_PR_VIEW_JSON));

    assert.strictEqual(record.number, 41);
    assert.strictEqual(record.state, "merged");
    assert.strictEqual(record.headRefName, "board/ma-3");
  });

  it("fails on a body it cannot read", () => {
    assert.strictEqual(Result.isSuccess(decodeForgejoPullRequestJson("Error: nope")), false);
  });
});

import type { BoardProjectTokenCheck, BoardProjectTokenStatus } from "@t3tools/contracts";
import type { T3oProjectTokenInput } from "@t3tools/source-control-core/server/driver";
import { gitenvGitHubRepo, gitenvToken } from "@t3tools/shared/gitenv";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as GitHubRest from "./GitHubRest.ts";
import { T3oGitenvProject } from "./t3oGitenvCredential.ts";

const HOST = "github.com";

const decodeViewer = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ login: Schema.String })),
);

/**
 * T3o (T3O-58): Settings → Source Control's project tokens. For each project, where its
 * github.com token comes from (a gitenv folder, repo or owner line, else the ambient chain) and
 * whether GitHub accepts it, through the same request path every GitHub call takes, so a refusal
 * also logs the gitenv warning. One `GET /user` per distinct token; never returns a token.
 */
export const make = Effect.gen(function* () {
  const api = yield* GitHubRest.GitHubRest;

  const checkUser = (project: string) =>
    api.rest({ host: HOST, operation: "t3oProjectTokenStatus", path: "user" }).pipe(
      Effect.map((response): BoardProjectTokenCheck =>
        Option.match(decodeViewer(response.body), {
          onNone: () => ({ status: "error", message: "GitHub did not say who the token is." }),
          onSome: (viewer) => ({ status: "ok", login: viewer.login }),
        }),
      ),
      Effect.catch((error): Effect.Effect<BoardProjectTokenCheck> =>
        Effect.succeed(
          error._tag === "GitHubApiAuthenticationError"
            ? { status: "rejected" }
            : { status: "error", message: error.message },
        ),
      ),
      Effect.provideService(T3oGitenvProject, project),
    );

  return Effect.fn("T3oProjectTokens.status")(function* (
    projects: ReadonlyArray<T3oProjectTokenInput>,
  ) {
    const checked = new Map<string, BoardProjectTokenCheck>();
    const statuses: Array<BoardProjectTokenStatus> = [];
    for (const project of projects) {
      const root = project.workspaceRoot;
      const repo = gitenvGitHubRepo(root);
      const match = gitenvToken(root);
      const row = {
        projectId: project.projectId,
        title: project.title,
        repo: repo === null ? null : `${repo.owner}/${repo.repo}`,
        entryKey: match?.entry.key ?? null,
      };
      if (repo === null) {
        statuses.push({
          ...row,
          source: match?.entry.kind ?? "none",
          check: { status: "no-remote" },
        });
        continue;
      }
      const held = yield* Effect.result(
        api.credential(HOST).pipe(Effect.provideService(T3oGitenvProject, root)),
      );
      if (held._tag === "Failure") {
        statuses.push({
          ...row,
          source: "none",
          check: { status: "error", message: held.failure.message },
        });
        continue;
      }
      const { fingerprint, source } = held.success;
      let check = checked.get(fingerprint);
      if (check === undefined) {
        check = yield* checkUser(root);
        checked.set(fingerprint, check);
      }
      statuses.push({ ...row, source: match?.entry.kind ?? source ?? "gh", check });
    }
    return statuses;
  });
});

import * as Cause from "effect/Cause";
import type * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";

/**
 * `fgj pr list --json` and `fgj pr view --json` both emit the raw Gitea `PullRequest` struct —
 * roughly 10 KB per entry, most of it the nested `base.repo` and `head.repo` objects. Only the
 * handful of fields below are read; everything else is ignored rather than modelled.
 *
 * Forgejo carries the merged flag separately from the state, which is `open` or `closed` only, so
 * a merged PR reads as `closed` until `merged` is consulted.
 */
export interface NormalizedForgejoPullRequestRecord {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: Option.Option<DateTime.Utc>;
  readonly isCrossRepository?: boolean;
  readonly headRepositoryNameWithOwner?: string | null;
  readonly headRepositoryOwnerLogin?: string | null;
}

const ForgejoBranchSchema = Schema.Struct({
  ref: TrimmedNonEmptyString,
  repo: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        full_name: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const ForgejoPullRequestSchema = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  html_url: TrimmedNonEmptyString,
  base: ForgejoBranchSchema,
  head: ForgejoBranchSchema,
  state: Schema.optional(Schema.NullOr(Schema.String)),
  merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
  updated_at: Schema.optional(Schema.OptionFromNullOr(Schema.DateTimeUtcFromString)),
});

function trimOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeState(
  state: string | null | undefined,
  merged: boolean | null | undefined,
): "open" | "closed" | "merged" {
  if (merged === true) {
    return "merged";
  }
  return state?.trim().toLowerCase() === "closed" ? "closed" : "open";
}

function ownerLogin(nameWithOwner: string | null): string | null {
  const [owner] = nameWithOwner?.split("/") ?? [];
  return trimOptionalString(owner);
}

function normalizeForgejoPullRequestRecord(
  raw: Schema.Schema.Type<typeof ForgejoPullRequestSchema>,
): NormalizedForgejoPullRequestRecord {
  const headRepository = trimOptionalString(raw.head.repo?.full_name);
  const baseRepository = trimOptionalString(raw.base.repo?.full_name);
  const isCrossRepository =
    headRepository !== null && baseRepository !== null
      ? headRepository.toLowerCase() !== baseRepository.toLowerCase()
      : undefined;
  const headRepositoryOwnerLogin = ownerLogin(headRepository);

  return {
    number: raw.number,
    title: raw.title,
    url: raw.html_url,
    baseRefName: raw.base.ref,
    headRefName: raw.head.ref,
    state: normalizeState(raw.state, raw.merged),
    updatedAt: raw.updated_at ?? Option.none(),
    ...(typeof isCrossRepository === "boolean" ? { isCrossRepository } : {}),
    ...(headRepository ? { headRepositoryNameWithOwner: headRepository } : {}),
    ...(headRepositoryOwnerLogin ? { headRepositoryOwnerLogin } : {}),
  };
}

const decodeForgejoPullRequestList = decodeJsonResult(Schema.Array(Schema.Unknown));
const decodeForgejoPullRequest = decodeJsonResult(ForgejoPullRequestSchema);
const decodeForgejoPullRequestEntry = Schema.decodeUnknownExit(ForgejoPullRequestSchema);

export const formatForgejoJsonDecodeError = formatSchemaError;

/**
 * One unreadable entry drops itself rather than the whole page, matching the GitLab and Azure
 * decoders: a board card's badge is better served by the other change requests than by nothing.
 */
export function decodeForgejoPullRequestListJson(
  raw: string,
): Result.Result<
  ReadonlyArray<NormalizedForgejoPullRequestRecord>,
  Cause.Cause<Schema.SchemaError>
> {
  const result = decodeForgejoPullRequestList(raw);
  if (!Result.isSuccess(result)) {
    return Result.fail(result.failure);
  }

  const pullRequests: NormalizedForgejoPullRequestRecord[] = [];
  for (const entry of result.success) {
    const decodedEntry = decodeForgejoPullRequestEntry(entry);
    if (Exit.isFailure(decodedEntry)) {
      continue;
    }
    pullRequests.push(normalizeForgejoPullRequestRecord(decodedEntry.value));
  }
  return Result.succeed(pullRequests);
}

export function decodeForgejoPullRequestJson(
  raw: string,
): Result.Result<NormalizedForgejoPullRequestRecord, Cause.Cause<Schema.SchemaError>> {
  const result = decodeForgejoPullRequest(raw);
  return Result.isSuccess(result)
    ? Result.succeed(normalizeForgejoPullRequestRecord(result.success))
    : Result.fail(result.failure);
}

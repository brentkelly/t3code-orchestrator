/**
 * T3o (T3O-62): why a Set up on worker clone failed, from what git said.
 *
 * Pure. Git's wording is stable across the versions in use; anything not
 * recognised is `unknown` and the UI still offers the log.
 */
import type { BoardWorkerSetupFailureKind } from "@t3tools/contracts";

const RULES: ReadonlyArray<readonly [BoardWorkerSetupFailureKind, RegExp]> = [
  ["disk-full", /no space left on device|disk quota exceeded/i],
  ["folder-exists", /already exists and is not an empty directory|destination .* already exists/i],
  [
    "no-credentials",
    /permission denied \(publickey|could not read username|authentication failed|terminal prompts disabled|invalid username or password|host key verification failed/i,
  ],
  [
    "remote-unreachable",
    /could not resolve host|could not resolve hostname|connection refused|connection timed out|network is unreachable|unable to access|repository .* not found|does not appear to be a git repository/i,
  ],
];

export function classifyCloneFailure(text: string): BoardWorkerSetupFailureKind {
  for (const [kind, pattern] of RULES) {
    if (pattern.test(text)) return kind;
  }
  return "unknown";
}

/** The sentence a failure kind shows (prototype 2.3). */
export function cloneFailureMessage(kind: BoardWorkerSetupFailureKind, worker: string): string {
  switch (kind) {
    case "no-credentials":
      return `${worker} has no git credentials for this repository.`;
    case "remote-unreachable":
      return `${worker} couldn't reach the git remote.`;
    case "folder-exists":
      return "That folder already exists on the worker.";
    case "no-remote":
      return "This project has no git remote to clone from.";
    case "disk-full":
      return `${worker} ran out of disk space.`;
    case "worker-offline":
      return `${worker} went offline during the clone.`;
    case "unknown":
      return "The clone failed.";
  }
}

/** The repository's folder name, from its remote URL. */
export function repositoryFolderName(remoteUrl: string): string {
  const trimmed = remoteUrl.trim().replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).at(-1) ?? "";
  const name = last.replace(/\.git$/i, "");
  return name.length > 0 ? name : "repository";
}

/** `<folder>/<name>`, keeping a `~` the worker expands itself. */
export function cloneDestination(folder: string, remoteUrl: string): string {
  return `${folder.replace(/\/+$/, "")}/${repositoryFolderName(remoteUrl)}`;
}

// T3o: check:changed's comparison candidates for a fork (T3O-88). A fork's trunk is its
// remote's default branch (origin/HEAD -> origin/t3o), not main, so each remote also
// offers its HEAD target and that branch's local copy.
import * as Effect from "effect/Effect";

type Git<E, R> = (
  cwd: string,
  args: ReadonlyArray<string>,
) => Effect.Effect<{ toString(): string }, E, R>;

export const remoteCandidates = Effect.fn("checkChanged.remoteCandidates")(function* <E, R>(
  root: string,
  git: Git<E, R>,
) {
  const output = (args: ReadonlyArray<string>) =>
    git(root, args).pipe(
      Effect.map((stdout) => stdout.toString().trim()),
      Effect.orElseSucceed(() => ""),
    );
  const current = yield* output(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remotes = (yield* output(["remote"])).split("\n").filter(Boolean);
  const wanted: Array<{ ref: string; rev: string }> = [];
  for (const name of remotes) {
    wanted.push({ ref: name + "/main", rev: "refs/remotes/" + name + "/main" });
    const prefix = "refs/remotes/" + name + "/";
    const head = yield* output(["symbolic-ref", "--quiet", prefix + "HEAD"]);
    if (!head.startsWith(prefix)) continue;
    const branch = head.slice(prefix.length);
    wanted.push({ ref: name + "/" + branch, rev: head });
    // On the trunk itself its local copy is HEAD, which would hide every unpushed commit.
    if (branch !== current) wanted.push({ ref: branch, rev: "refs/heads/" + branch });
  }
  const candidates: Array<{ ref: string; rev: string }> = [];
  const seen = new Set<string>();
  for (const candidate of wanted) {
    const resolved = yield* output([
      "rev-parse",
      "--verify",
      "--quiet",
      candidate.rev + "^{commit}",
    ]);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    candidates.push(candidate);
  }
  return candidates;
});

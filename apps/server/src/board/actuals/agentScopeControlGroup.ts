/**
 * T3o (T3O-87): a thread's control group, behind upstream's per-agent scopes. Upstream's
 * `process/agentScope.ts` delegates `controlGroup` here in one line. A shared scope (Codex)
 * serves other threads too, so it answers null: one step can't be told apart in it.
 */
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

/** `ControlGroup=` from `systemctl show`, or null when absent or empty. */
export function parseControlGroup(stdout: string): string | null {
  const match = /^ControlGroup=(.*)$/m.exec(stdout);
  const value = match?.[1]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export const threadControlGroup = (
  tracked: { readonly unit: string; readonly shared: boolean } | undefined,
  systemd: Effect.Effect<{ readonly systemctl: string } | undefined>,
  run: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<Option.Option<{ readonly stdout: string; readonly code: number | null }>>,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    if (tracked === undefined || tracked.shared) return null;
    const scope = yield* systemd;
    if (scope === undefined) return null;
    const shown = yield* run(scope.systemctl, [
      "--user",
      "show",
      tracked.unit,
      "--property=ControlGroup",
    ]);
    if (shown._tag === "None" || shown.value.code !== 0) return null;
    return parseControlGroup(shown.value.stdout);
  });

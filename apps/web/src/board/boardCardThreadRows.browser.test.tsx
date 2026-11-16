/**
 * Opening a card names its threads the shell left out with one read, however many there are.
 */
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { useBoardCardOffShellThreads } from "./boardCardThreadRows";

const calls = vi.hoisted(() => ({
  titleReads: [] as Array<ReadonlyArray<string>>,
  familyReads: 0,
}));

function setup() {
  calls.titleReads = [];
  calls.familyReads = 0;
}

vi.mock(import("../state/orchestration"), async (original) => {
  const actual = await original();
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const atoms = new Map<string, unknown>();
  return {
    ...actual,
    orchestrationEnvironment: {
      ...actual.orchestrationEnvironment,
      threadTitles: ((target: { input: { threadIds: ReadonlyArray<string> } }) => {
        const key = JSON.stringify(target.input.threadIds);
        if (!atoms.has(key)) {
          calls.titleReads.push(target.input.threadIds);
          atoms.set(
            key,
            Atom.make(
              AsyncResult.success(
                Object.fromEntries(target.input.threadIds.map((id) => [id, `Title ${id}`])),
              ),
            ),
          );
        }
        return atoms.get(key);
      }) as never,
    },
  };
});

vi.mock(import("../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: {
      ...actual.threadFamilies,
      familyAtom: ((...args: Parameters<typeof actual.threadFamilies.familyAtom>) => {
        calls.familyReads += 1;
        return actual.threadFamilies.familyAtom(...args);
      }) as never,
    },
  };
});

// The shell of "environment-1" has its first snapshot; any other environment's has not.
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const Option = await import("effect/Option");
  const { EMPTY_SHELL_STATE } = await import("@t3tools/client-runtime/state/shell");
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((environmentId: string) =>
        Atom.make({
          ...EMPTY_SHELL_STATE,
          snapshot:
            environmentId === "environment-1" ? Option.some({ threads: [] }) : Option.none(),
        })) as never,
    },
  };
});

const threadIds = ["thread-1", "thread-2", "thread-3", "thread-4"].map((id) => ThreadId.make(id));

function Titles({ environmentId = "environment-1" }: { readonly environmentId?: string }) {
  const { titles, loading } = useBoardCardOffShellThreads(
    EnvironmentId.make(environmentId),
    threadIds,
  );
  return (
    <ul>
      {loading ? <li>loading</li> : null}
      {threadIds.map((id) => (
        <li key={id}>{titles.get(id) ?? "missing"}</li>
      ))}
    </ul>
  );
}

describe("useBoardCardOffShellThreads", () => {
  it("reads every off-shell thread's title in one request", async () => {
    setup();
    await using screen = await render(<Titles />, { router: false }); // a hook harness, no routes
    await expect.element(screen.getByText("Title thread-4")).toBeVisible();
    expect(calls.titleReads).toEqual([threadIds]);
    expect(calls.familyReads).toBe(0);
  });

  it("waits for the shell's first snapshot, when every thread is missing from it", async () => {
    setup();
    await using screen = await render(<Titles environmentId="environment-unloaded" />, {
      router: false, // a hook harness, no routes
    });
    await expect.element(screen.getByText("loading")).toBeVisible();
    expect(calls.titleReads).toEqual([]);
  });
});

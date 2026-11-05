/**
 * T3o (T3O-45): the server's tests as two projects. `src/board` runs
 * non-isolated: its files share one forked worker and one module graph, so a
 * full board run imports the provider-heavy graph once instead of once per
 * file. Board testkits therefore must not keep module-level state.
 */
const BOARD_TESTS = "src/board/**";

export const t3oServerTestProjects = [
  {
    extends: true,
    test: { name: "server", exclude: [BOARD_TESTS] },
  },
  {
    extends: true,
    test: {
      name: "board",
      include: [`${BOARD_TESTS}/*.test.ts`],
      isolate: false,
      // Appended to the inherited setup files.
      setupFiles: ["./src/testUtils/t3oBoardTest.setup.ts"],
      // Repo-root runs drop the root's pool, and `execArgv` only applies to forks.
      pool: "forks" as const,
      // Board agents share prod's cgroup; cap the one long-lived worker's heap. It peaks
      // ~1.0–1.15 GB RSS (712 MB isolated), the price of ~8x less CPU per full run.
      execArgv: ["--max-old-space-size=2048"],
      // vitest refuses a non-isolated project sharing a group with siblings
      // whose maxWorkers differ, which every repo-root run has.
      sequence: { groupOrder: 1 },
    },
  },
];

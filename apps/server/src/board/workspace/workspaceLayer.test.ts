/** `groupByWorkspace` costs one read per distinct workspace, not one per card (T3O-108 S4). */
import { BoardCardId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { bindBoardWorkspace, type BoardWorkspace } from "./BoardWorkspace.ts";
import { makeBoardWorkspaces, type BoardPlacementPass } from "./workspaceLayer.ts";

const alpha = ProjectId.make("project-alpha");
const beta = ProjectId.make("project-beta");
const worker = EnvironmentId.make("env-worker");
const card = (id: string, projectId: ProjectId) => ({ id: BoardCardId.make(id), projectId });

const localDeps = (rootReads: Array<string>) => ({
  git: {} as never,
  pullRequests: {} as never,
  retirer: {} as never,
  fileSystem: {} as never,
  path: {} as never,
  projectRoot: (projectId: ProjectId) =>
    Effect.sync(() => {
      rootReads.push(projectId);
      return `/tmp/${projectId}`;
    }),
  worktreeRoots: Effect.succeed([]),
});

it.effect("reads each local project once however many of its cards are grouped", () =>
  Effect.gen(function* () {
    const rootReads: Array<string> = [];
    const workspaces = makeBoardWorkspaces(localDeps(rootReads));
    const groups = yield* workspaces.groupByWorkspace([
      card("a1", alpha),
      card("a2", alpha),
      card("b1", beta),
      card("a3", alpha),
      card("b2", beta),
    ]);
    assert.deepStrictEqual(rootReads, [alpha, beta]);
    assert.deepStrictEqual(
      groups.map((group) => group.cards.map((grouped) => grouped.id)),
      [
        ["a1", "a2", "a3"],
        ["b1", "b2"],
      ],
    );
  }),
);

it.effect("shares one placement pass across the call and binds each remote workspace once", () =>
  Effect.gen(function* () {
    const passes = new Set<BoardPlacementPass | undefined>();
    let remoteBinds = 0;
    const workspaces = makeBoardWorkspaces(localDeps([]), {
      placementOf: (placed, pass) =>
        Effect.sync(() => {
          passes.add(pass);
          return placed.id.startsWith("r") ? { workerId: worker, projectId: alpha } : null;
        }),
      remote: (placement) =>
        Effect.sync(() => {
          remoteBinds++;
          return bindBoardWorkspace({
            workspace: { workerId: placement.workerId } as BoardWorkspace,
            projectId: placement.projectId,
            checkoutPath: "/worker/project",
          });
        }),
    });
    const groups = yield* workspaces.groupByWorkspace([
      card("r1", alpha),
      card("r2", alpha),
      card("l1", alpha),
      card("r3", alpha),
    ]);
    assert.strictEqual(remoteBinds, 1);
    assert.strictEqual(passes.size, 1);
    assert.isDefined([...passes][0]);
    assert.strictEqual(groups.length, 2);
  }),
);

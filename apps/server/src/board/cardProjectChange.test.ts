/**
 * T3O-33 — `board.card.set-project`, the decider half.
 *
 * The six refusals in the order the decider applies them, the happy path's
 * reissued key / cleared base pin, and the counter-sharing rule that keeps a
 * moved card and a newly created one out of each other's namespace.
 */
import {
  BoardCardId,
  BoardStageId,
  CommandId,
  ProjectId,
  ThreadId,
  type BoardCard,
  type BoardState,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { boardDecidedEvents, decideBoardCommand, type BoardCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");

function makeCard(
  overrides: Omit<Partial<BoardCard>, "id" | "stage"> & {
    readonly id: string;
    readonly stage?: string;
  },
): BoardCard {
  const { id, stage, ...rest } = overrides;
  return {
    key: "P1-1",
    cardNumber: 1,
    projectId,
    labels: [],
    orderKey: "m",
    title: "Card",
    briefRef: null,
    dependsOn: [],
    parentCardId: null,
    sourcePlanId: null,
    threadLinks: [],
    attachments: [],
    externalRef: null,
    humanInLoop: null,
    reviewOverrides: null,
    modelOverrides: null,
    splitRationale: null,
    baseBranch: null,
    scheduledStartAt: null,
    autoStart: false,
    worktree: null,
    pullRequest: null,
    pullRequestHistory: [],
    pullRequestFloor: null,
    blocked: false,
    archivedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...rest,
    stage: BoardStageId.make(stage ?? "backlog"),
    id: BoardCardId.make(id),
  };
}

function makeReadModel(board: BoardState): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: projectId,
        title: "Project 1",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
      {
        id: otherProjectId,
        title: "Project 2",
        workspaceRoot: "/tmp/project-2",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [],
    board,
  };
}

const setProjectCommand = (input: {
  readonly cardId: string;
  readonly projectId: ProjectId;
  readonly keyPrefix?: string;
}) =>
  ({
    type: "board.card.set-project",
    commandId: CommandId.make(`cmd-set-project-${input.cardId}`),
    cardId: BoardCardId.make(input.cardId),
    projectId: input.projectId,
    ...(input.keyPrefix === undefined ? {} : { keyPrefix: input.keyPrefix }),
    createdAt: NOW,
  }) as const satisfies BoardCommand;

const createCommand = (input: { readonly cardId: string; readonly projectId: ProjectId }) =>
  ({
    type: "board.card.create",
    commandId: CommandId.make(`cmd-create-${input.cardId}`),
    cardId: BoardCardId.make(input.cardId),
    projectId: input.projectId,
    title: "New card",
    keyPrefix: "P2",
    createdAt: NOW,
  }) as const satisfies BoardCommand;

const decide = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  decideBoardCommand({ command, readModel }).pipe(
    Effect.map((decision) => boardDecidedEvents(decision)[0]!),
  );

const decideFail = (command: BoardCommand, readModel: OrchestrationReadModel) =>
  Effect.flip(decide(command, readModel));

/** A card sitting in Ready, which is the state the whole feature is for. */
const movable = makeCard({ id: "card-1", stage: "ready", key: "P1-4", cardNumber: 4 });

it.layer(NodeServices.layer)("board.card.set-project", (it) => {
  describe("refusals", () => {
    it.effect("refuses a card that does not exist", () =>
      Effect.gen(function* () {
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "ghost", projectId: otherProjectId }),
          makeReadModel({ cards: [], nextCardNumberByProject: {} }),
        );
        assert.include(String(failure), "does not exist");
      }),
    );

    it.effect("refuses an archived card", () =>
      Effect.gen(function* () {
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "card-1", projectId: otherProjectId }),
          makeReadModel({
            cards: [makeCard({ id: "card-1", stage: "ready", archivedAt: NOW })],
            nextCardNumberByProject: {},
          }),
        );
        assert.include(String(failure), "is archived");
      }),
    );

    it.effect("refuses a project that is not on this server", () =>
      Effect.gen(function* () {
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "card-1", projectId: ProjectId.make("project-gone") }),
          makeReadModel({ cards: [movable], nextCardNumberByProject: {} }),
        );
        assert.strictEqual(failure._tag, "OrchestrationCommandInvariantError");
      }),
    );

    // Refused rather than accepted as a no-op: an accepted no-op would still
    // emit an event, and that event would reissue the key for nothing.
    it.effect("refuses the project the card is already in", () =>
      Effect.gen(function* () {
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "card-1", projectId }),
          makeReadModel({ cards: [movable], nextCardNumberByProject: {} }),
        );
        assert.include(String(failure), "is already in project");
      }),
    );

    it.effect("refuses a sub-board child, naming its parent", () =>
      Effect.gen(function* () {
        const parent = makeCard({ id: "parent", stage: "building" });
        const child = makeCard({
          id: "child",
          stage: "ready",
          parentCardId: BoardCardId.make("parent"),
        });
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "child", projectId: otherProjectId }),
          makeReadModel({ cards: [parent, child], nextCardNumberByProject: {} }),
        );
        assert.include(String(failure), "sub-board child");
        assert.include(String(failure), "parent");
      }),
    );

    // `boardCardChildren`, not `boardCardUnfinishedChildren`: an ARCHIVED child
    // is still a card holding a number in the parent's project namespace.
    it.effect("refuses a split parent, archived children included", () =>
      Effect.gen(function* () {
        const parent = makeCard({ id: "parent", stage: "ready" });
        const child = makeCard({
          id: "child",
          stage: "ready",
          archivedAt: NOW,
          parentCardId: BoardCardId.make("parent"),
        });
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "parent", projectId: otherProjectId }),
          makeReadModel({ cards: [parent, child], nextCardNumberByProject: {} }),
        );
        assert.include(String(failure), "split into 1 sub-board card");
      }),
    );

    it.effect("refuses a card that has reached the build stage", () =>
      Effect.gen(function* () {
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "card-1", projectId: otherProjectId }),
          makeReadModel({
            cards: [makeCard({ id: "card-1", stage: "building" })],
            nextCardNumberByProject: {},
          }),
        );
        assert.include(String(failure), "already been built");
      }),
    );

    // The stage test alone is not enough in EITHER direction. A card dragged
    // back out of Building still owns a worktree on the old project's checkout.
    it.effect("refuses a card dragged back out of Building that still owns a worktree", () =>
      Effect.gen(function* () {
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "card-1", projectId: otherProjectId }),
          makeReadModel({
            cards: [
              makeCard({
                id: "card-1",
                stage: "ready",
                worktree: {
                  branch: "board/p1-4",
                  baseRefName: "main",
                  path: "/tmp/worktrees/p1-4",
                  status: "ready",
                  attempts: 1,
                  lastError: null,
                  reclaimBlockedReason: null,
                },
              }),
            ],
            nextCardNumberByProject: {},
          }),
        );
        assert.include(String(failure), "already been built");
      }),
    );

    // The other direction: a card whose branch was cleaned up at Done still has
    // its key printed on a merged pull request.
    it.effect("refuses a card whose worktree is gone but whose PR history is not", () =>
      Effect.gen(function* () {
        const failure = yield* decideFail(
          setProjectCommand({ cardId: "card-1", projectId: otherProjectId }),
          makeReadModel({
            cards: [
              makeCard({
                id: "card-1",
                stage: "ready",
                pullRequestHistory: [
                  {
                    provider: "github",
                    number: 12,
                    url: "https://example.test/pr/12",
                    state: "merged",
                    title: "P1-4",
                    branch: "board/p1-4",
                    baseBranch: "main",
                    isDraft: false,
                    checkedAt: NOW,
                  },
                ],
              }),
            ],
            nextCardNumberByProject: {},
          }),
        );
        assert.include(String(failure), "already been built");
      }),
    );
  });

  describe("the move", () => {
    it.effect("reissues the key from the target project's counter and clears the base pin", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setProjectCommand({
            cardId: "card-1",
            projectId: otherProjectId,
            keyPrefix: "MW",
          }),
          makeReadModel({
            cards: [{ ...movable, baseBranch: "release/2.0" }],
            nextCardNumberByProject: { [projectId]: 5, [otherProjectId]: 43 },
          }),
        );
        assert.strictEqual(event.type, "board.card-project-changed");
        if (event.type !== "board.card-project-changed") return;
        expect(event.payload).toMatchObject({
          cardId: "card-1",
          previousProjectId: projectId,
          previousKey: "P1-4",
          previousCardNumber: 4,
        });
        expect(event.payload.card).toMatchObject({
          id: "card-1",
          projectId: otherProjectId,
          key: "MW-43",
          cardNumber: 43,
          // A branch named in the old project's checkout says nothing about the
          // new one, and a stale pin fails at provisioning hours later (D5).
          baseBranch: null,
          // Everything else survives: the card id never changes, so the open
          // modal, its attachments and its board position are unaffected.
          stage: "ready",
          orderKey: "m",
        });
      }),
    );

    it.effect("keeps dependencies, labels and the brief pointer", () =>
      Effect.gen(function* () {
        const dependency = makeCard({ id: "dep", stage: "done" });
        const event = yield* decide(
          setProjectCommand({ cardId: "card-1", projectId: otherProjectId }),
          makeReadModel({
            cards: [
              dependency,
              {
                ...movable,
                dependsOn: [BoardCardId.make("dep")],
                briefRef: "brief",
                externalRef: "TICKET-9",
              },
            ],
            nextCardNumberByProject: {},
          }),
        );
        assert.strictEqual(event.type, "board.card-project-changed");
        if (event.type !== "board.card-project-changed") return;
        // D3: `dependsOn` stores card ids, and the decider has never enforced a
        // same-project rule, so an inherited cross-project edge is legal and the
        // gate handles it. Nothing to rewrite.
        assert.deepStrictEqual([...event.payload.card.dependsOn], ["dep"]);
        assert.strictEqual(event.payload.card.briefRef, "brief");
        assert.strictEqual(event.payload.card.externalRef, "TICKET-9");
      }),
    );

    it.effect("falls back to the default prefix when the command names none", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setProjectCommand({ cardId: "card-1", projectId: otherProjectId }),
          makeReadModel({ cards: [movable], nextCardNumberByProject: {} }),
        );
        if (event.type !== "board.card-project-changed") return assert.fail("wrong event");
        assert.strictEqual(event.payload.card.key, "CARD-1");
      }),
    );

    // A moved card and a created one draw from ONE counter, so the two paths
    // can never hand out the same key in the same project.
    it.effect("draws from the same counter a create in the target project would", () =>
      Effect.gen(function* () {
        const board: BoardState = {
          cards: [movable],
          nextCardNumberByProject: { [otherProjectId]: 9 },
        };
        const created = yield* decide(
          createCommand({ cardId: "card-new", projectId: otherProjectId }),
          makeReadModel(board),
        );
        const moved = yield* decide(
          setProjectCommand({ cardId: "card-1", projectId: otherProjectId, keyPrefix: "P2" }),
          makeReadModel(board),
        );
        if (created.type !== "board.card-created") return assert.fail("wrong event");
        if (moved.type !== "board.card-project-changed") return assert.fail("wrong event");
        assert.strictEqual(created.payload.key, "P2-9");
        assert.strictEqual(moved.payload.card.key, "P2-9");
      }),
    );

    it.effect("moves a card that has a live thread link, keeping the link", () =>
      Effect.gen(function* () {
        const event = yield* decide(
          setProjectCommand({ cardId: "card-1", projectId: otherProjectId }),
          makeReadModel({
            cards: [
              {
                ...movable,
                stage: BoardStageId.make("planning"),
                threadLinks: [
                  {
                    threadId: ThreadId.make("thread-1"),
                    role: "planning",
                    linkedAt: NOW,
                    tombstonedAt: null,
                  },
                ],
              },
            ],
            nextCardNumberByProject: {},
          }),
        );
        if (event.type !== "board.card-project-changed") return assert.fail("wrong event");
        // Threads are history (D2). Stopping the live one is the reactor's job,
        // and the plan a thread produced lives on the card, not in the thread.
        assert.strictEqual(event.payload.card.threadLinks.length, 1);
        assert.strictEqual(event.payload.card.threadLinks[0]!.tombstonedAt, null);
      }),
    );
  });
});

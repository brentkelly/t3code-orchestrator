/**
 * t3o-14 — the client-side planning spawn.
 *
 * "Restart planning" in the card pane must produce the same KIND of thread the
 * supervisor produces on stage entry. The prompt, title and the two thread modes
 * come from `@t3tools/contracts` so they cannot drift; these tests lock the rest
 * of the bootstrap — the part that decides where the thread runs and what it is
 * allowed to do — against the reactor's copy in `spawnPlanningThread`.
 */
import {
  BOARD_PLANNING_THREAD_INTERACTION_MODE,
  BOARD_PLANNING_THREAD_RUNTIME_MODE,
  DEFAULT_BOARD_PLANNING_STEP,
  MessageId,
  ProjectId,
  ThreadId,
  boardPlanningThreadTitle,
  composeBoardPlanningPrompt,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { blankThreadCreateInput, planningThreadTurnInput } from "./boardCardThreadSpawn";

const card = {
  key: "MW-12",
  title: "Auto-spawn planning threads",
  projectId: ProjectId.make("11111111-1111-4111-8111-111111111111"),
};
const threadId = ThreadId.make("thread-22222222-2222-4222-8222-222222222222");
const messageId = MessageId.make("msg-33333333-3333-4333-8333-333333333333");
const createdAt = "2026-01-01T00:00:00.000Z";

describe("planningThreadTurnInput", () => {
  const input = planningThreadTurnInput({
    card,
    step: DEFAULT_BOARD_PLANNING_STEP,
    threadId,
    messageId,
    createdAt,
  });

  it("sends the shared envelope, not a locally composed prompt", () => {
    expect(input.message.text).toBe(
      composeBoardPlanningPrompt({ card, step: DEFAULT_BOARD_PLANNING_STEP }),
    );
    expect(input.bootstrap?.createThread?.title).toBe(
      boardPlanningThreadTitle(card, DEFAULT_BOARD_PLANNING_STEP),
    );
  });

  it("opens on the project workspace with no worktree and no branch", () => {
    // Planning is a conversation about a card that may never be built — it must
    // not cost a branch, and the reactor's copy must agree.
    expect(input.bootstrap?.createThread?.worktreePath).toBe(null);
    expect(input.bootstrap?.createThread?.branch).toBe(null);
    expect(input.bootstrap?.createThread?.projectId).toBe(card.projectId);
  });

  it("cannot write unattended: the shared modes, on the turn AND the bootstrap", () => {
    // The thread runs on the SHARED working tree with nothing human-gating its
    // start, so `full-access` here would mean an auto-approving agent with write
    // access to the user's real checkout. Both places must carry the same modes:
    // the bootstrap creates the thread, the turn runs it.
    expect(BOARD_PLANNING_THREAD_RUNTIME_MODE).toBe("approval-required");
    expect(input.runtimeMode).toBe(BOARD_PLANNING_THREAD_RUNTIME_MODE);
    expect(input.bootstrap?.createThread?.runtimeMode).toBe(BOARD_PLANNING_THREAD_RUNTIME_MODE);
    expect(input.interactionMode).toBe(BOARD_PLANNING_THREAD_INTERACTION_MODE);
    expect(input.bootstrap?.createThread?.interactionMode).toBe(
      BOARD_PLANNING_THREAD_INTERACTION_MODE,
    );
  });

  it("pins the step's own provider and model on both the turn and the bootstrap", () => {
    const selection = {
      instanceId: DEFAULT_BOARD_PLANNING_STEP.providerInstanceId,
      model: DEFAULT_BOARD_PLANNING_STEP.model,
    };
    expect(input.modelSelection).toEqual(selection);
    expect(input.bootstrap?.createThread?.modelSelection).toEqual(selection);
  });
});

describe("blankThreadCreateInput", () => {
  const selection = { instanceId: "claude" as never, model: "sonnet" };
  const input = blankThreadCreateInput({ card, threadId, modelSelection: selection, createdAt });

  it("creates a real, empty thread on the project workspace", () => {
    expect(input.threadId).toBe(threadId);
    expect(input.projectId).toBe(card.projectId);
    expect(input.title).toBe("MW-12 · Thread");
    expect(input.worktreePath).toBe(null);
    expect(input.branch).toBe(null);
  });

  it("is an ordinary thread — the planning modes are not imposed on it", () => {
    // You asked for a blank thread to type into; it behaves like one started
    // from the Threads view, not like the auto-spawned planning thread.
    expect(input.interactionMode).toBe("default");
    expect(input.modelSelection).toEqual(selection);
  });
});

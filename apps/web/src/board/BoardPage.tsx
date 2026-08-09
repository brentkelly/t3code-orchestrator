/**
 * T3o walking-skeleton board page: a bare list of card titles plus a minimal
 * create form, proving the full seam path command → event → projection →
 * shell delta → pixel. The real board UI arrives with t3o-05/06.
 */
import { BoardCardId, type BoardCardShell, type EnvironmentId } from "@t3tools/contracts";
import { boardColumnAppendOrderKey } from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { useState } from "react";

import { randomUUID } from "../lib/utils";
import { environmentShell } from "../state/shell";
import { boardEnvironment } from "../state/board";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";

export function BoardPage() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">Board</h1>
        <Link className="text-sm text-muted-foreground underline" to="/">
          Threads
        </Link>
      </div>
      {environmentId === null ? (
        <p className="text-sm text-muted-foreground">No connected environment.</p>
      ) : (
        <EnvironmentBoard environmentId={environmentId} />
      )}
    </div>
  );
}

function EnvironmentBoard({ environmentId }: { environmentId: EnvironmentId }) {
  const shellState = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const createCard = useAtomCommand(boardEnvironment.createCard);
  const [title, setTitle] = useState("");

  const snapshot = Option.getOrNull(shellState.snapshot);
  const cards: ReadonlyArray<BoardCardShell> = snapshot?.cards ?? [];
  const defaultProject = snapshot?.projects[0] ?? null;

  const submit = async () => {
    if (defaultProject === null || title.trim().length === 0) return;
    await createCard({
      environmentId,
      input: {
        cardId: BoardCardId.make(randomUUID()),
        projectId: defaultProject.id,
        title,
        cardType: "feature",
        // Fractional key appended after the current Backlog tail (client
        // computes, server stores — the pinOrderKey precedent).
        orderKey: boardColumnAppendOrderKey(cards.filter((card) => card.stage === "backlog")),
      },
    });
    setTitle("");
  };

  return (
    <div className="flex max-w-md flex-col gap-3">
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="flex-1 rounded-md border border-input bg-transparent px-2 py-1 text-sm"
          onChange={(event) => setTitle(event.target.value)}
          placeholder={
            defaultProject === null ? "No project available" : `New card in ${defaultProject.title}`
          }
          value={title}
        />
        <button
          className="rounded-md border border-input px-2 py-1 text-sm"
          disabled={defaultProject === null || title.trim().length === 0}
          type="submit"
        >
          Add
        </button>
      </form>
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">No cards yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {cards.map((card) => (
            <li className="rounded-md border border-border px-3 py-2 text-sm" key={card.cardId}>
              {card.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default BoardPage;

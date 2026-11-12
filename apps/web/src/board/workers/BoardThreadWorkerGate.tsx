/**
 * T3o (prototype 6.4): a card thread on a worker opens in the worker's environment, reached
 * through the board. The gate mints that access on first open and re-mints a refused session
 * once; until the thread can open, the pane says why instead of showing the chat.
 */
import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { environmentCatalog } from "../../connection/catalog";
import { cn } from "../../lib/utils";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  boardConnectionIsDirect,
  isWorkerProxyEntry,
  workerThreadAccess,
  workerThreadAccessCopy,
  type BoardThreadWorker,
  type WorkerThreadAccess,
} from "./threadWorker";
import { openWorkerThreadEnvironment } from "./workerThreadEnvironments";

type MintReason = "register" | "reauthorize";

/** This device's way into a thread on `worker`. */
function useWorkerThreadAccess(worker: BoardThreadWorker): WorkerThreadAccess {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const state = useAtomValue(environmentCatalog.stateAtom(worker.environmentId));
  const prepared = Option.getOrNull(usePreparedConnection(worker.boardEnvironmentId));
  const entry = Option.getOrNull(usePreparedConnection(worker.environmentId));
  const connection = catalog.entries.has(worker.environmentId)
    ? Option.getOrElse(AsyncResult.value(state), () => AVAILABLE_CONNECTION_STATE)
    : null;
  return workerThreadAccess({
    worker,
    connection,
    boardDirect: boardConnectionIsDirect(prepared),
    throughBoard: isWorkerProxyEntry({
      workerId: worker.workerId,
      boardHttpBaseUrl: prepared?.httpBaseUrl ?? null,
      entryHttpBaseUrl: entry?.httpBaseUrl ?? null,
    }),
  });
}

export function BoardThreadWorkerGate({
  worker,
  children,
}: {
  readonly worker: BoardThreadWorker;
  /** The thread itself, in the environment it opens in. */
  readonly children: (environmentId: EnvironmentId) => ReactNode;
}) {
  const access = useWorkerThreadAccess(worker);
  const open = useAtomCommand(openWorkerThreadEnvironment, { reportFailure: false });
  // One automatic mint per reason until the thread opens; after that the human retries.
  const attempted = useRef(new Set<MintReason>());
  const minting = useRef(false);
  const [failure, setFailure] = useState<{
    readonly reason: MintReason;
    readonly message: string;
  } | null>(null);

  const mint = (reason: MintReason) => {
    attempted.current.add(reason);
    minting.current = true;
    void open({
      boardEnvironmentId: worker.boardEnvironmentId,
      workerId: worker.environmentId,
      label: worker.label,
    }).then((result) => {
      minting.current = false;
      if (result._tag === "Success") {
        setFailure(null);
        return;
      }
      const error: unknown = squashAtomCommandFailure(result);
      setFailure({
        reason,
        message:
          error instanceof Error && error.message.length > 0
            ? error.message
            : `Couldn't open ${worker.label} through the board.`,
      });
    });
  };

  // `mint` is a fresh closure every render; the access state is what matters.
  const mintFor = useEffectEvent((reason: MintReason) => {
    if (!attempted.current.has(reason)) {
      mint(reason);
    } else if (!minting.current) {
      // The worker refused what was just minted: a fresh mint would be refused too.
      setFailure({
        reason,
        message: `${worker.label} refused the access the board just issued. Retry, or check the worker's clock and any proxy in front of the board.`,
      });
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers the worker's proxied environment with the client's connection registry, once per reason until it opens.
  useEffect(() => {
    // A later refusal (expiry, revocation) after the thread opened re-mints once more.
    if (access === "open") attempted.current.clear();
    if (access === "register" || access === "reauthorize") mintFor(access);
  }, [access]);

  if (access === "open") return <>{children(worker.environmentId)}</>;
  const shownFailure = failure !== null && failure.reason === access ? failure.message : null;
  const copy =
    shownFailure !== null
      ? {
          title: `Couldn't open ${worker.label}'s thread`,
          detail: shownFailure,
          tone: "muted" as const,
        }
      : workerThreadAccessCopy(access, worker);
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center p-4">
      <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-border bg-card p-4">
        <div
          className={cn(
            "text-board-13 font-medium",
            copy.tone === "warning" ? "text-warning-foreground" : "text-foreground",
          )}
        >
          {copy.title}
        </div>
        <div className="text-board-12-5 leading-board-1-6 text-pretty text-muted-foreground">
          {copy.detail}
        </div>
        {shownFailure !== null && (access === "register" || access === "reauthorize") ? (
          <div className="pt-0.5">
            <Button
              onClick={() => {
                setFailure(null);
                mint(access);
              }}
              size="sm"
              variant="outline"
            >
              Retry
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

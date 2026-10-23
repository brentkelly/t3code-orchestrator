/**
 * T3o (T3O-63; prototype 7.2/7.3): a card thread that runs on a worker opens
 * in that worker's environment, which this device may not be connected to.
 * Until it is, the thread pane says so — and offers the way there — instead
 * of showing the chat. The rest of the card stays fully usable.
 */
import { useAtomValue } from "@effect/atom-react";
import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import * as Option from "effect/Option";
import type { ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { environmentCatalog } from "../../connection/catalog";
import { cn } from "../../lib/utils";
import {
  workerThreadAccess,
  workerThreadAccessCopy,
  type BoardThreadWorker,
  type WorkerThreadAccess,
} from "./threadWorker";

/** This device's way into a thread on `worker`. */
export function useWorkerThreadAccess(worker: BoardThreadWorker): WorkerThreadAccess {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const state = useAtomValue(environmentCatalog.stateAtom(worker.environmentId));
  const connection = catalog.entries.has(worker.environmentId)
    ? Option.getOrElse(AsyncResult.value(state), () => AVAILABLE_CONNECTION_STATE)
    : null;
  return workerThreadAccess({ worker, connection });
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
  const navigate = useNavigate();
  if (access === "open") return <>{children(worker.environmentId)}</>;
  const copy = workerThreadAccessCopy(access, worker);
  // Sign in acts on the environment this device already has, so it opens the
  // list as is; only a worker with no entry here prefills Add environment.
  const openConnections = () =>
    void navigate({
      to: "/settings/connections",
      search: copy.action === "sign-in" || worker.url === null ? {} : { addHost: worker.url },
    });
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-center p-4">
      <div className="flex flex-col gap-2.5 rounded-xl border border-dashed border-border bg-card p-4">
        <div
          className={cn(
            "text-[13px] font-medium",
            copy.tone === "attention" ? "text-attention-foreground" : "text-foreground",
          )}
        >
          {copy.title}
        </div>
        <div className="text-[12.5px]/[1.6] text-pretty text-muted-foreground">{copy.detail}</div>
        {copy.action === null ? null : (
          <div className="pt-0.5">
            <Button onClick={openConnections} size="sm" variant="outline">
              {copy.action === "sign-in" ? "Sign in" : "Open Settings → Connections"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

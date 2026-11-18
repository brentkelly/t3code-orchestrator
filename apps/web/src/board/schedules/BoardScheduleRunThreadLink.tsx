/**
 * T3o: a schedule run's thread (T3O-118). A run on the board server opens by its route; one
 * on a worker opens through the board, which proxies the worker and mints this client a
 * session there first, as a card's worker thread does.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { boardToast } from "../boardToast";
import { openWorkerThreadEnvironment } from "../workers/workerThreadEnvironments";

export function BoardScheduleRunThreadLink(props: {
  readonly boardEnvironmentId: EnvironmentId;
  readonly serverEnvironmentId: EnvironmentId;
  /** Where the run thread lives; null or the board server opens it here. */
  readonly ranOn: EnvironmentId | null;
  readonly threadId: ThreadId;
  readonly name: (environmentId: EnvironmentId | null) => string;
  readonly label: string;
  readonly className?: string;
}) {
  const navigate = useNavigate();
  const open = useAtomCommand(openWorkerThreadEnvironment, { reportFailure: false });
  const [opening, setOpening] = useState(false);
  const { ranOn } = props;
  if (ranOn === null || ranOn === props.serverEnvironmentId) {
    return (
      <Link
        className={props.className}
        params={buildThreadRouteParams(scopeThreadRef(props.boardEnvironmentId, props.threadId))}
        to="/$environmentId/$threadId"
      >
        {props.label}
      </Link>
    );
  }
  const workerName = props.name(ranOn);
  const onOpen = () => {
    setOpening(true);
    void open({
      boardEnvironmentId: props.boardEnvironmentId,
      workerId: ranOn,
      label: workerName,
    }).then((result) => {
      setOpening(false);
      if (result._tag === "Success") {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(ranOn, props.threadId)),
        });
        return;
      }
      const error: unknown = squashAtomCommandFailure(result);
      boardToast({
        title: `Couldn't open the run on ${workerName}`,
        description:
          error instanceof Error && error.message.length > 0
            ? error.message
            : `${workerName} couldn't be reached through the board.`,
        tone: "error",
      });
    });
  };
  return (
    <button
      className={`w-fit cursor-pointer text-left ${props.className ?? ""}`}
      disabled={opening}
      onClick={onOpen}
      type="button"
    >
      {props.label} on {workerName}
    </button>
  );
}

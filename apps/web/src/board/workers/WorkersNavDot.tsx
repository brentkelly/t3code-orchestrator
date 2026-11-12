/** T3o: the amber dot on the Workers settings nav item while a worker is offline or needs an update. */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { boardEnvironment } from "../../state/board";
import { useBoardEnvironmentId } from "../useBoardEnvironmentId";
import { workersNeedAttention } from "./workerCopy";

export function SettingsNavAttentionDot(props: { readonly to: string }) {
  const environmentId = useBoardEnvironmentId();
  if (props.to !== "/settings/board/workers" || environmentId === null) return null;
  return <WorkersAttentionDot environmentId={environmentId} />;
}

function WorkersAttentionDot(props: { readonly environmentId: EnvironmentId }) {
  const { workers } = useAtomValue(boardEnvironment.workersAtom(props.environmentId));
  if (!workersNeedAttention(workers)) return null;
  return (
    <span
      aria-label="A worker needs attention"
      role="img"
      className="ms-auto size-1.5 shrink-0 rounded-full bg-warning"
    />
  );
}

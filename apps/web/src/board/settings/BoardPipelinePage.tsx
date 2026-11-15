/** T3o: Settings → Board → Pipeline: the stages every project follows unless it overrides them. */
import { BoardPipelineSection } from "../../components/settings/BoardPipelineSection";
import { useBoardEnvironment } from "../useBoardEnvironmentId";

export function BoardPipelinePage() {
  const resolution = useBoardEnvironment();
  // Without a reachable board server there is no pipeline to read or save.
  return resolution.kind === "ready" ? <BoardPipelineSection /> : null;
}

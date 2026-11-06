/** T3o: Settings → Board → Pipeline (T3O-49): the one global stage list. */
import { BoardPipelineSection } from "../../components/settings/BoardPipelineSection";
import { useBoardEnvironment } from "../useBoardEnvironmentId";

export function BoardPipelineSettingsPage() {
  const resolution = useBoardEnvironment();
  return resolution.kind === "ready" ? <BoardPipelineSection /> : null;
}

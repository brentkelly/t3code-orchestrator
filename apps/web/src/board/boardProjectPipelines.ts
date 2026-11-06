/**
 * T3o per-project pipelines (T3O-43). Implementation lives in client-runtime
 * so web and mobile share one copy.
 */
export {
  boardCardPipelineStages,
  boardCardStageGoneNotes,
  boardPipelineColumns,
  boardPipelinesGrid,
  type BoardPipelineCell,
  type BoardPipelineColumn,
  type BoardPipelineColumnKind,
  type BoardPipelineProject,
  type BoardPipelinesGrid,
} from "@t3tools/client-runtime/board";

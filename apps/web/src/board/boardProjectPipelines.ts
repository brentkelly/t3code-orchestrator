/**
 * T3o per-project pipelines (T3O-43/49). Implementation lives in client-runtime
 * so web and mobile share one copy.
 */
export {
  boardCardPipelineStages,
  boardCardStageGoneNotes,
  boardCiStepShapeLine,
  boardPipelineColumns,
  type BoardPipelineColumn,
  type BoardPipelineColumnKind,
  type BoardPipelineProject,
  type BoardStageCoverage,
  type BoardStageCoverageEntry,
} from "@t3tools/client-runtime/board";

// T3o (T3O-45): board files share one module graph, and tests reuse fixed command ids, so
// actor stamps from an earlier file must not attribute a later file's events.
import { resetBoardActivityActors } from "../board/activityActors.ts";

resetBoardActivityActors();

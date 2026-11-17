/** T3o: a schedule's Last result colours (T3O-117). Never green: a finished
    turn can't be told apart as a success. */
import type { BoardScheduleResultTone } from "../settings/boardProjectSettings.logic";

export const BOARD_SCHEDULE_RESULT_DOT: Readonly<Record<BoardScheduleResultTone, string>> = {
  running: "bg-info-foreground",
  attention: "bg-attention-foreground",
  warning: "bg-warning-foreground",
  neutral: "bg-muted-foreground",
  muted: "border border-muted-foreground bg-transparent",
};

export const BOARD_SCHEDULE_RESULT_TEXT: Readonly<Record<BoardScheduleResultTone, string>> = {
  running: "text-info-foreground",
  attention: "text-attention-foreground",
  warning: "text-warning-foreground",
  neutral: "text-foreground",
  muted: "text-muted-foreground",
};

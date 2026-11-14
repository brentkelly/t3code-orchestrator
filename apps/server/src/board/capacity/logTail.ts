// @effect-diagnostics nodeBuiltinImport:off - reads a log file the runner wrote.
import * as NodeFS from "node:fs";

import { BOARD_CAPACITY_LOG_MAX_BYTES } from "@t3tools/contracts";

/** A log file's last 64 KB, read without loading the rest; null when it can't be read. */
export const readLogTail = (logPath: string): string | null => {
  try {
    const size = NodeFS.statSync(logPath).size;
    const length = Math.min(size, BOARD_CAPACITY_LOG_MAX_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = NodeFS.openSync(logPath, "r");
    try {
      NodeFS.readSync(fd, buffer, 0, length, size - length);
    } finally {
      NodeFS.closeSync(fd);
    }
    return buffer.toString("utf8");
  } catch {
    return null;
  }
};

/**
 * T3o: one project's config for its settings page (T3O-49) — the shell delta
 * the board already holds, plus the full delta (prompts, step bodies,
 * "last changed by") fetched whenever the shell's version moves.
 */
import {
  EMPTY_BOARD_PROJECT_STAGE_CONFIG,
  boardProjectStageConfigShell,
  type BoardProjectStageConfig,
  type BoardProjectStageConfigShell,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";

const EMPTY_SHELL = boardProjectStageConfigShell(EMPTY_BOARD_PROJECT_STAGE_CONFIG);

export interface BoardProjectConfigState {
  readonly shell: BoardProjectStageConfigShell;
  /** Null until the full delta for the shell's version has loaded. */
  readonly full: BoardProjectStageConfig | null;
}

export function useBoardProjectConfig(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): BoardProjectConfigState {
  const configs = useAtomValue(boardEnvironment.projectStageConfigsAtom(environmentId));
  const shell = configs[projectId] ?? EMPTY_SHELL;
  const getConfig = useAtomCommand(boardEnvironment.getProjectConfig, { reportFailure: false });
  const [full, setFull] = useState<BoardProjectStageConfig | null>(null);
  const version = shell.version;
  useEffect(() => {
    let cancelled = false;
    void getConfig({ environmentId, input: { projectId } }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setFull(result.value.config);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, projectId, version]);
  return { shell, full: full !== null && full.version === version ? full : null };
}

/**
 * T3o (T3O-58): Settings → Source Control's Project tokens. Read-only: for each project, which
 * gitenv line (folder, repo, owner) or ambient source its GitHub token comes from, and whether
 * GitHub accepts it, so a dead token shows here before a merge fails. Checked on open and on
 * refresh only. Edit the gitenv file to change a token; see docs/t3o/gitenv.md.
 */
import type {
  BoardProjectTokenSource,
  BoardProjectTokenStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { boardEnvironment } from "../../state/board";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";

const SOURCE_LABELS: Record<BoardProjectTokenSource, string> = {
  folder: "gitenv folder line",
  repo: "gitenv repo line",
  owner: "gitenv owner line",
  settings: "Settings token",
  app: "GitHub app sign-in",
  env: "GH_TOKEN / GITHUB_TOKEN",
  gh: "gh auth token",
  none: "No token",
};

function sourceText(row: BoardProjectTokenStatus): string {
  const label = SOURCE_LABELS[row.source];
  return row.entryKey === null ? label : `${label} ${row.entryKey}`;
}

function CheckText({ row }: { readonly row: BoardProjectTokenStatus }) {
  switch (row.check.status) {
    case "ok":
      return <span>Accepted as {row.check.login}</span>;
    case "rejected":
      return (
        <span className="text-attention-foreground">
          {row.entryKey === null
            ? "Rejected by GitHub"
            : `Rejected by GitHub: edit ${row.entryKey} in gitenv`}
        </span>
      );
    case "error":
      return <span>{row.check.message}</span>;
    case "no-remote":
      return <span>No GitHub origin</span>;
  }
}

interface TokensState {
  readonly rows: ReadonlyArray<BoardProjectTokenStatus> | null;
  readonly failure: string | null;
  readonly pending: boolean;
}

const INITIAL_STATE: TokensState = { rows: null, failure: null, pending: true };

function settled(
  previous: TokensState,
  result: { readonly _tag: string; readonly value?: ReadonlyArray<BoardProjectTokenStatus> },
): TokensState {
  return result._tag === "Success" && result.value !== undefined
    ? { rows: result.value, failure: null, pending: false }
    : { ...previous, failure: "Could not check project tokens.", pending: false };
}

export function T3oProjectTokensSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const read = useAtomCommand(boardEnvironment.projectTokenStatus, { reportFailure: false });
  const [state, setState] = useState<TokensState>(INITIAL_STATE);
  const { rows, failure, pending } = state;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- each check is a GitHub call on the server; run when the section opens, and on refresh.
  useEffect(() => {
    let current = true;
    void read({ environmentId, input: {} }).then((result) => {
      if (current) setState((previous) => settled(previous, result));
    });
    return () => {
      current = false;
    };
  }, [environmentId, read]);

  const checkAgain = () => {
    setState((previous) => ({ ...previous, pending: true }));
    void read({ environmentId, input: {} }).then((result) =>
      setState((previous) => settled(previous, result)),
    );
  };

  const refresh = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={checkAgain}
            disabled={pending}
            aria-label="Check project tokens again"
          >
            <RefreshIcon refreshing={pending} />
          </Button>
        }
      />
      <TooltipPopup side="top">Ask GitHub again</TooltipPopup>
    </Tooltip>
  );

  return (
    <SettingsSection title="Project tokens" headerAction={refresh}>
      {failure !== null && rows === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{failure}</p>
      ) : rows === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Checking…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">No projects.</p>
      ) : (
        rows.map((row) => (
          <div key={row.projectId} className="px-3 py-2.5 sm:px-4">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="truncate text-sm font-medium text-foreground">{row.title}</span>
              {row.repo === null ? null : (
                <code className="text-xs text-muted-foreground">{row.repo}</code>
              )}
            </div>
            <p className="flex min-w-0 flex-wrap gap-x-1 text-xs leading-normal text-muted-foreground/80">
              <span>{sourceText(row)} ·</span>
              <CheckText row={row} />
            </p>
          </div>
        ))
      )}
    </SettingsSection>
  );
}

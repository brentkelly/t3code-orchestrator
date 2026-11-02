/**
 * T3o: board card threads leave the sidebar's Settled shelf by default (T3O-78).
 *
 * Settled is where one-off threads are found again, and card threads swamp it; a historic card
 * thread is reached through its card. Active, Working, Pinned and Snoozed are unchanged, so a
 * running card thread still shows. The 25 newest settled threads ride the shell and are matched
 * against the board's thread links here; older pages and counts are filtered by the server.
 */
import { useAtomValue } from "@effect/atom-react";
import { boardCardThreadMatcher } from "@t3tools/client-runtime/state/shell";
import type { OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { BoardShellSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { environmentBoard } from "../state/board";
import type { CardThreadMatch } from "./sidebarCardThreadFilter";
import { useBoardEnvironmentId } from "./useBoardEnvironmentId";

const HIDE_CARD_THREADS_KEY = "t3o:sidebar:hide-card-threads";

/** Whether this device hides card threads from Settled. On until the user turns it off. */
function useHideCardThreads() {
  return useLocalStorage(HIDE_CARD_THREADS_KEY, true, Schema.Boolean);
}

const NO_BOARD = Atom.make<BoardShellSnapshot | null>(null).pipe(
  Atom.withLabel("t3o:sidebar:no-board"),
);
const NO_CARD_THREADS = () => false;

/** The Settled filter for the sidebar: the saved setting and which threads are card threads. */
export function useSettledCardThreadFilter() {
  const [hide, setHide] = useHideCardThreads();
  const boardEnvironmentId = useBoardEnvironmentId();
  const board = useAtomValue(
    boardEnvironmentId === null ? NO_BOARD : environmentBoard.snapshotValueAtom(boardEnvironmentId),
  );
  const cardThreads = board?.cardThreads;
  const isCardThread = useMemo<CardThreadMatch>(
    () =>
      boardEnvironmentId === null || cardThreads === undefined || cardThreads.length === 0
        ? NO_CARD_THREADS
        : boardCardThreadMatcher(boardEnvironmentId, cardThreads),
    [boardEnvironmentId, cardThreads],
  );
  return {
    hide,
    setHide,
    isCardThread,
    hasCardThreads: (cardThreads?.length ?? 0) > 0,
    /** The scopes the older-settled shelf reads, filtered on the server when hiding. */
    scopes: (scopes: ReadonlyArray<OlderSettledScope>): ReadonlyArray<OlderSettledScope> =>
      hide ? scopes.map((scope) => ({ ...scope, excludeBoardCardThreads: true })) : scopes,
  };
}

/** The filter menu's switch, below the project list. */
export function SidebarCardThreadsSwitch() {
  const [hide, setHide] = useHideCardThreads();
  return (
    <label className="flex cursor-pointer items-center gap-2.5 border-t px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">Hide card threads</span>
        <span className="text-xs text-muted-foreground">Open them from the card instead</span>
      </span>
      <Switch size="sm" checked={hide} onCheckedChange={(checked) => setHide(checked)} />
    </label>
  );
}

/** Under the Settled header: what the filter hides, and the way to flip it. */
export function SidebarCardThreadsNotice(props: {
  readonly hide: boolean;
  readonly hiddenCount: number;
  readonly hasCardThreads: boolean;
  readonly onToggle: () => void;
}) {
  if (props.hide ? props.hiddenCount === 0 : !props.hasCardThreads) return null;
  return (
    <li className="flex list-none items-center gap-1 px-2.5 py-1 text-xs text-sidebar-muted-foreground">
      <span className="min-w-0 truncate">
        {props.hide
          ? `${props.hiddenCount.toLocaleString()} card ${props.hiddenCount === 1 ? "thread" : "threads"} hidden`
          : "Including card threads"}
      </span>
      <span aria-hidden>·</span>
      <Button variant="link" size="micro" onClick={props.onToggle}>
        {props.hide ? "Show" : "Hide"}
      </Button>
    </li>
  );
}

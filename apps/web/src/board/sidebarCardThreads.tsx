/**
 * T3o: board card threads leave the sidebar's Settled shelf by default (T3O-78).
 *
 * Settled is where one-off threads are found again, and card threads swamp it; a historic card
 * thread is reached through its card. Active, Working, Pinned and Snoozed are unchanged, so a
 * running card thread still shows. Each environment's server names its card threads: it filters older pages
 * and counts itself, and lists the card threads its shell carries so they are matched here.
 */
import { useAtomValue } from "@effect/atom-react";
import type { OlderSettled, OlderSettledScope } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import {
  getLocalStorageItem,
  setLocalStorageItem,
  useLocalStorage,
} from "../hooks/useLocalStorage";
import { olderSettledThreads } from "../state/threads";
import { cardThreadMatcher, rememberCardThreadIds } from "./sidebarCardThreadFilter";

const HIDE_CARD_THREADS_KEY = "t3o:sidebar:hide-card-threads";

/** Whether this device hides card threads from Settled. On until the user turns it off. */
function useHideCardThreads() {
  return useLocalStorage(HIDE_CARD_THREADS_KEY, true, Schema.Boolean);
}

const CARD_THREAD_IDS_KEY = "t3o:sidebar:card-thread-ids:";
const CardThreadIds = Schema.Array(Schema.String);

// Storage failures (quota, private mode) only cost the remembered ids, never the sidebar.
const withCardThreadIds = rememberCardThreadIds({
  load: (environmentId) => {
    try {
      return getLocalStorageItem(CARD_THREAD_IDS_KEY + environmentId, CardThreadIds);
    } catch {
      return null;
    }
  },
  save: (environmentId, ids) => {
    try {
      setLocalStorageItem(CARD_THREAD_IDS_KEY + environmentId, ids, CardThreadIds);
    } catch {
      // Kept in memory for this session regardless.
    }
  },
});

/** Each environment's filtered cut, counts and card threads; the same map while none changed. */
const cardThreadReadsAtom = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
  let previousReads: ReadonlyMap<EnvironmentId, OlderSettled | null> = new Map();
  let previous: ReadonlyMap<EnvironmentId, OlderSettled | null> = new Map();
  return Atom.make((get) => {
    const reads = new Map(
      environmentIds.map((id) => [id, get(olderSettledThreads.olderSettledAtom(id, true))]),
    );
    const same =
      reads.size === previousReads.size &&
      [...reads].every(([id, older]) => previousReads.has(id) && previousReads.get(id) === older);
    if (!same) {
      previousReads = reads;
      previous = new Map([...reads].map(([id, older]) => [id, withCardThreadIds(id, older)]));
    }
    return previous;
  }).pipe(Atom.withLabel(`t3o:sidebar:card-threads:${key}`));
});

/** The Settled filter for the sidebar: the saved setting and which threads are card threads. */
export function useSettledCardThreadFilter(environmentIds: ReadonlyArray<EnvironmentId>) {
  const [hide, setHide] = useHideCardThreads();
  const reads = useAtomValue(cardThreadReadsAtom(JSON.stringify([...environmentIds].sort())));
  const olderSettled = useMemo(
    () => (environmentId: EnvironmentId) => reads.get(environmentId) ?? null,
    [reads],
  );
  const isCardThread = useMemo(() => cardThreadMatcher(olderSettled), [olderSettled]);
  return {
    hide,
    setHide,
    isCardThread,
    olderSettled,
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

/** Under the Settled header: the card threads in scope, and the way to show or hide them. */
export function SidebarCardThreadsNotice(props: {
  readonly hide: boolean;
  readonly cardThreadCount: number;
  readonly onToggle: () => void;
}) {
  if (props.cardThreadCount === 0) return null;
  const threads = `${props.cardThreadCount.toLocaleString()} card ${props.cardThreadCount === 1 ? "thread" : "threads"}`;
  return (
    <li className="flex list-none items-center gap-1 px-2.5 py-1 text-xs text-sidebar-muted-foreground">
      <span className="min-w-0 truncate">
        {props.hide ? `${threads} hidden` : `Including ${threads}`}
      </span>
      <span aria-hidden>·</span>
      <Button variant="link" size="micro" onClick={props.onToggle}>
        {props.hide ? "Show" : "Hide"}
      </Button>
    </li>
  );
}

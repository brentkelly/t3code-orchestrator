import { useEffect } from "react";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import type { TabCreatingCard } from "./tabIdentity.logic";

export const tabCreatingCardAtom = Atom.make<TabCreatingCard | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("t3o-tab-identity-creating-card"),
);

/** Lends the tab title and favicon to an open New card dialog; null releases them. */
export function useTabCreatingCard(creating: TabCreatingCard | null): void {
  const environmentId = creating?.environmentId ?? null;
  const projectId = creating?.projectId ?? null;
  const title = creating?.title ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the open dialog to the tab identity, which lives outside React
  useEffect(() => {
    if (environmentId === null || title === null) return;
    appAtomRegistry.set(tabCreatingCardAtom, { environmentId, projectId, title });
    return () => appAtomRegistry.set(tabCreatingCardAtom, null);
  }, [environmentId, projectId, title]);
}

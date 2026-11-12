/**
 * Keeps the tab title and favicon on what is open: the card or thread, its project's board
 * colour, and the server the tab is connected to. Runs for the life of the page.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  type BoardShellSnapshot,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";
import { isElectron } from "../../env";
import { getClientSettings, subscribeClientSettings } from "../../hooks/useSettings";
import type { AppRouter } from "../../router";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { resolveSidebarThreadStatus } from "../../components/Sidebar.logic";
import { boardEnvironment, environmentBoard } from "../../state/board";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentProjects } from "../../state/projects";
import { primaryServerConfigAtom, serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells } from "../../state/threads";
import { resolveBoardEnvironment, type BoardEnvironmentCandidate } from "../useBoardEnvironmentId";
import { tabCreatingCardAtom } from "./creatingCard";
import {
  buildCardIndex,
  resolveIdentity,
  routeKey,
  sameRouteKey,
  shouldHold,
  tabFallbackName,
  tabIconKey,
  type TabBoardEnvironment,
  type TabCardIndex,
  type TabIcon,
  type TabIdentity,
  type TabRouteKey,
} from "./tabIdentity.logic";
import {
  resolveCardTabStatus,
  sameCardTabStatus,
  threadTabStatus,
  type CardTabStatus,
} from "./tabStatus.logic";

const NO_CARD_STATUS: CardTabStatus = { status: null, settleAt: null };

function draftProject(draftId: string) {
  const session = useComposerDraftStore.getState().getDraftSession(draftId as DraftId);
  return session === null
    ? null
    : { environmentId: session.environmentId, projectId: session.projectId };
}

function currentRouteKey(router: AppRouter): TabRouteKey {
  return routeKey(router.state.matches, draftProject);
}

export function startTabIdentity(router: AppRouter): void {
  // Electron pins the window title and has no favicon, so skip the board subscription there.
  if (isElectron) {
    appAtomRegistry.subscribe(
      primaryServerConfigAtom,
      (config) => {
        document.title = tabFallbackName(config?.environment.serverVersion ?? null);
      },
      { immediate: true },
    );
    return;
  }
  const locationKeyAtom = Atom.make<TabRouteKey>(currentRouteKey(router)).pipe(
    Atom.keepAlive,
    Atom.withLabel("t3o-tab-identity-location"),
  );
  const nominatedBoardEnvAtom = Atom.make<EnvironmentId | null>(
    getClientSettings().boardEnvironmentId,
  ).pipe(Atom.keepAlive, Atom.withLabel("t3o-tab-identity-nominated-board"));

  const syncLocation = () => {
    const next = currentRouteKey(router);
    if (!sameRouteKey(next, appAtomRegistry.get(locationKeyAtom))) {
      appAtomRegistry.set(locationKeyAtom, next);
    }
  };
  router.subscribe("onResolved", syncLocation);
  // The composer's picker can move an open draft to another project without changing the URL.
  useComposerDraftStore.subscribe(() => {
    if (appAtomRegistry.get(locationKeyAtom).kind === "draft") syncLocation();
  });
  subscribeClientSettings(() => {
    appAtomRegistry.set(nominatedBoardEnvAtom, getClientSettings().boardEnvironmentId);
  });

  // Mapped exactly as `useBoardEnvironment` maps them, so the tab and the board agree.
  const boardEnvAtom = Atom.make((get): TabBoardEnvironment => {
    const candidates = new Map<EnvironmentId, BoardEnvironmentCandidate>();
    for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
      candidates.set(environmentId, {
        label: presentation.entry.target.label,
        enabled: presentation.entry.enabled,
        phase: presentation.connection.phase,
      });
    }
    const resolution = resolveBoardEnvironment({
      nominated: get(nominatedBoardEnvAtom),
      primary: get(primaryEnvironmentIdAtom),
      candidates,
    });
    return resolution.kind === "ready"
      ? { kind: "ready", environmentId: resolution.environmentId }
      : { kind: resolution.kind };
  }).pipe(Atom.withLabel("t3o-tab-identity-board-environment"));

  // Rebuilt only when the cards or their thread links change, not on every board delta.
  let indexedCards: BoardShellSnapshot["cards"] | null = null;
  let indexedThreads: BoardShellSnapshot["cardThreads"] | null = null;
  let indexedEnvironment: EnvironmentId | null = null;
  let index: TabCardIndex | null = null;
  const cardIndexAtom = Atom.make((get): TabCardIndex | null => {
    const boardEnv = get(boardEnvAtom);
    if (boardEnv.kind !== "ready") return null;
    const snapshot = get(environmentBoard.snapshotValueAtom(boardEnv.environmentId));
    if (snapshot === null) return null;
    if (
      index === null ||
      indexedCards !== snapshot.cards ||
      indexedThreads !== snapshot.cardThreads ||
      indexedEnvironment !== boardEnv.environmentId
    ) {
      indexedCards = snapshot.cards;
      indexedThreads = snapshot.cardThreads;
      indexedEnvironment = boardEnv.environmentId;
      index = buildCardIndex(boardEnv.environmentId, snapshot);
    }
    return index;
  }).pipe(Atom.withLabel("t3o-tab-identity-card-index"));

  // Bumped when a settle grace on the shown card ends, so its status can change without a push.
  const settleTickAtom = Atom.make(0).pipe(
    Atom.keepAlive,
    Atom.withLabel("t3o-tab-identity-settle-tick"),
  );

  // Reads the shell, which changes on every streaming tick; equality keeps an unchanged status
  // from recomputing the identity.
  const cardStatusAtom = Atom.family((cardId: string) =>
    Atom.make((get): CardTabStatus => {
      get(settleTickAtom);
      const boardEnv = get(boardEnvAtom);
      if (boardEnv.kind !== "ready") return NO_CARD_STATUS;
      const environmentId = boardEnv.environmentId;
      const board = get(boardEnvironment.boardAtom(environmentId));
      if (board === null) return NO_CARD_STATUS;
      const shell = get(environmentShell.stateValueAtom(environmentId));
      const threads = Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : [];
      return resolveCardTabStatus({
        cardId,
        cards: board.cards,
        threadOf: (threadId) => threads.find((thread) => thread.id === threadId),
        stageList: get(boardEnvironment.stageListAtom(environmentId)),
        projectStageConfigs: get(boardEnvironment.projectStageConfigsAtom(environmentId)),
        serverSettings: get(serverEnvironment.settingsValueAtom(environmentId)),
        workers: get(boardEnvironment.workersAtom(environmentId)),
        now: Date.now(),
      });
    }).pipe(Atom.withEquality(sameCardTabStatus), Atom.withLabel("t3o-tab-identity-card-status")),
  );

  const identityAtom = Atom.make((get) => {
    const settle: { at: number | null } = { at: null };
    const key = get(locationKeyAtom);
    const config = get(primaryServerConfigAtom);
    const boardEnv = get(boardEnvAtom);
    const boardServerSettings =
      boardEnv.kind === "ready"
        ? get(serverEnvironment.settingsValueAtom(boardEnv.environmentId))
        : null;
    const identity = resolveIdentity(key, {
      environmentLabel: config?.environment.label ?? null,
      fallbackName: tabFallbackName(config?.environment.serverVersion ?? null),
      boardEnvironment: boardEnv,
      cardIndex: get(cardIndexAtom),
      boardSettings: (boardServerSettings ?? DEFAULT_SERVER_SETTINGS).board,
      thread: (environmentId, threadId) =>
        get(environmentThreadShells.quietThreadShellAtom(scopeThreadRef(environmentId, threadId))),
      project: (environmentId, projectId) =>
        get(environmentProjects.projectAtom({ environmentId, projectId })),
      creating: get(tabCreatingCardAtom),
      cardStatus: (cardId) => {
        const resolved = get(cardStatusAtom(cardId));
        settle.at = resolved.settleAt;
        return resolved.status;
      },
      threadStatus: (environmentId, threadId) => {
        const thread = get(
          environmentThreadShells.quietThreadShellAtom(scopeThreadRef(environmentId, threadId)),
        );
        return thread === null ? null : threadTabStatus(resolveSidebarThreadStatus(thread));
      },
    });
    return { key, identity, settleAt: settle.at };
  }).pipe(Atom.withLabel("t3o-tab-identity"));

  const favicon = startFavicon();
  let lastApplied: { key: TabRouteKey; pending: boolean } | null = null;
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  const apply = ({
    key,
    identity,
    settleAt,
  }: {
    key: TabRouteKey;
    identity: TabIdentity | null;
    settleAt: number | null;
  }) => {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    if (settleAt !== null) {
      // `+ 1` so the timer cannot land a millisecond short of the deadline.
      settleTimer = setTimeout(
        () => appAtomRegistry.update(settleTickAtom, (tick) => tick + 1),
        Math.max(0, settleAt - Date.now()) + 1,
      );
    }
    if (identity === null || shouldHold(identity, key, lastApplied)) return;
    lastApplied = { key, pending: identity.pending };
    if (document.title !== identity.title) document.title = identity.title;
    favicon?.set(identity.icon);
  };
  appAtomRegistry.subscribe(identityAtom, apply, { immediate: true });
}

/**
 * Owns the page's original `<link rel="icon">` and only ever changes its href. The unread badge
 * detaches and re-attaches that same element, so the badge wins while unread and the identity
 * icon is back once it clears.
 */
function startFavicon(): { set: (icon: TabIcon) => void } | null {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link === null) return null;
  const defaultHref = link.getAttribute("href") ?? "/favicon.ico";
  link.removeAttribute("sizes");
  let renderer: typeof import("./faviconTile") | null = null;
  let wanted: TabIcon = { kind: "default" };
  let appliedKey = "default";
  const paint = () => {
    const key = tabIconKey(wanted);
    if (key === appliedKey) return;
    if (wanted.kind === "default") {
      link.href = defaultHref;
      link.removeAttribute("type");
      appliedKey = key;
      return;
    }
    // The static icon stays until the tile font is ready.
    if (renderer === null) return;
    let url: string | null;
    try {
      url = renderer.renderFaviconTile(wanted);
    } catch {
      // Older engines lack canvas APIs the tile uses (roundRect); keep the current icon.
      return;
    }
    if (url === null) return;
    link.type = "image/png";
    link.href = url;
    appliedKey = key;
  };
  void import("./faviconTile")
    .then(async (module) => {
      await module.loadTileFont();
      renderer = module;
      paint();
    })
    .catch(() => {
      // A failed chunk or font load leaves the static icon in place.
    });
  return {
    set: (icon) => {
      wanted = icon;
      paint();
    },
  };
}

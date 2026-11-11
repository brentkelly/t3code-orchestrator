/**
 * What a browser tab says about itself: a title naming what is open and which server, and a
 * favicon tile in the project's board colour carrying the card ID. Pure, so the route and
 * state rules are tested without a router, a registry or a canvas.
 */
import {
  assignBoardKeyPrefix,
  type BoardSettings,
  type EnvironmentId,
  type ProjectIconOverride,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../../branding";
import { resolveServerBackedAppDisplayName } from "../../branding.logic";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { boardLabelForeground } from "../labelColour";
import { projectAccent, projectIconColorOf } from "../projectAccent";

const TITLE_MAX = 60;

export type BoardScopeKey =
  | { readonly kind: "board"; readonly projectId: ProjectId | null }
  | { readonly kind: "subBoard"; readonly parentCardId: string };

/** The location, reduced to what the identity depends on. */
export type TabRouteKey =
  | { readonly kind: "card"; readonly cardId: string; readonly scope: BoardScopeKey }
  | { readonly kind: "thread"; readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
  | {
      readonly kind: "draft";
      readonly draftId: string;
      /** The draft's project, resolved from the draft store when the route resolves. */
      readonly project: {
        readonly environmentId: EnvironmentId;
        readonly projectId: ProjectId;
      } | null;
    }
  | BoardScopeKey
  | { readonly kind: "guest" }
  | { readonly kind: "other" };

export interface TabRouteMatch {
  readonly routeId: string;
  readonly params: Readonly<Record<string, string | undefined>>;
  readonly search: unknown;
}

function searchString(search: unknown, key: string): string | null {
  if (typeof search !== "object" || search === null) return null;
  const value = (search as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Stage 1: the router's matches as a small comparable key. */
export function routeKey(
  matches: ReadonlyArray<TabRouteMatch>,
  draftProject: (
    draftId: string,
  ) => { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null,
): TabRouteKey {
  for (const match of matches) {
    switch (match.routeId) {
      case "/guest":
        return { kind: "guest" };
      case "/board":
      case "/list": {
        const projectId = searchString(match.search, "project") as ProjectId | null;
        const scope: BoardScopeKey = { kind: "board", projectId };
        const cardId = searchString(match.search, "card");
        return cardId === null ? scope : { kind: "card", cardId, scope };
      }
      case "/board_/$parentCardId": {
        const scope: BoardScopeKey = {
          kind: "subBoard",
          parentCardId: match.params.parentCardId ?? "",
        };
        const cardId = searchString(match.search, "card");
        return cardId === null ? scope : { kind: "card", cardId, scope };
      }
      case "/_chat/$environmentId/$threadId":
      case "/_chat/draft/$draftId": {
        const target = resolveThreadRouteTarget(match.params);
        if (target?.kind === "server") {
          return {
            kind: "thread",
            environmentId: target.threadRef.environmentId,
            threadId: target.threadRef.threadId,
          };
        }
        if (target?.kind === "draft") {
          return { kind: "draft", draftId: target.draftId, project: draftProject(target.draftId) };
        }
        break;
      }
    }
  }
  return { kind: "other" };
}

export function sameRouteKey(a: TabRouteKey | null, b: TabRouteKey | null): boolean {
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

export interface TabCard {
  readonly cardId: string;
  readonly key: string;
  readonly title: string;
  readonly projectId: ProjectId;
}

export interface TabProject {
  readonly title: string;
  readonly projectIcon?: ProjectIconOverride | null | undefined;
}

export interface TabThread {
  readonly title: string;
  readonly projectId: ProjectId;
}

/** Cards by id, and card ids by `(environment the thread lives on, thread)`. */
export interface TabCardIndex {
  readonly cards: ReadonlyMap<string, TabCard>;
  readonly cardIdByThread: ReadonlyMap<string, string>;
}

function cardThreadKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return `${environmentId}\u0000${threadId}`;
}

export function buildCardIndex(
  boardEnvironmentId: EnvironmentId,
  snapshot: {
    readonly cards: ReadonlyArray<{
      readonly cardId: string;
      readonly key: string;
      readonly title: string;
      readonly projectId: ProjectId;
    }>;
    readonly cardThreads: ReadonlyArray<{
      readonly cardId: string;
      readonly threadId: ThreadId;
      readonly workerId?: EnvironmentId;
    }>;
  },
): TabCardIndex {
  const cards = new Map<string, TabCard>();
  for (const card of snapshot.cards) {
    cards.set(card.cardId, {
      cardId: card.cardId,
      key: card.key,
      title: card.title,
      projectId: card.projectId,
    });
  }
  const cardIdByThread = new Map<string, string>();
  for (const link of snapshot.cardThreads) {
    cardIdByThread.set(
      cardThreadKey(link.workerId ?? boardEnvironmentId, link.threadId),
      link.cardId,
    );
  }
  return { cards, cardIdByThread };
}

export type TabBoardEnvironment =
  | { readonly kind: "ready"; readonly environmentId: EnvironmentId }
  | { readonly kind: "unavailable" }
  | { readonly kind: "none" };

export interface TabIdentityInputs {
  /** The tab's primary server label; null before its config arrives. */
  readonly environmentLabel: string | null;
  /** The app display name as the title has always shown it (stage label included). */
  readonly fallbackName: string;
  readonly boardEnvironment: TabBoardEnvironment;
  /** Null until the board environment's first snapshot arrives. */
  readonly cardIndex: TabCardIndex | null;
  readonly boardSettings: BoardSettings;
  readonly thread: (environmentId: EnvironmentId, threadId: ThreadId) => TabThread | null;
  readonly project: (environmentId: EnvironmentId, projectId: ProjectId) => TabProject | null;
}

export type TabIcon =
  | { readonly kind: "default" }
  | {
      readonly kind: "tile";
      readonly prefix: string;
      readonly number: string | null;
      readonly fill: string;
      readonly foreground: string;
    };

export interface TabIdentity {
  readonly title: string;
  readonly icon: TabIcon;
  /** The board snapshot this identity needs has not arrived yet. */
  readonly pending: boolean;
}

function trimTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > TITLE_MAX ? `${trimmed.slice(0, TITLE_MAX - 1).trimEnd()}…` : trimmed;
}

function splitCardKey(key: string): { readonly prefix: string; readonly number: string | null } {
  const dash = key.lastIndexOf("-");
  if (dash <= 0 || dash === key.length - 1) return { prefix: key, number: null };
  return { prefix: key.slice(0, dash), number: key.slice(dash + 1) };
}

function tile(
  prefix: string,
  number: string | null,
  projectId: ProjectId,
  project: TabProject | null,
): TabIcon {
  const fill = projectAccent(projectId, projectIconColorOf(project)).mutedHex;
  return { kind: "tile", prefix, number, fill, foreground: boardLabelForeground(fill) };
}

function cardTile(card: TabCard, inputs: TabIdentityInputs, boardEnv: EnvironmentId): TabIcon {
  const { prefix, number } = splitCardKey(card.key);
  return tile(prefix, number, card.projectId, inputs.project(boardEnv, card.projectId));
}

function projectTile(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  inputs: TabIdentityInputs,
): TabIcon {
  const project = inputs.project(environmentId, projectId);
  if (project === null) return { kind: "default" };
  const { prefix } = assignBoardKeyPrefix({
    board: inputs.boardSettings,
    projectId,
    projectTitle: project.title,
  });
  return tile(prefix, null, projectId, project);
}

function withEnvironment(title: string, inputs: TabIdentityInputs): string {
  return inputs.environmentLabel === null ? title : `${title} · ${inputs.environmentLabel}`;
}

/**
 * Stage 2: the identity for a route key. Null means leave the tab alone (the guest page owns
 * its own title).
 */
export function resolveIdentity(key: TabRouteKey, inputs: TabIdentityInputs): TabIdentity | null {
  const boardEnv =
    inputs.boardEnvironment.kind === "ready" ? inputs.boardEnvironment.environmentId : null;
  const index = boardEnv === null ? null : inputs.cardIndex;
  const pending = boardEnv !== null && inputs.cardIndex === null;
  const make = (title: string, icon: TabIcon, needsBoard: boolean): TabIdentity => ({
    title: withEnvironment(title, inputs),
    icon,
    pending: needsBoard && pending,
  });

  const scopeIdentity = (scope: BoardScopeKey): TabIdentity => {
    if (scope.kind === "board") {
      const icon =
        scope.projectId === null || boardEnv === null
          ? ({ kind: "default" } as const)
          : projectTile(boardEnv, scope.projectId, inputs);
      return make("Board", icon, false);
    }
    const parent = index?.cards.get(scope.parentCardId) ?? null;
    if (parent === null || boardEnv === null) return make("Board", { kind: "default" }, true);
    const { prefix } = splitCardKey(parent.key);
    return make(
      `${trimTitle(parent.title)} · ${parent.key} board`,
      tile(prefix, null, parent.projectId, inputs.project(boardEnv, parent.projectId)),
      true,
    );
  };

  switch (key.kind) {
    case "guest":
      return null;
    case "other":
      return make(inputs.fallbackName, { kind: "default" }, false);
    case "board":
    case "subBoard":
      return scopeIdentity(key);
    case "card": {
      const card = index?.cards.get(key.cardId) ?? null;
      if (card === null || boardEnv === null) {
        const scoped = scopeIdentity(key.scope);
        return { ...scoped, pending };
      }
      return make(`${trimTitle(card.title)} · ${card.key}`, cardTile(card, inputs, boardEnv), true);
    }
    case "thread": {
      const thread = inputs.thread(key.environmentId, key.threadId);
      const cardId = index?.cardIdByThread.get(cardThreadKey(key.environmentId, key.threadId));
      const card = cardId === undefined ? null : (index?.cards.get(cardId) ?? null);
      const title = thread === null ? inputs.fallbackName : trimTitle(thread.title);
      if (card !== null && boardEnv !== null) {
        return make(`${title} · ${card.key}`, cardTile(card, inputs, boardEnv), true);
      }
      const icon =
        thread === null
          ? ({ kind: "default" } as const)
          : projectTile(key.environmentId, thread.projectId, inputs);
      return make(title, icon, true);
    }
    case "draft": {
      const icon =
        key.project === null
          ? ({ kind: "default" } as const)
          : projectTile(key.project.environmentId, key.project.projectId, inputs);
      return make(inputs.fallbackName, icon, false);
    }
  }
}

/**
 * Whether to hold the tab as it is: only while the route is unchanged, the board snapshot it
 * needs is still loading, and what the tab shows was itself resolved, so a reconnect never
 * flickers the card away but a cold start keeps updating until the snapshot lands.
 */
export function shouldHold(
  identity: TabIdentity,
  key: TabRouteKey,
  lastApplied: { readonly key: TabRouteKey; readonly pending: boolean } | null,
): boolean {
  return (
    identity.pending &&
    lastApplied !== null &&
    !lastApplied.pending &&
    sameRouteKey(key, lastApplied.key)
  );
}

export function tabIconKey(icon: TabIcon): string {
  return icon.kind === "default"
    ? "default"
    : `${icon.prefix}|${icon.number ?? ""}|${icon.fill}|${icon.foreground}`;
}

/** The app name the title has always carried, its stage label following the server version. */
export function tabFallbackName(primaryServerVersion: string | null): string {
  return resolveServerBackedAppDisplayName({
    baseName: APP_BASE_NAME,
    fallbackDisplayName: APP_DISPLAY_NAME,
    fallbackStageLabel: APP_STAGE_LABEL,
    primaryServerVersion,
  });
}

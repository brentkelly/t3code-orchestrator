/**
 * T3o (T3O-62, D19): the client's half of Add worker.
 *
 * The board server cannot mint its own session on a worker: only someone
 * already paired there can. So the client this human is using mints a
 * one-time pairing token on the worker — with ITS session on that
 * environment, cookie, bearer or DPoP — and hands the token to the board
 * server, which spends it for a session of its own. Never the client's own
 * bearer token: revoking this device must not break the board.
 *
 * Lives in client-runtime so a future mobile board reuses it (D17).
 */
import {
  AuthStandardClientScopes,
  type AuthPairingCredentialResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const PAIRING_TOKEN_TIMEOUT_MS = 10_000;

/**
 * Mint a one-time pairing token on `prepared`'s environment, for the board
 * server to spend. Needs `access:write` there. Standard client scopes only:
 * the board never holds more than any paired client would.
 */
export const mintEnvironmentPairingToken = Effect.fn(
  "clientRuntime.state.mintEnvironmentPairingToken",
)(function* (input: {
  readonly prepared: PreparedConnection;
  /** What the worker's Settings → Connections lists the session as. */
  readonly label: string;
}): Effect.fn.Return<
  AuthPairingCredentialResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    group: "auth",
    method: "POST",
    url: (urls) => urls.pairingCredential(),
    timeoutMs: PAIRING_TOKEN_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.pairingCredential({
        headers,
        payload: { label: input.label, scopes: AuthStandardClientScopes },
      }),
  });
});

/** One environment this client is connected to, as Add worker sees it. */
export interface BoardWorkerCandidateInput {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  /** Reached through T3 Connect: the board server can't dial it (yet). */
  readonly relayManaged: boolean;
  /** This client's session there can mint pairing tokens. */
  readonly canMintPairingToken: boolean;
}

/**
 * What Add worker can do with an environment (prototype 1.4):
 *
 * - `pick` — one click; the client mints the token.
 * - `needs-link` — this client can't mint one there (no `access:write`), so a
 *   pairing link from `t3 pair` on that machine is the way in.
 * - `disabled` — not usable from this client at all, and why.
 *
 * The board server itself and existing workers are left out entirely.
 */
export type BoardWorkerCandidate =
  | { readonly kind: "pick" }
  | { readonly kind: "needs-link" }
  | { readonly kind: "disabled"; readonly reason: "offline" | "relay" };

export function boardWorkerCandidate(input: BoardWorkerCandidateInput): BoardWorkerCandidate {
  if (input.relayManaged) return { kind: "disabled", reason: "relay" };
  if (!input.connected) return { kind: "disabled", reason: "offline" };
  return input.canMintPairingToken ? { kind: "pick" } : { kind: "needs-link" };
}

/** The environments Add worker lists: every one this client knows, except the
    board server and the workers it already has. */
export function boardWorkerCandidateIds(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly boardEnvironmentId: EnvironmentId;
  readonly workerIds: ReadonlyArray<string>;
}): ReadonlyArray<EnvironmentId> {
  const excluded = new Set<string>([input.boardEnvironmentId, ...input.workerIds]);
  return input.environmentIds.filter((environmentId) => !excluded.has(environmentId));
}

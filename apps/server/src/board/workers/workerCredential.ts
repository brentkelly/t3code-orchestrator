/**
 * T3o (T3O-62, D19): how the central server gets its own session on a worker.
 *
 * Plain HTTP against the worker's upstream auth endpoints, in the order that
 * keeps a one-time pairing token unspent until it is known to be wanted:
 *
 * 1. `resolveWorkerTarget` — the worker's HTTP origin and the one-time token,
 *    from a minted token plus URL or from a pasted `t3 pair` link;
 * 2. `fetchWorkerDescriptor` — `/.well-known/t3/environment`, unauthenticated,
 *    so the caller can refuse the board server itself, a different server, or
 *    an existing worker BEFORE spending the token;
 * 3. `exchangeWorkerCredential` — `/oauth/token`, which spends it for a bearer
 *    session labelled `T3o board (<central name>)`.
 *
 * Every failure is a `BoardWorkerAddError` naming the prototype's error state.
 * Requests go through `HttpClient`; tests point them at a local server.
 */
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  BoardWorkerAddError,
  ExecutionEnvironmentDescriptor,
  type BoardWorkerCredential,
} from "@t3tools/contracts";
import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

/** How long the board server waits on a worker's HTTP endpoint. */
const WORKER_HTTP_TIMEOUT = "10 seconds";

export interface WorkerTarget {
  /** The worker's HTTP origin, no trailing slash. */
  readonly httpBaseUrl: string;
  /** The one-time pairing token. */
  readonly token: string;
}

const invalidCredential = (message?: string) =>
  new BoardWorkerAddError({
    code: "invalid-credential",
    message:
      message ??
      "This link has expired or isn't valid. Pairing links work once and expire after 5 minutes.",
  });

const unreachable = (httpBaseUrl: string) =>
  new BoardWorkerAddError({
    code: "unreachable",
    message: `The board server can't reach ${hostOf(httpBaseUrl)}. Workers must be reachable from the board server, for example over the same network or VPN.`,
  });

function hostOf(httpBaseUrl: string): string {
  try {
    return new URL(httpBaseUrl).host;
  } catch {
    return httpBaseUrl;
  }
}

/** The worker's origin and token, from either credential kind. A pasted link
    carries its own origin; a minted token needs the URL beside it. */
export function resolveWorkerTarget(input: {
  readonly url?: string | undefined;
  readonly credential: BoardWorkerCredential;
}): Effect.Effect<WorkerTarget, BoardWorkerAddError> {
  return Effect.try({
    try: () => {
      const resolved =
        input.credential.kind === "pairing-url"
          ? resolveRemotePairingTarget({ pairingUrl: input.credential.pairingUrl })
          : resolveRemotePairingTarget({
              host: input.url ?? "",
              pairingCode: input.credential.token,
            });
      return {
        httpBaseUrl: resolved.httpBaseUrl.replace(/\/+$/, ""),
        token: resolved.credential,
      };
    },
    catch: () =>
      input.credential.kind === "pairing-url"
        ? invalidCredential(
            "This link isn't a pairing link. It starts with https:// and contains /pair#.",
          )
        : invalidCredential("The worker's address isn't a valid URL."),
  });
}

interface WorkerResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One request to a worker: its status and JSON body (null when it has none).
    Fails only when the worker never answered. */
const requestWorker = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http.execute(request).pipe(Effect.timeout(WORKER_HTTP_TIMEOUT));
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    return { status: response.status, body } satisfies WorkerResponse;
  });

const decodeDescriptor = Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor);

/** The worker's environment descriptor. Unauthenticated; a failure to reach it
    is the board server failing to reach the worker. */
export function fetchWorkerDescriptor(
  httpBaseUrl: string,
): Effect.Effect<ExecutionEnvironmentDescriptor, BoardWorkerAddError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const response = yield* requestWorker(
      HttpClientRequest.get(`${httpBaseUrl}/.well-known/t3/environment`),
    ).pipe(Effect.mapError(() => unreachable(httpBaseUrl)));
    if (response.status !== 200) return yield* unreachable(httpBaseUrl);
    return yield* decodeDescriptor(response.body).pipe(
      Effect.mapError(
        () =>
          new BoardWorkerAddError({
            code: "incompatible",
            message: `${hostOf(httpBaseUrl)} doesn't look like a T3o server.`,
          }),
      ),
    );
  });
}

const AccessTokenResponse = Schema.Struct({ access_token: Schema.String });
const decodeAccessToken = Schema.decodeUnknownEffect(AccessTokenResponse);

/** Spend the one-time token for the board's own bearer session. A refusal is
    an expired, used or wrong token; anything else is the network. */
export function exchangeWorkerCredential(input: {
  readonly target: WorkerTarget;
  /** Shown on the worker under Settings → Sharing & access → Authorized clients. */
  readonly clientLabel: string;
}): Effect.Effect<{ readonly accessToken: string }, BoardWorkerAddError, HttpClient.HttpClient> {
  return Effect.gen(function* () {
    const body = new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: input.target.token,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
      client_label: input.clientLabel,
      client_device_type: "bot",
    });
    const response = yield* requestWorker(
      HttpClientRequest.post(`${input.target.httpBaseUrl}/oauth/token`).pipe(
        HttpClientRequest.setHeader("accept", "application/json"),
        HttpClientRequest.bodyText(body.toString(), "application/x-www-form-urlencoded"),
      ),
    ).pipe(Effect.mapError(() => unreachable(input.target.httpBaseUrl)));
    if (response.status >= 400 && response.status < 500) return yield* invalidCredential();
    if (response.status !== 200) return yield* unreachable(input.target.httpBaseUrl);
    const decoded = yield* decodeAccessToken(response.body).pipe(
      Effect.mapError(() => invalidCredential()),
    );
    return { accessToken: decoded.access_token };
  });
}

const BOARD_SESSION_LABEL_PREFIX = "T3o board (";

/** The label the board's session carries on the worker (D19). */
export function boardSessionLabel(centralLabel: string): string {
  return `${BOARD_SESSION_LABEL_PREFIX}${centralLabel})`;
}

/** Whether a session on this server is one a board was given (D19). */
export function isBoardSessionLabel(label: string): boolean {
  return label.startsWith(BOARD_SESSION_LABEL_PREFIX) && label.endsWith(")");
}

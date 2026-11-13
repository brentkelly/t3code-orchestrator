import { environmentBasePathname } from "@t3tools/shared/remote";

// T3o (T3O-84): a board server proxies a worker's environment at a path prefix on
// its own origin, e.g. `https://board.example/api/t3o/workers/<id>/`. Every URL
// built for an environment goes through here so that prefix survives. A root
// base produces exactly what the upstream builders produced before.

/** The base URL's worker proxy prefix without its trailing slash; `""` for any other base. */
export function environmentBasePath(base: string | URL): string {
  return environmentBasePathname(new URL(base).pathname).replace(/\/+$/, "");
}

/**
 * Joins `path` (absolute, may carry a query or hash) under the base URL's path.
 * The base's own query and hash are dropped.
 */
export function joinEnvironmentPath(base: string | URL, path: string): URL {
  const url = new URL(base);
  const target = new URL(path.startsWith("/") ? path : `/${path}`, "http://path.invalid");
  url.pathname = `${environmentBasePath(url)}${target.pathname}`;
  url.search = target.search;
  url.hash = target.hash;
  return url;
}

/** Identifies an environment address: the origin, plus the base path when there is one. */
export function environmentAddressKey(base: string | URL): string {
  const url = new URL(base);
  return `${url.origin}${environmentBasePath(url)}`;
}

/** Re-applies `raw`'s base path to a URL a root-only normaliser produced from it. Only a
    board worker proxy's prefix is a base path; any other pasted path is the root. */
export function withEnvironmentBasePath(normalized: string, raw: string): string {
  return joinEnvironmentPath(normalized, environmentBasePathname(new URL(raw).pathname)).toString();
}

/**
 * The RPC socket URL: `/ws` under a bare base (root or worker proxy prefix). A
 * base with any other path already names the socket and is used as is.
 */
export function environmentSocketUrl(wsBaseUrl: string): URL {
  const url = new URL(wsBaseUrl);
  if (url.pathname.replace(/\/+$/, "") !== environmentBasePath(url)) return url;
  const socket = joinEnvironmentPath(url, "/ws");
  socket.search = url.search;
  socket.hash = url.hash;
  return socket;
}

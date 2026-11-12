// T3o (T3O-84): a board server proxies a worker's environment at a path prefix on
// its own origin, e.g. `https://board.example/api/t3o/workers/<id>/`. Every URL
// built for an environment goes through here so that prefix survives. A root
// base produces exactly what the upstream builders produced before.

/** The base URL's path without trailing slashes; `""` for a root base. */
export function environmentBasePath(base: string | URL): string {
  return new URL(base).pathname.replace(/\/+$/, "");
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

/** Re-applies `raw`'s base path to a URL a root-only normaliser produced from it. */
export function withEnvironmentBasePath(normalized: string, raw: string): string {
  return joinEnvironmentPath(normalized, `${environmentBasePath(raw)}/`).toString();
}

/**
 * The RPC socket URL: `/ws` under the base path. A base that already names the
 * socket (`…/ws`) is used as is, as configured socket URLs always were.
 */
export function environmentSocketUrl(wsBaseUrl: string): URL {
  const url = new URL(wsBaseUrl);
  if (/\/ws\/?$/.test(url.pathname)) return url;
  const socket = joinEnvironmentPath(url, "/ws");
  socket.search = url.search;
  socket.hash = url.hash;
  return socket;
}

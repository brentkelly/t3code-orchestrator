import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
// T3o: keep a proxied environment's base path (T3O-84).
import { joinEnvironmentPath } from "./environment/basePath.ts";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "Link this environment to T3 Connect for a public URL.",
    };
  }
  // T3o: keep a proxied environment's base path (T3O-84).
  const url = joinEnvironmentPath(httpBaseUrl, endpoint.path);
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? "Only this computer can call this address. Link T3 Connect for a public URL."
      : "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. Link T3 Connect for a public URL.",
  };
}

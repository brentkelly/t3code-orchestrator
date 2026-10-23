/**
 * T3o (T3O-63, prototype 7.2): "Open Settings → Connections" from a card
 * thread on a worker this device isn't connected to arrives with the worker's
 * address, so Add environment opens already filled in.
 */
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

/** `/settings/connections?addHost=<worker url>`. */
export function validateConnectionsSearch(raw: Record<string, unknown>): {
  readonly addHost?: string;
} {
  return typeof raw.addHost === "string" && raw.addHost.trim().length > 0
    ? { addHost: raw.addHost.trim() }
    : {};
}

/** Call `open` with the address a board link asked to add, then drop it from
    the URL, so a reload or Back does not open Add environment again. */
export function useConnectionsAddHostPrefill(open: (host: string) => void): void {
  const search = useSearch({ strict: false }) as { readonly addHost?: string };
  const navigate = useNavigate();
  const host = search.addHost;
  // `open` is a fresh closure on every render; the address is what matters.
  const openFor = useEffectEvent((address: string) => {
    open(address);
    void navigate({ to: "/settings/connections", search: {}, replace: true });
  });
  useEffect(() => {
    if (host !== undefined) openFor(host);
  }, [host]);
}

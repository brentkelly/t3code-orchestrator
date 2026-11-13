export * from "@t3tools/shared/advertisedEndpoint";
// T3o: keep a proxied environment's base path (T3O-84).
import { joinEnvironmentPath } from "./basePath.ts";

export const environmentEndpointUrl = (httpBaseUrl: string, pathname: string): string =>
  // T3o: keep a proxied environment's base path (T3O-84).
  joinEnvironmentPath(httpBaseUrl, pathname).toString();

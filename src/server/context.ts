/**
 * BridgeContext: the shared, long-lived objects one bridge instance owns.
 * Built once per process and shared by every MCP session (stdio or HTTP), so metadata is fetched
 * once and the OAuth token cache is shared.
 */

import type { BridgeConfig } from "./config.js";
import type { AuthProvider } from "../odata/auth.js";
import { BasicAuth, BearerAuth, ClientCredentialsAuth, NoAuth } from "../odata/auth.js";
import { ODataHttpClient } from "../odata/http.js";
import { createMetadataCache } from "../metadata/index.js";
import type { MetadataCache } from "../metadata/cache.js";

export interface BridgeContext {
  config: BridgeConfig;
  auth: AuthProvider;
  http: ODataHttpClient;
  metadata: MetadataCache;
}

export function createAuthProvider(config: BridgeConfig): AuthProvider {
  const a = config.auth;
  switch (a.kind) {
    case "none":
      return new NoAuth();
    case "basic":
      return new BasicAuth(a.username, a.password);
    case "bearer":
      return new BearerAuth(a.token);
    case "oauth2-cc":
      return new ClientCredentialsAuth({
        tokenUrl: a.tokenUrl,
        clientId: a.clientId,
        clientSecret: a.clientSecret,
        ...(a.scope !== undefined ? { scope: a.scope } : {}),
        timeoutMs: config.timeoutMs,
      });
  }
}

export function createBridgeContext(config: BridgeConfig, fetchImpl?: typeof fetch): BridgeContext {
  const auth = createAuthProvider(config);
  const http = new ODataHttpClient({
    baseUrl: config.url,
    auth,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    extraHeaders: config.extraHeaders,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const metadata = createMetadataCache(http, config.metadataTtlMs);
  return { config, auth, http, metadata };
}

/**
 * Auth providers. One method: produce the headers for a request.
 * The HTTP client never sees credentials directly, and nothing here is ever logged.
 */

import { ConfigError, ODataError } from "../util/errors.js";
import { log } from "../util/log.js";

export interface AuthProvider {
  readonly kind: string;
  headers(): Promise<Record<string, string>>;
}

export class NoAuth implements AuthProvider {
  readonly kind = "none";
  async headers(): Promise<Record<string, string>> {
    return {};
  }
}

export class BasicAuth implements AuthProvider {
  readonly kind = "basic";
  private readonly value: string;
  constructor(username: string, password: string) {
    this.value = `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
  }
  async headers(): Promise<Record<string, string>> {
    return { Authorization: this.value };
  }
}

/** Pass a caller-supplied token straight through. */
export class BearerAuth implements AuthProvider {
  readonly kind = "bearer";
  private readonly value: string;
  constructor(token: string) {
    this.value = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  }
  async headers(): Promise<Record<string, string>> {
    return { Authorization: this.value };
  }
}

export interface ClientCredentialsOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Optional scope / audience parameters forwarded to the token endpoint. */
  scope?: string;
  /** Seconds before expiry at which a refresh is triggered. Default 60. */
  refreshLeewaySec?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface TokenState {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
}

/**
 * OAuth2 client-credentials (XSUAA style). Token is cached in memory, refreshed 60s before expiry,
 * and fetched single-flight so N concurrent tool calls cause one token request, not N.
 */
export class ClientCredentialsAuth implements AuthProvider {
  readonly kind = "oauth2-cc";
  private token: TokenState | undefined;
  private inflight: Promise<TokenState> | undefined;
  private readonly leewayMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ClientCredentialsOptions) {
    if (!opts.tokenUrl || !opts.clientId || !opts.clientSecret) {
      throw new ConfigError(
        "oauth2-cc auth requires tokenUrl, clientId and clientSecret",
        "Set CAP_MCP_TOKEN_URL, CAP_MCP_CLIENT_ID and CAP_MCP_CLIENT_SECRET, or the equivalent keys in cap-mcp.config.json",
      );
    }
    this.leewayMs = (opts.refreshLeewaySec ?? 60) * 1000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  async headers(): Promise<Record<string, string>> {
    const t = await this.getToken();
    return { Authorization: `Bearer ${t.accessToken}` };
  }

  private async getToken(): Promise<TokenState> {
    if (this.token && this.token.expiresAt - this.leewayMs > this.now()) return this.token;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<TokenState> {
    const body = new URLSearchParams({ grant_type: "client_credentials" });
    if (this.opts.scope) body.set("scope", this.opts.scope);
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`, "utf8").toString("base64");

    log.debug("fetching oauth2 client-credentials token");
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.tokenUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new ODataError(0, `Token endpoint unreachable: ${(e as Error).message}`, undefined, "Check CAP_MCP_TOKEN_URL and network access to the XSUAA instance");
    }
    if (!res.ok) {
      // Never echo the response body: some IdPs include the client id in error payloads.
      throw new ODataError(res.status, `Token endpoint returned HTTP ${res.status}`, undefined, "Check client id / secret and that the token URL ends with /oauth/token");
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number | string };
    if (!json.access_token) {
      throw new ODataError(res.status, "Token endpoint response had no access_token");
    }
    const expiresIn = Number(json.expires_in ?? 3600);
    this.token = { accessToken: json.access_token, expiresAt: this.now() + expiresIn * 1000 };
    return this.token;
  }
}

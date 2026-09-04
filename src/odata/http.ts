/**
 * Thin OData v4 HTTP client: URL joining, auth headers, timeout, and retry policy.
 *
 * Retry policy (deliberately narrow):
 *   - only GET/HEAD are ever retried
 *   - only on 429, 5xx, network errors and timeouts
 *   - never on any other 4xx, never on a write
 */

import type { AuthProvider } from "./auth.js";
import { NoAuth } from "./auth.js";
import { ODataError } from "../util/errors.js";
import { log, safeUrl } from "../util/log.js";

export interface HttpClientOptions {
  baseUrl: string;
  auth?: AuthProvider;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  /** Maximum retry attempts after the first try. Default 3. */
  maxRetries?: number;
  /** Base backoff in ms; doubles per attempt with jitter. Default 300. */
  backoffMs?: number;
  fetchImpl?: typeof fetch;
  extraHeaders?: Record<string, string>;
  sleep?: (ms: number) => Promise<void>;
}

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" | "HEAD";
  /** Path relative to the service root, e.g. `Books` or `Books(1)/author`. */
  path: string;
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface HttpResponse<T = unknown> {
  status: number;
  data: T;
  headers: Headers;
}

const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);

export class ODataHttpClient {
  readonly baseUrl: string;
  private readonly auth: AuthProvider;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.auth = opts.auth ?? new NoAuth();
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffMs = opts.backoffMs ?? 300;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Raw `$metadata` document as text. */
  async fetchMetadata(): Promise<string> {
    const res = await this.send({ method: "GET", path: "$metadata", headers: { Accept: "application/xml" } }, "text");
    return res.data as string;
  }

  async request<T = unknown>(opts: RequestOptions): Promise<HttpResponse<T>> {
    return (await this.send(opts, "json")) as HttpResponse<T>;
  }

  buildUrl(path: string, query?: Query): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === "") continue;
      parts.push(`${k}=${encodeURIComponent(String(v))}`);
    }
    const p = path.replace(/^\/+/, "");
    return `${this.baseUrl}/${p}${parts.length ? `?${parts.join("&")}` : ""}`;
  }

  private async send(opts: RequestOptions, mode: "json" | "text"): Promise<HttpResponse> {
    const url = this.buildUrl(opts.path, opts.query);
    const retryable = RETRYABLE_METHODS.has(opts.method);
    let attempt = 0;

    for (;;) {
      const headers: Record<string, string> = {
        Accept: mode === "json" ? "application/json" : "application/xml, text/xml",
        "OData-MaxVersion": "4.0",
        "OData-Version": "4.0",
        ...this.extraHeaders,
        ...(await this.auth.headers()),
        ...(opts.headers ?? {}),
      };
      const init: RequestInit = { method: opts.method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
      if (opts.body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }

      const started = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(url, init);
      } catch (e) {
        const err = e as Error;
        const isTimeout = err.name === "TimeoutError" || err.name === "AbortError";
        if (retryable && attempt < this.maxRetries) {
          attempt += 1;
          const wait = this.backoff(attempt);
          log.warn(`${opts.method} ${safeUrl(url)} ${isTimeout ? "timed out" : "failed"}; retry ${attempt}/${this.maxRetries} in ${wait}ms`);
          await this.sleep(wait);
          continue;
        }
        throw new ODataError(
          0,
          isTimeout ? `Request timed out after ${this.timeoutMs}ms` : `Network error: ${err.message}`,
          undefined,
          isTimeout ? "Narrow the query with select/filter/top or raise timeoutMs" : "Check the service URL and network access",
        );
      }

      log.debug(`${opts.method} ${safeUrl(url)} → ${res.status} (${Date.now() - started}ms)`);

      if (res.ok) {
        if (res.status === 204 || mode === "text") {
          return { status: res.status, data: mode === "text" ? await res.text() : null, headers: res.headers };
        }
        const text = await res.text();
        return { status: res.status, data: text.length ? safeJson(text) : null, headers: res.headers };
      }

      const shouldRetry = retryable && attempt < this.maxRetries && (res.status === 429 || res.status >= 500);
      if (shouldRetry) {
        attempt += 1;
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        const wait = retryAfter ?? this.backoff(attempt);
        log.warn(`${opts.method} ${safeUrl(url)} → ${res.status}; retry ${attempt}/${this.maxRetries} in ${wait}ms`);
        await this.sleep(wait);
        continue;
      }

      throw await toODataError(res);
    }
  }

  private backoff(attempt: number): number {
    const base = this.backoffMs * 2 ** (attempt - 1);
    return Math.min(10_000, Math.round(base + Math.random() * base * 0.25));
  }
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(10_000, Math.max(0, secs * 1000));
  const date = Date.parse(v);
  if (Number.isFinite(date)) return Math.min(10_000, Math.max(0, date - Date.now()));
  return undefined;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function toODataError(res: Response): Promise<ODataError> {
  let message = `HTTP ${res.status} ${res.statusText}`.trim();
  let code: string | undefined;
  try {
    const text = await res.text();
    if (text) {
      const parsed = safeJson(text) as { error?: { code?: string; message?: string | { value?: string } } } | string;
      if (typeof parsed === "object" && parsed.error) {
        const m = parsed.error.message;
        message = typeof m === "string" ? m : (m?.value ?? message);
        code = parsed.error.code;
      } else if (typeof parsed === "string") {
        message = `${message}: ${parsed.slice(0, 300)}`;
      }
    }
  } catch {
    /* body unreadable; keep the status line */
  }
  const hint = hintForStatus(res.status);
  return new ODataError(res.status, message, code, hint);
}

function hintForStatus(status: number): string | undefined {
  switch (status) {
    case 400:
      return "The service rejected the request. Re-check field names with describe_entity and literal formats.";
    case 401:
      return "Authentication failed. Check the auth configuration (CAP_MCP_AUTH and its credentials).";
    case 403:
      return "Authenticated but not authorised. The user/client lacks the scope or role for this entity.";
    case 404:
      return "Not found. Check the entity set name (list_entity_sets) and the key value.";
    case 405:
      return "Method not allowed. The entity may be read-only; check capabilities via describe_entity.";
    case 412:
      return "Precondition failed: the record changed since it was read (ETag mismatch).";
    case 429:
      return "Rate limited by the service.";
    default:
      return status >= 500 ? "The service failed internally. Retry later or narrow the query." : undefined;
  }
}

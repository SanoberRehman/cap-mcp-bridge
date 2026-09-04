/**
 * Configuration: CLI flags > environment (CAP_MCP_*) > cap-mcp.config.json > defaults.
 * Validated with zod so a typo fails at startup with a readable message, not at the first tool call.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ConfigError } from "../util/errors.js";

const AuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("basic"), username: z.string().min(1), password: z.string() }),
  z.object({ kind: z.literal("bearer"), token: z.string().min(1) }),
  z.object({
    kind: z.literal("oauth2-cc"),
    tokenUrl: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scope: z.string().optional(),
  }),
]);

export const ConfigSchema = z.object({
  /** OData v4 service root, e.g. http://localhost:4004/odata/v4/catalog */
  url: z.string().url(),
  auth: AuthSchema.default({ kind: "none" }),
  transport: z.enum(["stdio", "http"]).default("stdio"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3333),
  toolMode: z.enum(["generic", "per-entity", "auto"]).default("auto"),
  /** In `auto`, per-entity tools are generated when the service has at most this many entity sets. */
  perEntityThreshold: z.number().int().min(1).default(12),
  writeEnabled: z.boolean().default(false),
  defaultTop: z.number().int().min(1).default(25),
  maxTop: z.number().int().min(1).default(200),
  maxResponseBytes: z.number().int().min(1024).default(50_000),
  entityAllow: z.array(z.string()).optional(),
  entityDeny: z.array(z.string()).optional(),
  redactFields: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(100).default(30_000),
  maxRetries: z.number().int().min(0).max(10).default(3),
  metadataTtlMs: z.number().int().min(0).default(15 * 60 * 1000),
  extraHeaders: z.record(z.string(), z.string()).default({}),
  logLevel: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export type BridgeConfig = z.infer<typeof ConfigSchema>;
export type BridgeConfigInput = z.input<typeof ConfigSchema>;
export type AuthConfig = BridgeConfig["auth"];

/** Loosely typed overrides coming from CLI flags. Undefined values are ignored. */
export interface CliOverrides {
  url?: string;
  transport?: string;
  host?: string;
  port?: number;
  toolMode?: string;
  writeEnabled?: boolean;
  logLevel?: string;
  auth?: string;
  username?: string;
  password?: string;
  token?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  serviceKeyFile?: string;
  configFile?: string;
}

export function loadConfig(cli: CliOverrides = {}, env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const fromFile = readConfigFile(cli.configFile ?? env["CAP_MCP_CONFIG"]);
  const fromEnv = readEnv(env);
  const fromCli = cliToInput(cli);

  const merged: Record<string, unknown> = { ...fromFile, ...fromEnv, ...fromCli };
  // Auth is merged as one block: the highest-precedence source that names a `kind` wins outright.
  merged["auth"] = fromCli["auth"] ?? fromEnv["auth"] ?? fromFile["auth"] ?? { kind: "none" };

  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`, "Run with --help for the list of flags and CAP_MCP_* variables");
  }
  if (parsed.data.defaultTop > parsed.data.maxTop) {
    throw new ConfigError(`defaultTop (${parsed.data.defaultTop}) cannot exceed maxTop (${parsed.data.maxTop})`);
  }
  return parsed.data;
}

function readConfigFile(path: string | undefined): Record<string, unknown> {
  const candidate = path ?? "cap-mcp.config.json";
  const abs = resolve(process.cwd(), candidate);
  if (!existsSync(abs)) {
    if (path) throw new ConfigError(`Config file not found: ${abs}`);
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError(`Config file ${abs} must contain a JSON object`);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`Could not read config file ${abs}: ${(e as Error).message}`);
  }
}

function readEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const str = (key: string): string | undefined => {
    const v = env[`CAP_MCP_${key}`];
    return v === undefined || v === "" ? undefined : v;
  };
  const num = (key: string): number | undefined => {
    const v = str(key);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new ConfigError(`CAP_MCP_${key} must be a number, got "${v}"`);
    return n;
  };
  const bool = (key: string): boolean | undefined => {
    const v = str(key);
    if (v === undefined) return undefined;
    return ["1", "true", "yes", "on"].includes(v.toLowerCase());
  };
  const list = (key: string): string[] | undefined => {
    const v = str(key);
    return v === undefined ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean);
  };

  set(out, "url", str("URL"));
  set(out, "transport", str("TRANSPORT"));
  set(out, "host", str("HOST"));
  set(out, "port", num("PORT"));
  set(out, "toolMode", str("TOOL_MODE"));
  set(out, "perEntityThreshold", num("PER_ENTITY_THRESHOLD"));
  set(out, "writeEnabled", bool("WRITE_ENABLED"));
  set(out, "defaultTop", num("DEFAULT_TOP"));
  set(out, "maxTop", num("MAX_TOP"));
  set(out, "maxResponseBytes", num("MAX_RESPONSE_BYTES"));
  set(out, "entityAllow", list("ENTITY_ALLOW"));
  set(out, "entityDeny", list("ENTITY_DENY"));
  set(out, "redactFields", list("REDACT_FIELDS"));
  set(out, "timeoutMs", num("TIMEOUT_MS"));
  set(out, "maxRetries", num("MAX_RETRIES"));
  set(out, "metadataTtlMs", num("METADATA_TTL_MS"));
  set(out, "logLevel", str("LOG_LEVEL"));

  const auth = buildAuth({
    kind: str("AUTH"),
    username: str("USERNAME"),
    password: str("PASSWORD"),
    token: str("TOKEN"),
    tokenUrl: str("TOKEN_URL"),
    clientId: str("CLIENT_ID"),
    clientSecret: str("CLIENT_SECRET"),
    scope: str("SCOPE"),
    serviceKeyFile: str("SERVICE_KEY_FILE"),
  });
  if (auth) out["auth"] = auth;
  return out;
}

function cliToInput(cli: CliOverrides): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  set(out, "url", cli.url);
  set(out, "transport", cli.transport);
  set(out, "host", cli.host);
  set(out, "port", cli.port);
  set(out, "toolMode", cli.toolMode);
  set(out, "writeEnabled", cli.writeEnabled);
  set(out, "logLevel", cli.logLevel);
  const auth = buildAuth({
    kind: cli.auth,
    username: cli.username,
    password: cli.password,
    token: cli.token,
    tokenUrl: cli.tokenUrl,
    clientId: cli.clientId,
    clientSecret: cli.clientSecret,
    scope: cli.scope,
    serviceKeyFile: cli.serviceKeyFile,
  });
  if (auth) out["auth"] = auth;
  return out;
}

interface AuthBits {
  kind?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  token?: string | undefined;
  tokenUrl?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  scope?: string | undefined;
  serviceKeyFile?: string | undefined;
}

/**
 * Build an auth block from flat inputs. The kind can be explicit, or inferred from which
 * credentials were supplied (a token implies bearer, a client id implies oauth2-cc, a username
 * implies basic). A BTP service key file fills in the oauth2-cc fields.
 */
function buildAuth(bits: AuthBits): Record<string, unknown> | undefined {
  let { tokenUrl, clientId, clientSecret } = bits;
  if (bits.serviceKeyFile) {
    const key = readServiceKey(bits.serviceKeyFile);
    tokenUrl = tokenUrl ?? key.tokenUrl;
    clientId = clientId ?? key.clientId;
    clientSecret = clientSecret ?? key.clientSecret;
  }
  const kind =
    bits.kind ??
    (bits.token ? "bearer" : clientId || tokenUrl ? "oauth2-cc" : bits.username !== undefined ? "basic" : undefined);
  if (!kind) return undefined;

  switch (kind) {
    case "none":
      return { kind };
    case "basic":
      return { kind, username: bits.username, password: bits.password ?? "" };
    case "bearer":
      return { kind, token: bits.token };
    case "oauth2-cc":
      return { kind, tokenUrl, clientId, clientSecret, ...(bits.scope ? { scope: bits.scope } : {}) };
    default:
      throw new ConfigError(`Unknown auth kind "${kind}"`, "Valid kinds: none, basic, bearer, oauth2-cc");
  }
}

/** XSUAA service key (as downloaded from BTP cockpit or `cf service-key`). */
function readServiceKey(path: string): { tokenUrl: string; clientId: string; clientSecret: string } {
  const abs = resolve(process.cwd(), path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new ConfigError(`Could not read service key ${abs}: ${(e as Error).message}`);
  }
  const root = raw as Record<string, unknown>;
  const uaa = (root["uaa"] as Record<string, unknown> | undefined) ?? root;
  const url = uaa["url"];
  const clientid = uaa["clientid"];
  const clientsecret = uaa["clientsecret"];
  if (typeof url !== "string" || typeof clientid !== "string" || typeof clientsecret !== "string") {
    throw new ConfigError(`Service key ${abs} is missing url / clientid / clientsecret (looked at top level and under "uaa")`);
  }
  return { tokenUrl: `${url.replace(/\/+$/, "")}/oauth/token`, clientId: clientid, clientSecret: clientsecret };
}

function set(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) target[key] = value;
}

/** Config with secrets blanked, safe to log. */
export function redactConfig(config: BridgeConfig): Record<string, unknown> {
  const auth: Record<string, unknown> = { kind: config.auth.kind };
  if (config.auth.kind === "basic") auth["username"] = config.auth.username;
  if (config.auth.kind === "oauth2-cc") {
    auth["tokenUrl"] = config.auth.tokenUrl;
    auth["clientId"] = config.auth.clientId;
  }
  return { ...config, auth, extraHeaders: Object.keys(config.extraHeaders) };
}

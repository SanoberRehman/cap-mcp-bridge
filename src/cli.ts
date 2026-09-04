#!/usr/bin/env node
/**
 * cap-mcp-bridge CLI.
 *
 *   npx cap-mcp-bridge --url https://services.odata.org/V4/Northwind/Northwind.svc
 *   npx cap-mcp-bridge --url http://localhost:4004/odata/v4/catalog --print-model
 */

import { parseArgs } from "node:util";
import { createRequire } from "node:module";
import { loadConfig } from "./server/config.js";
import type { CliOverrides } from "./server/config.js";
import { createBridgeContext } from "./server/context.js";
import { printModelTree } from "./metadata/print.js";
import { startServer } from "./server/index.js";
import { log, setLogLevel } from "./util/log.js";
import { BridgeError } from "./util/errors.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const HELP = `cap-mcp-bridge ${pkg.version}
Expose any SAP CAP / OData v4 service to an LLM as MCP tools, driven by its $metadata.

Usage:
  cap-mcp-bridge --url <service-root> [options]

Options:
  --url <url>              OData v4 service root (env CAP_MCP_URL)
  --config <path>          JSON config file (default ./cap-mcp.config.json, env CAP_MCP_CONFIG)
  --transport stdio|http   Transport (default stdio, env CAP_MCP_TRANSPORT)
  --port <n>               HTTP port (default 3333, env CAP_MCP_PORT)
  --host <host>            HTTP bind host (default 127.0.0.1, env CAP_MCP_HOST)
  --tool-mode <mode>       generic | per-entity | auto (default auto, env CAP_MCP_TOOL_MODE)
  --write                  Enable write tools (env CAP_MCP_WRITE_ENABLED=true)
  --auth <kind>            none | basic | bearer | oauth2-cc (env CAP_MCP_AUTH)
  --username / --password  Basic auth (env CAP_MCP_USERNAME / CAP_MCP_PASSWORD)
  --token <jwt>            Bearer token pass-through (env CAP_MCP_TOKEN)
  --token-url <url>        OAuth2 token endpoint (env CAP_MCP_TOKEN_URL)
  --client-id / --client-secret
                           OAuth2 client credentials (env CAP_MCP_CLIENT_ID / CAP_MCP_CLIENT_SECRET)
  --service-key <path>     XSUAA service key JSON; fills token-url/client-id/secret (env CAP_MCP_SERVICE_KEY_FILE)
  --print-model            Fetch $metadata, print the parsed ServiceModel as a tree, exit
  --log-level <level>      debug | info | warn | error | silent (env CAP_MCP_LOG_LEVEL)
  --version                Print version
  --help                   Show this help

Everything else (allow/deny lists, redaction, paging limits, timeouts) lives in cap-mcp.config.json
or CAP_MCP_* variables. See README.md.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      url: { type: "string" },
      config: { type: "string" },
      transport: { type: "string" },
      port: { type: "string" },
      host: { type: "string" },
      "tool-mode": { type: "string" },
      write: { type: "boolean" },
      auth: { type: "string" },
      username: { type: "string" },
      password: { type: "string" },
      token: { type: "string" },
      "token-url": { type: "string" },
      "client-id": { type: "string" },
      "client-secret": { type: "string" },
      scope: { type: "string" },
      "service-key": { type: "string" },
      "print-model": { type: "boolean" },
      "log-level": { type: "string" },
      version: { type: "boolean" },
      help: { type: "boolean" },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(pkg.version);
    return;
  }

  const overrides: CliOverrides = {};
  if (values.url !== undefined) overrides.url = values.url;
  if (values.config !== undefined) overrides.configFile = values.config;
  if (values.transport !== undefined) overrides.transport = values.transport;
  if (values.port !== undefined) overrides.port = Number(values.port);
  if (values.host !== undefined) overrides.host = values.host;
  if (values["tool-mode"] !== undefined) overrides.toolMode = values["tool-mode"];
  if (values.write !== undefined) overrides.writeEnabled = values.write;
  if (values.auth !== undefined) overrides.auth = values.auth;
  if (values.username !== undefined) overrides.username = values.username;
  if (values.password !== undefined) overrides.password = values.password;
  if (values.token !== undefined) overrides.token = values.token;
  if (values["token-url"] !== undefined) overrides.tokenUrl = values["token-url"];
  if (values["client-id"] !== undefined) overrides.clientId = values["client-id"];
  if (values["client-secret"] !== undefined) overrides.clientSecret = values["client-secret"];
  if (values.scope !== undefined) overrides.scope = values.scope;
  if (values["service-key"] !== undefined) overrides.serviceKeyFile = values["service-key"];
  if (values["log-level"] !== undefined) overrides.logLevel = values["log-level"];

  const config = loadConfig(overrides);
  setLogLevel(config.logLevel);

  if (values["print-model"]) {
    const ctx = createBridgeContext(config);
    const model = await ctx.metadata.get();
    console.log(printModelTree(model));
    return;
  }

  await startServer(config);
}

main().catch((err: unknown) => {
  if (err instanceof BridgeError) {
    log.error(err.message, err.hint ? { hint: err.hint } : undefined);
  } else {
    log.error((err as Error).stack ?? String(err));
  }
  process.exit(1);
});

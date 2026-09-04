import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BridgeContext } from "./context.js";
import { createToolContext } from "../tools/context.js";
import type { ToolContext } from "../tools/context.js";
import { registerBridge } from "../tools/registry.js";
import type { RegisteredBridge } from "../tools/registry.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export interface BridgeServer {
  server: McpServer;
  bridge: RegisteredBridge;
  tools: ToolContext;
}

/**
 * Build a fully wired McpServer for one bridge context. Called once for stdio and once per
 * session for streamable HTTP; the context (metadata cache, auth, HTTP client) is shared.
 */
export async function createBridgeServer(ctx: BridgeContext, tools: ToolContext = createToolContext(ctx)): Promise<BridgeServer> {
  const server = new McpServer(
    { name: "cap-mcp-bridge", version: pkg.version },
    {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true } },
      instructions:
        `This server exposes the OData v4 service at ${ctx.config.url}. ` +
        `Start with list_entity_sets (or read cap://service), then describe_entity for field names before filtering. ` +
        `Prefer the structured filter form. Results are paged and may be truncated; follow nextSkip.` +
        (ctx.config.writeEnabled ? " Write tools are enabled: confirm with the user before creating, updating or deleting." : " This bridge is read-only."),
    },
  );
  const bridge = await registerBridge(server, tools);
  return { server, bridge, tools };
}

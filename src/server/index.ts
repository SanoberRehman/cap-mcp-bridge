import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { BridgeConfig } from "./config.js";
import { redactConfig } from "./config.js";
import { createBridgeContext } from "./context.js";
import { startHttpServer } from "./http.js";
import { createBridgeServer } from "./mcp.js";
import { log } from "../util/log.js";

export { createBridgeServer } from "./mcp.js";
export { startHttpServer } from "./http.js";
export { createBridgeContext } from "./context.js";

/** Entry point used by the CLI: pick the transport from config and run until the process exits. */
export async function startServer(config: BridgeConfig): Promise<void> {
  const ctx = createBridgeContext(config);
  log.info("starting", redactConfig(config));

  if (config.transport === "http") {
    const http = await startHttpServer(ctx);
    const shutdown = (): void => {
      http.close().finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }

  const { server, bridge } = await createBridgeServer(ctx);
  log.info(`stdio transport ready (${bridge.mode} mode, ${bridge.toolNames().length} tools)`);
  await server.connect(new StdioServerTransport());
}

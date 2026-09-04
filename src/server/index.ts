import type { BridgeConfig } from "./config.js";

/** Placeholder until the MCP wiring lands in the tool-generation milestone. */
export async function startServer(_config: BridgeConfig): Promise<void> {
  throw new Error("MCP server transport not implemented yet; use --print-model for now");
}

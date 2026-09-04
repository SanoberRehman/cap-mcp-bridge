/**
 * Programmatic API. Most users want the CLI; this is for embedding the bridge in another process.
 */

export { loadConfig, ConfigSchema } from "./server/config.js";
export type { BridgeConfig, BridgeConfigInput } from "./server/config.js";
export { createBridgeContext } from "./server/context.js";
export type { BridgeContext } from "./server/context.js";
export { createBridgeServer, startServer, startHttpServer } from "./server/index.js";
export { createToolContext } from "./tools/context.js";
export * from "./metadata/index.js";
export { buildQuery, buildFilterString } from "./odata/query.js";
export { parseFilter } from "./odata/filter/parse.js";
export { StructuredFilterSchema } from "./odata/filter/structured.js";
export type { StructuredFilter } from "./odata/filter/structured.js";
export { BridgeError, ValidationError, ODataError, ConfigError } from "./util/errors.js";

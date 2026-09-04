import type { ODataHttpClient } from "../odata/http.js";
import { MetadataCache } from "./cache.js";
import { parseEdmx } from "./parse.js";
import type { ServiceModel } from "./model.js";

export * from "./model.js";
export * from "./types.js";
export { parseEdmx } from "./parse.js";
export { printModelTree } from "./print.js";
export { MetadataCache } from "./cache.js";

/** Fetch `$metadata` through the client and parse it. */
export async function loadServiceModel(client: ODataHttpClient): Promise<ServiceModel> {
  const xml = await client.fetchMetadata();
  return parseEdmx(xml, client.baseUrl);
}

export function createMetadataCache(client: ODataHttpClient, ttlMs?: number): MetadataCache {
  return new MetadataCache(() => loadServiceModel(client), ttlMs !== undefined ? { ttlMs } : {});
}

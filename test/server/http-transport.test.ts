/**
 * Streamable HTTP transport: a real SDK client talks to the bridge over HTTP, sessions are
 * tracked, and two clients share one metadata fetch.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { loadConfig } from "../../src/server/config.js";
import { createBridgeContext } from "../../src/server/context.js";
import { startHttpServer } from "../../src/server/http.js";
import type { HttpBridge } from "../../src/server/http.js";
import { startFakeOData } from "./fake-services.js";
import type { FakeOData } from "./fake-services.js";

describe("streamable HTTP transport", () => {
  let svc: FakeOData;
  let http: HttpBridge;
  let base: string;

  beforeAll(async () => {
    svc = await startFakeOData(() => true);
    const config = loadConfig({}, { CAP_MCP_URL: svc.url, CAP_MCP_TRANSPORT: "http", CAP_MCP_PORT: "0", CAP_MCP_LOG_LEVEL: "silent" });
    http = await startHttpServer(createBridgeContext(config));
    const addr = http.server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    await http.close();
    await svc.close();
  });

  async function connect(): Promise<Client> {
    const client = new Client({ name: "http-test", version: "0" });
    // Cast: the SDK's Transport interface clashes with exactOptionalPropertyTypes (see src/server/http.ts).
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)) as unknown as Transport);
    return client;
  }

  it("serves a health endpoint", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: svc.url });
  });

  it("lists tools and answers a query over HTTP", async () => {
    const client = await connect();
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("query_Books");
    const res = await client.callTool({ name: "query_Books", arguments: { select: ["title"] } });
    const text = (res.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toMatchObject({ entitySet: "Books", count: 2 });
    await client.close();
  });

  it("gives each client its own session while sharing one metadata fetch", async () => {
    const metadataFetches = () => svc.requests.filter((r) => r.path.endsWith("/$metadata")).length;
    const before = metadataFetches();
    const a = await connect();
    const b = await connect();
    expect((await fetch(`${base}/healthz`).then((r) => r.json() as Promise<{ sessions: number }>)).sessions).toBeGreaterThanOrEqual(2);
    await a.listTools();
    await b.listTools();
    expect(metadataFetches()).toBe(before);
    await a.close();
    await b.close();
  });

  it("rejects requests without a session that are not initialize", async () => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown paths", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

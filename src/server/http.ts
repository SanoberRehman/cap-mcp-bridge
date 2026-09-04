/**
 * Streamable HTTP transport on Node's http module. One McpServer per MCP session, all sharing the
 * bridge context, so metadata is fetched once regardless of how many clients connect.
 *
 *   POST /mcp      JSON-RPC (initialize creates a session; Mcp-Session-Id header thereafter)
 *   GET  /mcp      server→client SSE stream for an existing session
 *   DELETE /mcp    end a session
 *   GET  /healthz  liveness
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { BridgeContext } from "./context.js";
import { createBridgeServer } from "./mcp.js";
import { createToolContext } from "../tools/context.js";
import { log } from "../util/log.js";

interface Session {
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}

export interface HttpBridge {
  server: Server;
  close(): Promise<void>;
}

export async function startHttpServer(ctx: BridgeContext): Promise<HttpBridge> {
  const tools = createToolContext(ctx);
  const sessions = new Map<string, Session>();

  // Fail fast if the service is unreachable, before accepting connections.
  await ctx.metadata.get();

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, sessions: sessions.size, service: ctx.config.url }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "not found; use /mcp" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (req.method === "POST") {
      const body = await readJson(req);
      if (existing) {
        await existing.transport.handleRequest(req, res, body);
        return;
      }
      if (typeof sessionId === "string" && !existing) {
        res.writeHead(404, { "content-type": "application/json" }).end(jsonRpcError("Unknown or expired session"));
        return;
      }
      if (!isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" }).end(jsonRpcError("Missing Mcp-Session-Id; send an initialize request first"));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, close: () => bridgeServer.server.close() });
          log.info(`session opened ${id} (${sessions.size} active)`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          log.info(`session closed ${id} (${sessions.size} active)`);
        },
      });
      const bridgeServer = await createBridgeServer(ctx, tools);
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      // The SDK's Transport type declares optional handlers without `| undefined`, which clashes with
      // exactOptionalPropertyTypes; the transport implements the interface at runtime.
      await bridgeServer.server.connect(transport as unknown as Transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      if (!existing) {
        res.writeHead(400, { "content-type": "application/json" }).end(jsonRpcError("Missing or unknown Mcp-Session-Id"));
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405).end();
  };

  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      log.error(`http handler error: ${(err as Error).message}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(jsonRpcError("Internal error"));
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ctx.config.port, ctx.config.host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : ctx.config.port;
  log.info(`streamable HTTP listening on http://${ctx.config.host}:${port}/mcp`);

  return {
    server,
    close: async () => {
      for (const s of sessions.values()) {
        await s.transport.close().catch(() => undefined);
        await s.close().catch(() => undefined);
      }
      sessions.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function jsonRpcError(message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

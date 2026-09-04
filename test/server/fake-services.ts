/**
 * Real HTTP stand-ins for an XSUAA token endpoint and a protected OData service, so the auth
 * providers and the HTTP client are exercised over the wire rather than through a fetch stub.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { fixture } from "../helpers.js";

export interface FakeIdp {
  url: string;
  tokenUrl: string;
  issued: number;
  close(): Promise<void>;
}

export async function startFakeIdp(clientId: string, clientSecret: string): Promise<FakeIdp> {
  const state = { issued: 0 };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/oauth/token") {
      res.writeHead(404).end();
      return;
    }
    const expected = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "invalid_client" }));
      return;
    }
    const body = await readBody(req);
    if (!body.includes("grant_type=client_credentials")) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "unsupported_grant_type" }));
      return;
    }
    state.issued += 1;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: `tok-${state.issued}`, token_type: "bearer", expires_in: 3600 }));
  });
  const url = await listen(server);
  return {
    url,
    tokenUrl: `${url}/oauth/token`,
    get issued() {
      return state.issued;
    },
    close: () => closeServer(server),
  };
}

export interface FakeOData {
  url: string;
  requests: Array<{ path: string; authorization: string | undefined }>;
  close(): Promise<void>;
}

export type Guard = (req: IncomingMessage) => boolean;

/** A tiny OData service serving the bookshop metadata, guarded by whatever `authorized` says. */
export async function startFakeOData(authorized: Guard): Promise<FakeOData> {
  const requests: FakeOData["requests"] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    requests.push({ path: url.pathname, authorization: req.headers.authorization });
    if (!authorized(req)) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" }).end(JSON.stringify({ error: { code: "401", message: "Unauthorized" } }));
      return;
    }
    if (url.pathname.endsWith("/$metadata")) {
      res.writeHead(200, { "content-type": "application/xml" }).end(fixture("bookshop.xml"));
      return;
    }
    if (url.pathname.endsWith("/$count")) {
      res.writeHead(200, { "content-type": "text/plain" }).end("2");
      return;
    }
    if (url.pathname.endsWith("/Books")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ "@odata.count": 2, value: [{ ID: "6b1a0a2e-0003-4000-8000-000000000001", title: "Wuthering Heights", price: "11.11" }, { ID: "6b1a0a2e-0003-4000-8000-000000000002", title: "Jane Eyre", price: "12.34" }] }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "404", message: `no route ${url.pathname}` } }));
  });
  const url = await listen(server);
  return { url: `${url}/odata/v4/catalog`, requests, close: () => closeServer(server) };
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

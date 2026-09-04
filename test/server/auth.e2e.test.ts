/**
 * Auth strategies over real HTTP: the same bridge code connects to a protected service using
 * client credentials, basic auth, a pass-through bearer token, or nothing, with only config changing.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { createBridgeContext } from "../../src/server/context.js";
import { createToolContext } from "../../src/tools/context.js";
import { queryEntity } from "../../src/tools/handlers.js";
import { startFakeIdp, startFakeOData } from "./fake-services.js";
import type { FakeIdp, FakeOData } from "./fake-services.js";

const CLIENT_ID = "sb-cap-mcp!t1";
const CLIENT_SECRET = "very-secret";

describe("auth end-to-end", () => {
  let idp: FakeIdp;
  let protectedSvc: FakeOData;
  let basicSvc: FakeOData;
  let openSvc: FakeOData;

  beforeAll(async () => {
    idp = await startFakeIdp(CLIENT_ID, CLIENT_SECRET);
    protectedSvc = await startFakeOData((req) => /^Bearer tok-\d+$/.test(req.headers.authorization ?? ""));
    basicSvc = await startFakeOData((req) => req.headers.authorization === `Basic ${Buffer.from("alice:pw").toString("base64")}`);
    openSvc = await startFakeOData(() => true);
  });

  afterAll(async () => {
    await Promise.all([idp.close(), protectedSvc.close(), basicSvc.close(), openSvc.close()]);
  });

  async function query(env: Record<string, string>): Promise<{ count: number | null; requests: FakeOData["requests"] }> {
    const config = loadConfig({}, env);
    const ctx = createBridgeContext(config);
    const tc = createToolContext(ctx);
    const res = await queryEntity(tc, { entitySet: "Books" });
    return { count: res.count, requests: [] };
  }

  it("oauth2-cc: fetches a token once and reuses it across metadata and data calls", async () => {
    const before = idp.issued;
    const res = await query({
      CAP_MCP_URL: protectedSvc.url,
      CAP_MCP_AUTH: "oauth2-cc",
      CAP_MCP_TOKEN_URL: idp.tokenUrl,
      CAP_MCP_CLIENT_ID: CLIENT_ID,
      CAP_MCP_CLIENT_SECRET: CLIENT_SECRET,
    });
    expect(res.count).toBe(2);
    expect(idp.issued - before).toBe(1);
    const last = protectedSvc.requests.at(-1);
    expect(last?.authorization).toMatch(/^Bearer tok-/);
  });

  it("oauth2-cc: reads the token endpoint and credentials from a BTP service key file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-mcp-"));
    const keyFile = join(dir, "service-key.json");
    writeFileSync(keyFile, JSON.stringify({ uaa: { url: idp.url, clientid: CLIENT_ID, clientsecret: CLIENT_SECRET, xsappname: "cap-mcp" } }));
    const res = await query({ CAP_MCP_URL: protectedSvc.url, CAP_MCP_SERVICE_KEY_FILE: keyFile });
    expect(res.count).toBe(2);
  });

  it("oauth2-cc: wrong secret surfaces as a structured error with a hint, without leaking the secret", async () => {
    await expect(
      query({
        CAP_MCP_URL: protectedSvc.url,
        CAP_MCP_AUTH: "oauth2-cc",
        CAP_MCP_TOKEN_URL: idp.tokenUrl,
        CAP_MCP_CLIENT_ID: CLIENT_ID,
        CAP_MCP_CLIENT_SECRET: "wrong",
      }),
    ).rejects.toMatchObject({ status: 401, message: expect.not.stringContaining("wrong"), hint: expect.stringMatching(/client id/) });
  });

  it("basic: username and password from env", async () => {
    const res = await query({ CAP_MCP_URL: basicSvc.url, CAP_MCP_AUTH: "basic", CAP_MCP_USERNAME: "alice", CAP_MCP_PASSWORD: "pw" });
    expect(res.count).toBe(2);
  });

  it("bearer: a caller-supplied token is passed through untouched", async () => {
    const res = await query({ CAP_MCP_URL: protectedSvc.url, CAP_MCP_TOKEN: "tok-999" });
    expect(res.count).toBe(2);
    expect(protectedSvc.requests.at(-1)?.authorization).toBe("Bearer tok-999");
  });

  it("none: works against an open service and fails clearly against a protected one", async () => {
    const res = await query({ CAP_MCP_URL: openSvc.url });
    expect(res.count).toBe(2);
    expect(openSvc.requests.at(-1)?.authorization).toBeUndefined();

    await expect(query({ CAP_MCP_URL: protectedSvc.url })).rejects.toMatchObject({
      status: 401,
      hint: expect.stringMatching(/CAP_MCP_AUTH/),
    });
  });

  it("refuses an incomplete oauth2-cc configuration at startup", () => {
    expect(() => loadConfig({}, { CAP_MCP_URL: protectedSvc.url, CAP_MCP_AUTH: "oauth2-cc", CAP_MCP_CLIENT_ID: CLIENT_ID })).toThrow(/Invalid configuration/);
  });
});

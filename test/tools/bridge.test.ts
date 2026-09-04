/**
 * End-to-end through the MCP protocol: a real McpServer and Client joined by an in-memory
 * transport, with `fetch` replaced by a stub that serves the fixture metadata and canned data.
 */

import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/server/config.js";
import type { CliOverrides } from "../../src/server/config.js";
import { createBridgeContext } from "../../src/server/context.js";
import { createBridgeServer } from "../../src/server/mcp.js";
import { fixture } from "../helpers.js";

interface Call {
  url: string;
  method: string;
  body?: unknown;
}

interface Harness {
  client: Client;
  calls: Call[];
  toolNames(): Promise<string[]>;
  call(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; json: Record<string, unknown> }>;
  close(): Promise<void>;
}

const BOOK = { ID: "6b1a0a2e-0003-4000-8000-000000000001", title: "Wuthering Heights", price: "11.11", stock: 12 };
const AUTHOR = { ID: "6b1a0a2e-0001-4000-8000-000000000001", name: "Emily Brontë", email: "emily@example.com" };

/** Route stubbed HTTP calls by path. */
function serviceStub(metadataFile: string): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const call: Call = { url, method };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body);
    calls.push(call);
    const path = new URL(url).pathname;
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (path.endsWith("/$metadata")) return new Response(fixture(metadataFile), { status: 200, headers: { "content-type": "application/xml" } });
    if (path.endsWith("/$count")) return new Response("5", { status: 200, headers: { "content-type": "text/plain" } });
    if (/\/Books\([^)]+\)$/.test(path)) return json({ "@odata.context": "$metadata#Books/$entity", ...BOOK, author: AUTHOR });
    if (path.endsWith("/Books") && method === "POST") return json({ ...BOOK, ...(call.body as object) }, 201);
    if (path.endsWith("/Books")) return json({ "@odata.count": 5, value: [{ ...BOOK, author: AUTHOR }] });
    if (path.endsWith("/Authors")) return json({ "@odata.count": 1, value: [AUTHOR] });
    if (path.endsWith("/Orders")) return json({ "@odata.count": 2, value: [{ ID: "o1", customer: "Ada", customerEmail: "ada@example.com", IsActiveEntity: true }] });
    if (/\/topBooks\(/.test(path)) return json({ value: [BOOK] });
    if (/\/Customers$/.test(path)) {
      return json({ "@odata.count": 91, value: Array.from({ length: 25 }, (_, i) => ({ CustomerID: `C${i}`, CompanyName: "x".repeat(200), Phone: "030-123" })) });
    }
    if (/restock$/.test(path)) return json({ ...BOOK, stock: 99 });
    return json({ error: { code: "404", message: `stub has no route for ${path}` } }, 404);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

async function harness(metadataFile: string, overrides: Partial<CliOverrides> & { env?: Record<string, string> } = {}): Promise<Harness> {
  const { env, ...cli } = overrides;
  const config = loadConfig({ url: "http://svc/odata/v4/catalog", ...cli }, { ...env });
  const stub = serviceStub(metadataFile);
  const ctx = createBridgeContext(config, stub.fetch);
  const { server } = await createBridgeServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  return {
    client,
    calls: stub.calls,
    toolNames: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    call: async (name, args) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "{}";
      return { isError: Boolean(res.isError), json: JSON.parse(text) as Record<string, unknown> };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("tool generation modes", () => {
  it("Northwind (26 entity sets) gets the generic tool set, read-only by default", async () => {
    const h = await harness("northwind.xml");
    expect(await h.toolNames()).toEqual(["describe_entity", "get_entity", "invoke_function", "list_entity_sets", "query_entity", "refresh_metadata"]);
    await h.close();
  });

  it("Northwind with writes enabled adds the four write tools", async () => {
    const h = await harness("northwind.xml", { writeEnabled: true });
    expect(await h.toolNames()).toEqual([
      "create_entity",
      "delete_entity",
      "describe_entity",
      "get_entity",
      "invoke_action",
      "invoke_function",
      "list_entity_sets",
      "query_entity",
      "refresh_metadata",
      "update_entity",
    ]);
    await h.close();
  });

  it("the bookshop (8 entity sets) gets typed per-entity tools", async () => {
    const h = await harness("bookshop.xml");
    const names = await h.toolNames();
    expect(names).toContain("query_Books");
    expect(names).toContain("get_Orders");
    expect(names).toContain("query_Currencies_texts");
    expect(names).not.toContain("query_entity");
    expect(names).not.toContain("create_Books");
    await h.close();
  });

  it("per-entity write tools respect Capabilities (no delete_Books, no create_Genres)", async () => {
    const h = await harness("bookshop.xml", { writeEnabled: true });
    const names = await h.toolNames();
    expect(names).toContain("create_Books");
    expect(names).toContain("update_Books");
    expect(names).not.toContain("delete_Books");
    expect(names).not.toContain("create_Genres");
    expect(names).not.toContain("update_Genres");
    expect(names).toContain("invoke_action");
    await h.close();
  });

  it("toolMode can force generic tools on a small service", async () => {
    const h = await harness("bookshop.xml", { toolMode: "generic" });
    const names = await h.toolNames();
    expect(names).toContain("query_entity");
    expect(names).not.toContain("query_Books");
    await h.close();
  });

  it("typed tools expose real property names in their schemas and annotation-derived descriptions", async () => {
    const h = await harness("bookshop.xml");
    const tools = (await h.client.listTools()).tools;
    const q = tools.find((t) => t.name === "query_Books");
    expect(q?.description).toMatch(/Books in the catalogue/);
    expect(q?.description).toMatch(/price: Decimal \(string\) "Price"/);
    expect(q?.description).toMatch(/author → Authors/);
    const schema = JSON.stringify(q?.inputSchema);
    expect(schema).toContain('"title"');
    expect(schema).toContain('"publishedAt"');
    const orders = tools.find((t) => t.name === "query_Orders");
    expect(JSON.stringify(orders?.inputSchema)).toContain("includeDrafts");
    expect(JSON.stringify(q?.inputSchema)).not.toContain("includeDrafts");
    await h.close();
  });
});

describe("querying through MCP", () => {
  it("builds the OData URL from a structured filter and shapes the response", async () => {
    const h = await harness("bookshop.xml");
    const res = await h.call("query_Books", { filter: { field: "title", op: "contains", value: "Wuthering" }, select: ["title", "price"], expand: ["author"] });
    expect(res.isError).toBe(false);
    const url = decodeURIComponent(h.calls.at(-1)?.url ?? "");
    expect(url).toContain("/Books?");
    expect(url).toContain("$filter=contains(title,'Wuthering')");
    expect(url).toContain("$select=title,price,ID");
    expect(url).toContain("$expand=author");
    expect(url).toContain("$top=25");
    expect(url).toContain("$count=true");
    expect(res.json["count"]).toBe(5);
    expect(res.json["returned"]).toBe(1);
    const row = (res.json["results"] as Array<Record<string, Record<string, unknown>>>)[0];
    expect(row?.["author"]?.["email"]).toBe("[REDACTED]");
    expect(row?.["author"]?.["name"]).toBe("Emily Brontë");
    await h.close();
  });

  it("returns a structured error for an unknown field and never touches the network", async () => {
    const h = await harness("bookshop.xml");
    const before = h.calls.length;
    const res = await h.call("query_Books", { filter: { field: "titel", op: "eq", value: "x" } });
    expect(res.isError).toBe(true);
    const err = res.json["error"] as Record<string, unknown>;
    expect(err["code"]).toBe("unknown_field");
    expect(err["message"]).toMatch(/"titel" does not exist on Books/);
    expect(err["validOptions"]).toContain("title");
    expect(h.calls.length).toBe(before);
    await h.close();
  });

  it("rejects a non-filterable field with the filterable list, before any request", async () => {
    const h = await harness("northwind.xml");
    const before = h.calls.length;
    const res = await h.call("query_entity", { entitySet: "Categories", filter: "Picture eq 'x'" });
    expect(res.isError).toBe(true);
    expect((res.json["error"] as Record<string, unknown>)["message"]).toMatch(/not filterable on Categories. Filterable fields: CategoryID, CategoryName, Description/);
    expect(h.calls.length).toBe(before);
    await h.close();
  });

  it("filters draft entities to active records by default", async () => {
    const h = await harness("bookshop.xml");
    await h.call("query_Orders", {});
    expect(decodeURIComponent(h.calls.at(-1)?.url ?? "")).toContain("$filter=IsActiveEntity eq true");
    await h.call("query_Orders", { includeDrafts: true });
    expect(decodeURIComponent(h.calls.at(-1)?.url ?? "")).not.toContain("IsActiveEntity");
    await h.close();
  });

  it("gets a record by key, defaulting the draft flag, and strips @odata noise", async () => {
    const h = await harness("bookshop.xml");
    const res = await h.call("get_Books", { key: BOOK.ID, expand: ["author"] });
    expect(res.isError).toBe(false);
    expect(h.calls.at(-1)?.url).toContain(`/Books(${BOOK.ID})?$expand=author`);
    const record = res.json["record"] as Record<string, unknown>;
    expect(record["@odata.context"]).toBeUndefined();
    expect((record["author"] as Record<string, unknown>)["email"]).toBe("[REDACTED]");
    await h.close();
  });

  it("invokes an unbound function with typed inline parameters", async () => {
    const h = await harness("bookshop.xml");
    const res = await h.call("invoke_function", { name: "topBooks", parameters: { n: "3" } });
    expect(res.isError).toBe(false);
    expect(h.calls.at(-1)?.url).toMatch(/\/topBooks\(n=3\)$/);
    expect(Array.isArray(res.json["result"])).toBe(true);
    await h.close();
  });

  it("invokes a bound action with a key and a JSON body", async () => {
    const h = await harness("bookshop.xml", { writeEnabled: true });
    const res = await h.call("invoke_action", { name: "restock", parameters: { amount: 5 }, boundTo: { entitySet: "Books", key: BOOK.ID } });
    expect(res.isError).toBe(false);
    const last = h.calls.at(-1);
    expect(last?.method).toBe("POST");
    expect(last?.url).toContain(`/Books(${BOOK.ID})/CatalogService.restock`);
    expect(last?.body).toEqual({ amount: 5 });
    await h.close();
  });

  it("explains a missing binding for a bound action", async () => {
    const h = await harness("bookshop.xml", { writeEnabled: true });
    const res = await h.call("invoke_action", { name: "restock", parameters: { amount: 5 } });
    expect(res.isError).toBe(true);
    expect((res.json["error"] as Record<string, unknown>)["message"]).toMatch(/bound to Books; pass boundTo/);
    await h.close();
  });

  it("validates create payloads: unknown, read-only and mandatory fields", async () => {
    const h = await harness("bookshop.xml", { writeEnabled: true });
    let res = await h.call("create_Books", { data: { title: "New", createdAt: "2024-01-01T00:00:00Z" } });
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("read_only_field");
    res = await h.call("create_Books", { data: { title: "New", colour: "red" } });
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("unknown_field");
    res = await h.call("create_Books", { data: { descr: "no title" } });
    expect((res.json["error"] as Record<string, unknown>)["message"]).toMatch(/Missing mandatory field for Books: title/);
    res = await h.call("create_Books", { data: { title: "New", price: 12.5, stock: 3 } });
    expect(res.isError).toBe(false);
    expect(h.calls.at(-1)?.body).toEqual({ title: "New", price: "12.5", stock: 3 });
    await h.close();
  });

  it("coerces numeric strings and decimals in generic create payloads", async () => {
    const h = await harness("bookshop.xml", { writeEnabled: true, toolMode: "generic" });
    const res = await h.call("create_entity", { entitySet: "Books", data: { title: "New", price: 12.5, stock: "3" } });
    expect(res.isError).toBe(false);
    expect(h.calls.at(-1)?.body).toEqual({ title: "New", price: "12.5", stock: 3 });
    await h.close();
  });

  it("applies the response size ceiling with an explicit note", async () => {
    const h = await harness("northwind.xml", { env: { CAP_MCP_MAX_RESPONSE_BYTES: "1500" } });
    const res = await h.call("query_entity", { entitySet: "Customers" });
    expect(res.isError).toBe(false);
    expect(res.json["returned"]).toBeLessThan(25);
    expect(res.json["truncated"]).toBe(true);
    expect(res.json["nextSkip"]).toBe(res.json["returned"]);
    expect((res.json["notes"] as string[]).join(" ")).toMatch(/Response truncated/);
    await h.close();
  });

  it("redacts configured field globs anywhere in the response", async () => {
    const h = await harness("northwind.xml", { env: { CAP_MCP_REDACT_FIELDS: "*phone*" } });
    const res = await h.call("query_entity", { entitySet: "Customers", top: 1 });
    const row = (res.json["results"] as Array<Record<string, unknown>>)[0];
    expect(row?.["Phone"]).toBe("[REDACTED]");
    await h.close();
  });
});

describe("entity allow / deny lists", () => {
  it("hides denied entity sets from tools, resources and navigation", async () => {
    const h = await harness("bookshop.xml", { env: { CAP_MCP_ENTITY_DENY: "Currencies*,Reviews" } });
    const names = await h.toolNames();
    expect(names).not.toContain("query_Currencies");
    expect(names).not.toContain("query_Reviews");
    expect(names).toContain("query_Books");
    const res = await h.call("query_Books", { expand: ["currency"] });
    expect(res.isError).toBe(true);
    expect((res.json["error"] as Record<string, unknown>)["code"]).toBe("entity_not_exposed");
    const resources = await h.client.listResources();
    expect(resources.resources.map((r) => r.name)).not.toContain("Reviews");
    await h.close();
  });

  it("allow list restricts to matching sets", async () => {
    const h = await harness("northwind.xml", { env: { CAP_MCP_ENTITY_ALLOW: "Orders,Customers" } });
    const list = await h.call("list_entity_sets", { includeCounts: false });
    expect((list.json["entitySets"] as Array<{ name: string }>).map((s) => s.name)).toEqual(["Customers", "Orders"]);
    await h.close();
  });
});

describe("resources and discovery", () => {
  it("lists every entity schema as cap://entity/{name} and serves it", async () => {
    const h = await harness("bookshop.xml");
    const list = await h.client.listResources();
    const uris = list.resources.map((r) => r.uri);
    expect(uris).toContain("cap://entity/Books");
    expect(uris).toContain("cap://service");
    const read = await h.client.readResource({ uri: "cap://entity/Books" });
    const schema = JSON.parse((read.contents[0] as { text: string }).text) as Record<string, unknown>;
    expect(schema["keys"]).toEqual(["ID"]);
    const props = schema["properties"] as Array<Record<string, unknown>>;
    expect(props.find((p) => p["name"] === "price")).toMatchObject({ type: "string", edmType: "Edm.Decimal", note: expect.stringMatching(/precision/) });
    expect(schema["hints"]).toEqual(expect.arrayContaining([expect.stringMatching(/Decimal fields/)]));
    await h.close();
  });

  it("list_entity_sets includes counts, labels and capability flags", async () => {
    const h = await harness("bookshop.xml");
    const res = await h.call("list_entity_sets", {});
    const sets = res.json["entitySets"] as Array<Record<string, unknown>>;
    const genres = sets.find((s) => s["name"] === "Genres");
    expect(genres?.["recordCount"]).toBe(5);
    expect(genres?.["capabilities"]).toEqual({ insertable: false, updatable: false, deletable: false });
    expect(sets.find((s) => s["name"] === "Orders")?.["draftEnabled"]).toBe(true);
    expect(res.json["functions"]).toEqual(["topBooks"]);
    expect(res.json["actions"]).toEqual(["submitOrder"]);
    await h.close();
  });

  it("describe_entity reports filterable/sortable and sensitive fields", async () => {
    const h = await harness("bookshop.xml");
    const res = await h.call("describe_entity", { entitySet: "Authors" });
    const props = res.json["properties"] as Array<Record<string, unknown>>;
    expect(props.find((p) => p["name"] === "email")?.["sensitive"]).toBe(true);
    expect(res.json["hints"]).toEqual(expect.arrayContaining([expect.stringMatching(/Redacted in responses.*email/)]));
    await h.close();
  });

  it("refresh_metadata re-reads $metadata", async () => {
    const h = await harness("bookshop.xml");
    const metadataCalls = () => h.calls.filter((c) => c.url.endsWith("/$metadata")).length;
    expect(metadataCalls()).toBe(1);
    const res = await h.call("refresh_metadata", {});
    expect(res.isError).toBe(false);
    expect(res.json["entitySets"]).toBe(8);
    expect(metadataCalls()).toBe(2);
    await h.close();
  });
});

/**
 * Live smoke test: spawn the CLI over stdio like an MCP client would, list tools, run a few calls.
 *
 *   npx tsx scripts/smoke.ts http://localhost:4004/odata/v4/catalog
 *   npx tsx scripts/smoke.ts https://services.odata.org/V4/Northwind/Northwind.svc
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const url = process.argv[2];
if (!url) {
  console.error("usage: tsx scripts/smoke.ts <service-url>");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["--import", "tsx", "src/cli.ts", "--url", url, "--log-level", "warn"],
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = (await client.listTools()).tools;
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);

const resources = await client.listResources();
console.log(`resources (${resources.resources.length}): ${resources.resources.slice(0, 5).map((r) => r.uri).join(", ")}${resources.resources.length > 5 ? ", …" : ""}`);

async function show(name: string, args: Record<string, unknown>): Promise<void> {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
  console.log(`\n> ${name} ${JSON.stringify(args)}${res.isError ? "  [error]" : ""}`);
  console.log(text.length > 1500 ? `${text.slice(0, 1500)}\n… (${text.length} chars)` : text);
}

await show("list_entity_sets", { includeCounts: true });

const generic = tools.some((t) => t.name === "query_entity");
if (generic) {
  await show("query_entity", { entitySet: "Orders", filter: { field: "ShipCountry", op: "eq", value: "Germany" }, select: ["OrderID", "ShipCity", "Freight"], expand: ["Customer"], top: 2 });
  await show("query_entity", { entitySet: "Orders", filter: { field: "Freigth", op: "gt", value: 100 } });
} else {
  await show("query_Books", { filter: { field: "price", op: "gt", value: "12" }, select: ["title", "price"], expand: ["author"], orderBy: [{ field: "price", dir: "desc" }] });
  await show("query_Books", { filter: "titel eq 'x'" });
  await show("query_Orders", { select: ["orderNo", "customer", "customerEmail", "total"] });
  await show("invoke_function", { name: "topBooks", parameters: { n: 2 } });
}

await client.close();
